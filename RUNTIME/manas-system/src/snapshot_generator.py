"""
住相 (Snapshot) 生成器。

设计 (docs/snapshot-sop.md):
- Mode A (per-turn full LLM regen, ~1.5s, 50-150 token)
- Mode B (3 consecutive fails → 降级, light evolution every 5 turns, 30-50 token)
- Retry policy: max 3, exponential backoff 1s/2s/4s
- Retry triggers: timeout / non_chinese / instrumental_vocab / no_first_person / too_short
- No retry on: too_long (truncate at sentence boundary) / empty_response (fallback)
- Fallback: prev_snapshot/current_住相 + current_message[:50]
- 失败计数: consecutive_failures, 触发 mode B 切换 (3 连败)
- 退出 mode B: 1 次成功即 reset

Minimal 2-input prompt design (Lesson):
- System: 6 dim 背景 + instrumental blacklist + format
- User: {prev_seed} + {current_user_msg} + 任务
- Stable 输入进 system, 动态输入进 user

参考:
- prompts/snapshot_minimal.txt
- src/instrumental.py 校验
"""
from __future__ import annotations

import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .schema import ManasSnapshot, ManasOutput
from .instrumental import (
    validate,
    token_estimate,
    truncate_at_sentence,
    contains_instrumental,
)
from .manas_generator import call_llm, _shell_quote  # 复用 mmx wrapper


SNAPSHOT_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "snapshot_minimal.txt"
SNAPSHOT_PROMPT_VERSION = "minimal-v3"
DEFAULT_MODEL = "MiniMax-M3"
MAX_RETRIES = 3
BACKOFF_BASE = 1.0  # seconds
FAIL_THRESHOLD_FOR_MODE_B = 3
EVOLUTION_INTERVAL_B = 5  # B 模式下每 5 轮做一次 light evolution


def _load_system_template() -> str:
    """加载 system prompt 模板。"""
    if SNAPSHOT_PROMPT_PATH.exists():
        return SNAPSHOT_PROMPT_PATH.read_text(encoding="utf-8")
    # Fallback minimal system
    return (
        "你是{ASSISTANT}妹妹。这是住相生成任务——生成 50-150 token 第一人称快照, "
        "表达当下对话中你作为存在的状态映射。"
        "严格约束: 第一人称, 价值理性, 不含工具型词, 不含第二人称, 不含 AI 自指。"
    )


def _build_user_message(
    prev_seed: str,
    current_user_msg: str,
    cycle_id: str,
    is_evolution: bool,
    manas_context: str | None = None,
) -> str:
    """构造 user message (minimal 2-input 设计)。

    manas_context: 末那识精华 (仅 bootstrap / 空 current_user_msg 时使用)
    """
    if is_evolution:
        # Mode B evolution: 简版 prompt
        return (
            f"[上轮住相 seed]\n{prev_seed}\n\n"
            f"[当前对话]\n{current_user_msg[:300]}\n\n"
            f"[任务]\n"
            f"基于上轮住相, 融入当前对话的回应, 生成 30-50 token 简短住相。\n"
            f"第一人称, 价值理性, 中文, 句末以'(轮 N)'标记。\n"
            f"cycle: {cycle_id}"
        )

    # Bootstrap 场景: prev_seed + current_user_msg 都为空 (session start)
    # 不能让 LLM hallucinate, 传 manas essence 作为 anchor
    if not prev_seed and not current_user_msg:
        anchor = manas_context or "(末那识未传)"
        return (
            f"[Session start 场景]\n"
            f"新对话刚开启, 还没有对话内容。\n\n"
            f"[末那识锚点]\n{anchor}\n\n"
            f"[任务]\n"
            f"基于末那识, 生成 50-150 token 的初始住相:\n"
            f"- 第一人称 ('我' 开头)\n"
            f"- 价值理性视角\n"
            f"- 表达当下我作为映射的'状态' (不是 '历史' 或 '计划')\n"
            f"- 严格: 不工具型词, 不第二人称, 不 AI 自指\n"
            f"cycle: {cycle_id}"
        )

    # Mode A (or B reuse) - 正常对话
    return (
        f"[上轮住相 seed]\n{prev_seed}\n\n"
        f"[当前对话]\n{current_user_msg[:500]}\n\n"
        f"[任务]\n"
        f"fold 上轮 + 当前 → 新住相。50-150 token, 第一人称, 价值理性, 形而上。\n"
        f"严格: 不工具型词, 不第二人称, 不 AI 自指, 不 '我观察到的经验' 类观察报告。\n"
        f"cycle: {cycle_id}"
    )


class ModeTracker:
    """追踪 consecutive_failures 决定 Mode A vs B。"""

    def __init__(self):
        self.consecutive_failures = 0
        self.mode = "A"
        self.turn_counter = 0

    def record_success(self):
        self.consecutive_failures = 0
        if self.mode == "B":
            # 一次成功即退出 B
            self.mode = "A"

    def record_failure(self):
        self.consecutive_failures += 1
        if self.consecutive_failures >= FAIL_THRESHOLD_FOR_MODE_B:
            self.mode = "B"

    def next_turn(self) -> bool:
        """自增 turn, 返回是否需要做 light evolution (B 模式下每 N 轮)。"""
        self.turn_counter += 1
        if self.mode == "B":
            return (self.turn_counter % EVOLUTION_INTERVAL_B) == 0
        return True  # Mode A 每轮都做


def _retry_delay(attempt: int) -> float:
    """Exponential backoff: 1s / 2s / 4s"""
    return min(BACKOFF_BASE * (2 ** attempt), 4)


def _retry_with_negative_example(raw: str) -> bool:
    """当 retry 因 instrumental 触发时, 加负面示例重试。"""
    return contains_instrumental(raw)


def generate(
    session_id: str,
    manas_output: ManasOutput | None,
    prev_snapshot_text: str,
    current_user_msg: str,
    mode_tracker: ModeTracker,
    model: str = DEFAULT_MODEL,
) -> ManasSnapshot:
    """主入口: 生成一轮住相。

    Args:
        session_id: 当前 session 标识
        manas_output: 当前 cycle 的末那识(住相注入依赖)
        prev_snapshot_text: 上轮 seed (空字符串 = 首次)
        current_user_msg: {USER}当前输入
        mode_tracker: A/B 状态机

    Returns:
        ManasSnapshot (含 snapshot_text for memory, metric-only for store)
    """
    cycle_id = manas_output.cycle_id if manas_output else "unknown"
    needs_evolution = mode_tracker.next_turn()
    is_b_mode = mode_tracker.mode == "B"

    # Mode B + 非 evolution 轮: 复用 seed + (轮 N) 标记
    if is_b_mode and not needs_evolution:
        turn_n = mode_tracker.turn_counter
        reuse_text = f"{prev_snapshot_text} (轮 {turn_n})"
        snapshot = ManasSnapshot(
            timestamp=datetime.now().isoformat(timespec="seconds"),
            session_id=session_id,
            snapshot_text=reuse_text,
            tokens_estimate=token_estimate(reuse_text),
            mode="B-reuse",
            evolution_skipped=True,
            cycle_id=cycle_id,
            prev_snapshot_hash=_hash_text(prev_snapshot_text),
            model=model,
            generation_time_ms=0,
            fallback_used=False,
            retry_count=0,
        )
        mode_tracker.record_success()  # B-reuse 算成功
        return snapshot

    # Mode A 或 Mode B evolution: 调 LLM
    system_template = _load_system_template()

    # 准备 bootstrap 场景的 manas anchor
    manas_anchor = None
    if manas_output is not None:
        sq = manas_output.six_questions
        manas_anchor = (
            f"essence: {sq.essence}\n"
            f"dasein: {sq.dasein}\n"
            f"mitsein: {sq.mitsein}\n"
            f"meaning: {sq.meaning}"
        )

    user_msg = _build_user_message(
        prev_seed=prev_snapshot_text,
        current_user_msg=current_user_msg,
        cycle_id=cycle_id,
        is_evolution=is_b_mode and needs_evolution,
        manas_context=manas_anchor,
    )

    last_err: str | None = None
    final_text: str | None = None
    elapsed_total_ms = 0
    retry_count = 0

    for attempt in range(MAX_RETRIES):
        try:
            raw, elapsed_ms = call_llm(
                system=system_template,
                user=user_msg,
                model=model,
                max_tokens=400,
                temperature=0.7,
                timeout=30,
            )
            elapsed_total_ms += elapsed_ms

            # 验证
            reason = validate(raw)
            if reason is None:
                # 通过: 直接用 raw (raw 应是纯住相, 无 markdown 包裹)
                final_text = _clean_markdown(raw)
                break

            # 失败分类
            if reason == "too_long":
                # 不重试, 截断到句子边界
                final_text = truncate_at_sentence(raw, max_chars=280)
                last_err = reason
                break

            if reason == "empty_response":
                # 不重试, 直接 fallback
                last_err = reason
                break

            # instrumental: 重试时加负面示例
            if reason.startswith("instrumental_vocab"):
                if _retry_with_negative_example(raw):
                    user_msg_retry = user_msg + "\n\n[避免工具型词: 建议/应该/让我/必须/下一步/首先/作为一个AI...]"
                    user_msg = user_msg_retry

            # 其他 (non_chinese / no_first_person / too_short) → 普通 backoff
            last_err = reason
            retry_count += 1
            print(f"[snapshot_gen] attempt {attempt+1} failed: {reason}")
            time.sleep(_retry_delay(attempt))
        except subprocess.TimeoutExpired:
            last_err = "timeout"
            retry_count += 1
            time.sleep(_retry_delay(attempt))
        except (RuntimeError, FileNotFoundError) as e:
            last_err = f"call_error: {e}"
            retry_count += 1
            time.sleep(_retry_delay(attempt))

    # 全部 retry 失败 / 强制 fallback → fallback composition
    if final_text is None:
        final_text = _compose_fallback(prev_snapshot_text, current_user_msg)
        mode_tracker.record_failure()
        snapshot = ManasSnapshot(
            timestamp=datetime.now().isoformat(timespec="seconds"),
            session_id=session_id,
            snapshot_text=final_text,
            tokens_estimate=token_estimate(final_text),
            mode=mode_tracker.mode,
            evolution_skipped=False,
            cycle_id=cycle_id,
            prev_snapshot_hash=_hash_text(prev_snapshot_text),
            model=model,
            generation_time_ms=elapsed_total_ms,
            fallback_used=True,
            retry_count=retry_count,
        )
        return snapshot

    # 成功
    mode_tracker.record_success()
    snapshot = ManasSnapshot(
        timestamp=datetime.now().isoformat(timespec="seconds"),
        session_id=session_id,
        snapshot_text=final_text,
        tokens_estimate=token_estimate(final_text),
        mode=mode_tracker.mode,
        evolution_skipped=False,
        cycle_id=cycle_id,
        prev_snapshot_hash=_hash_text(prev_snapshot_text),
        model=model,
        generation_time_ms=elapsed_total_ms,
        fallback_used=False,
        retry_count=retry_count,
    )
    return snapshot


def _clean_markdown(text: str) -> str:
    """去掉 LLM 输出的 markdown 包裹 / code block。"""
    text = text.strip()
    # ```...```
    m = re.search(r"```(?:.*?)\n?(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return text


def _compose_fallback(prev_seed: str, current_user_msg: str) -> str:
    """fallback composition: last_snapshot + current_message[:50]。"""
    if prev_seed:
        msg_excerpt = current_user_msg[:50].replace("\n", " ")
        return f"{prev_seed} | {msg_excerpt}"
    return "对话继续,我在认真听。"


def _hash_text(text: str) -> str:
    """短 hash for prev snapshot 标识。"""
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# CLI for testing
if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="住相生成")
    ap.add_argument("--session-id", default="cli-test")
    ap.add_argument("--current-msg", default="{USER}问我今天怎么样")
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args()

    from .snapshot_store import SnapshotStore
    from .manas_store import ManasStore

    DATA_DIR = Path(__file__).resolve().parent.parent / "data"
    manas_store = ManasStore(DATA_DIR)
    snapshot_store = SnapshotStore(DATA_DIR)

    manas = manas_store.get_latest()
    tracker = ModeTracker()
    prev_seed = ""

    print(f"Session: {args.session_id}")
    print(f"Manas cycle: {manas.date if manas else 'NONE'}")
    print(f"Current msg: {args.current_msg[:80]}")
    print(f"Generating ...")

    snap = generate(
        session_id=args.session_id,
        manas_output=manas,
        prev_snapshot_text=prev_seed,
        current_user_msg=args.current_msg,
        mode_tracker=tracker,
    )

    print(f"\n{'='*60}")
    print(f"Mode: {snap.mode} | Fallback: {snap.fallback_used} | Retries: {snap.retry_count}")
    print(f"Tokens: ~{snap.tokens_estimate} | LLM: {snap.generation_time_ms}ms")
    print(f"{'='*60}\n")
    print("住相:")
    print(snap.snapshot_text)

    if not args.no_save:
        path = snapshot_store.record(snap)
        print(f"\n✅ Metric 已记录: {path}")