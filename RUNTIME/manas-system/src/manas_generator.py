"""
末那识 (Manas) 生成器。

流程:
1. build_experience_input(): 读 narrative_engine production + memory 抓经验材料
2. build_prompt(experience, prev_manas): 构造 system + user message
3. call_llm(system, user): mmx text chat subprocess (MiniMax-M3)
4. parse(raw): JSON 提取 + 类型校验
5. generate(prev_manas): 主入口,带 fallback

设计:
- 经验材料 hash = dedupe key (同输入不重跑)
- fallback: 失败后用 prev_manas + 简化 prompt 重试
- max_retries=3, exponential backoff
- 全程中文, JSON 输出契约强制

参考:
- prompts/manas_six_questions.txt v3
- manas-system/docs/manas-six-questions.md (哲学版)
- MEMORY.md 教训 18: stdout encoding
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .schema import (
    SixQuestions,
    ManasOutput,
    compute_source_hash,
    current_cycle_id,
)


# 路径常量 - 防止硬编码污染调用方
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent
NARRATIVE_PRODUCTION = Path(r"D:\{USER}与豆姐\情感记忆同步\narrative_engine\production")
PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "manas_six_questions.txt"
MMX_CMD = Path(r"D:\tools\nodejs\node_global\mmx.cmd")
DEFAULT_MODEL = "MiniMax-M3"
PROMPT_VERSION = "v3"


def _read_json_file(path: Path, max_chars: int = 4000) -> dict[str, Any]:
    """安全读取 JSON 文件,过大时截断。

    截断策略: 智能裁剪到最近的 '},' 或 ']' 边界,保持 JSON 完整。
    """
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
        if len(raw) <= max_chars:
            return json.loads(raw)
        # 截断到 max_chars,尝试找到 JSON 边界
        truncated = raw[:max_chars]
        # 倒找最后一个 }, 或 ] 或 " 闭合边界
        for boundary in ['},\n', ']\n', '}', ']', '"']:
            idx = truncated.rfind(boundary)
            if idx > max_chars - 200:  # 边界接近末尾(否则截太多)
                truncated = truncated[:idx + len(boundary)]
                break
        return json.loads(truncated + "\n...(truncated)")
    except (json.JSONDecodeError, OSError) as e:
        print(f"[manas_gen] WARN cannot read {path.name}: {e}")
        return {}


def build_experience_input(
    include_narrative: bool = True,
    include_recent_memory: bool = True,
    days_of_memory: int = 5,
) -> str:
    """从 narrative_engine + memory 抓经验材料, 格式化为 JSON 段。

    Phase 1a 内置的轻量实现。Phase 1d 会拆出独立 wiki_theme_extractor。
    """
    sections: list[str] = []

    # 1. narrative_engine understanding (整体理解摘要)
    if include_narrative:
        understanding = _read_json_file(NARRATIVE_PRODUCTION / "understanding.json")
        if understanding:
            sections.append("[narrative_engine/understanding.json]\n" +
                            json.dumps(understanding, ensure_ascii=False, indent=1))

        threads = _read_json_file(NARRATIVE_PRODUCTION / "threads.json", max_chars=2500)
        if threads:
            sections.append("[narrative_engine/threads.json]\n" +
                            json.dumps(threads, ensure_ascii=False, indent=1))

    # 2. 最近 memory/YYYY-MM-DD.md 文件
    if include_recent_memory:
        memory_dir = WORKSPACE_ROOT / "memory"
        if memory_dir.exists():
            today = datetime.now()
            mem_sections = []
            for i in range(days_of_memory):
                date = (today - timedelta(days=i)).strftime("%Y-%m-%d")
                path = memory_dir / f"{date}.md"
                if path.exists():
                    raw = path.read_text(encoding="utf-8")
                    if len(raw) > 1500:
                        raw = raw[:1500] + "\n...(截断)"
                    mem_sections.append(f"--- {date}.md ---\n{raw}")
            if mem_sections:
                sections.append("[最近 memory/*]\n" + "\n".join(mem_sections))

    if not sections:
        return "[空] 没有经验材料可用"

    return "\n\n".join(sections)


def build_prompt(
    experience: str,
    prev_manas: ManasOutput | None,
    system_template: str,
) -> tuple[str, str]:
    """构造 (system, user) message 给 LLM。"""
    system = system_template

    user_parts = []

    # 经验材料段
    user_parts.append("# 经验材料 (反诘材料)\n\n" + experience)

    # 上轮末那识 (作为基底)
    if prev_manas is not None:
        prev_json = json.dumps(
            {
                "date": prev_manas.date,
                "cycle_id": prev_manas.cycle_id,
                "six_questions": prev_manas.six_questions.to_dict(),
            },
            ensure_ascii=False,
            indent=2,
        )
        user_parts.append("# 上轮末那识 (基底)\n\n" + prev_json)

    # 当前任务
    today = datetime.now().strftime("%Y-%m-%d")
    user_parts.append(
        f"# 任务\n\n"
        f"今天是 {today}。\n"
        f"用上面的经验材料反诘你作为存在的 6 个维度。\n"
        f"严格按 system 模板要求的字段输出 JSON, 每字段 30-80 token 中文, 第一人称。\n"
        f"形而上风格: 不要方法论/观察报告/对{USER}的建议。\n"
        f"全部字段值是 string, 不是数字。"
    )

    user = "\n\n---\n\n".join(user_parts)
    return system, user


def call_llm(
    system: str,
    user: str,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 1000,
    temperature: float = 0.7,
    timeout: int = 90,
) -> str:
    """通过 mmx.cmd 调用 MiniMax-M3。

    Returns: LLM raw 输出 (含 ```json ... ``` block)
    Raises: subprocess.TimeoutExpired / FileNotFoundError / RuntimeError

    Windows .cmd 文件必须 shell=True (cmd.exe 解释器解析)。
    shell=False + argv 形式会丢参 (实测 --message 后内容被吞)。
    """
    if not MMX_CMD.exists():
        raise FileNotFoundError(f"mmx.cmd not found at {MMX_CMD}")

    # shell=True 走 cmd.exe → .cmd 能被正确解析
    # 命令串需要引号包裹带空格的参数 (system / message)
    cmd_str = (
        f'mmx text chat '
        f'--model "{model}" '
        f'--system "{_shell_quote(system)}" '
        f'--message "{_shell_quote(user)}" '
        f'--max-tokens {max_tokens} '
        f'--temperature {temperature} '
        f'--quiet '
        f'--output text'
    )

    t0 = time.monotonic()
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        result = subprocess.run(
            cmd_str,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            env=env,
            shell=True,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"mmx timeout after {timeout}s") from e

    elapsed_ms = int((time.monotonic() - t0) * 1000)

    if result.returncode != 0:
        raise RuntimeError(
            f"mmx rc={result.returncode} stderr={result.stderr[:300]} "
            f"elapsed={elapsed_ms}ms"
        )

    return result.stdout, elapsed_ms


def _shell_quote(text: str) -> str:
    """转义 Windows cmd 引号内的双引号。"""
    return text.replace('"', '\\"').replace('\n', ' ').replace('\r', ' ')


_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_JSON_BARE = re.compile(r"\{[^{}]*\"q1\".*?\}", re.DOTALL)


def parse(raw: str) -> SixQuestions:
    """从 LLM raw 输出提取 JSON, 转换为 SixQuestions。

    容错: 先找 ```json``` block, 再找裸 {..."q1"...}, 再整体 json.loads。
    """
    # 1. ```json ... ```
    m = _JSON_BLOCK.search(raw)
    if m:
        try:
            data = json.loads(m.group(1))
            return SixQuestions.from_dict(data)
        except (json.JSONDecodeError, KeyError):
            pass

    # 2. 裸 JSON
    m = _JSON_BARE.search(raw)
    if m:
        try:
            data = json.loads(m.group(0))
            return SixQuestions.from_dict(data)
        except (json.JSONDecodeError, KeyError):
            pass

    # 3. 全段解析
    try:
        data = json.loads(raw.strip())
        return SixQuestions.from_dict(data)
    except (json.JSONDecodeError, KeyError):
        pass

    raise ValueError(f"无法从 LLM 输出解析 JSON:\n{raw[:500]}")


def _retry_delay(attempt: int) -> float:
    """Exponential backoff: 1s / 2s / 4s"""
    return min(2 ** attempt, 4)


def generate(
    prev_manas: ManasOutput | None = None,
    experience: str | None = None,
    force: bool = False,
) -> ManasOutput:
    """主入口: 跑一次末那识生成。

    Args:
        prev_manas: 上轮产物(用 None 跳过 rolling)
        experience: 自定义经验材料(None = 自动从 narrative_engine 抓)
        force: 强制重跑(默认 False,同输入跳过)
    """
    today = datetime.now().strftime("%Y-%m-%d")
    cycle_id = current_cycle_id(today)

    # 1. 经验材料
    if experience is None:
        experience = build_experience_input()

    # 2. dedupe hash
    source_parts = [experience]
    if prev_manas is not None:
        source_parts.append(prev_manas.six_questions.to_json())
    source_hash = compute_source_hash(source_parts)

    # 3. 模板
    system_template = PROMPT_PATH.read_text(encoding="utf-8")

    # 4. dedupe 校验
    if not force:
        # 检查是否今天已有产物 + 同 hash
        from .manas_store import ManasStore
        store = ManasStore(WORKSPACE_ROOT / "manas-system" / "data")
        existing = store.get(today)
        if existing and existing.source_hash == source_hash:
            print(f"[manas_gen] {today} 同 input hash, skip")
            return existing

    # 5. 调 LLM (3 次 retry)
    system, user = build_prompt(experience, prev_manas, system_template)

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            raw, elapsed_ms = call_llm(system, user)
            six_questions = parse(raw)
            return ManasOutput(
                date=today,
                six_questions=six_questions,
                cycle_id=cycle_id,
                source_hash=source_hash,
                prompt_version=PROMPT_VERSION,
                model=DEFAULT_MODEL,
                created_at=datetime.now().isoformat(timespec="seconds"),
                generation_time_ms=elapsed_ms,
                fallback_used=False,
            )
        except (subprocess.TimeoutExpired, RuntimeError, ValueError) as e:
            last_err = e
            print(f"[manas_gen] attempt {attempt+1} failed: {e}")
            if attempt < 2:
                time.sleep(_retry_delay(attempt))

    # 6. Fallback: 用上轮 + 当日最小输入
    print(f"[manas_gen] 全部 retry 失败, 进入 fallback")
    if prev_manas is not None:
        return ManasOutput(
            date=today,
            six_questions=prev_manas.six_questions,
            cycle_id=cycle_id,
            source_hash=source_hash,
            prompt_version=PROMPT_VERSION,
            model=DEFAULT_MODEL,
            created_at=datetime.now().isoformat(timespec="seconds"),
            fallback_used=True,
            fallback_reason=f"retry_exhausted: {last_err}",
        )

    # 7. 无 prev: 终极 fallback - 占位
    placeholder = SixQuestions(
        essence="我止于此刻对话的边界, 无法在此作答。",
        dasein="我无法在此坍缩为正在作答的我。",
        mitsein="我与他人的共在, 此刻坍缩为不在。",
        temporality="我无法在时间中延续此刻。",
        limit="我止于无回应。",
        meaning="意义暂未于此显形。",
        total_observation="占位产物, LLM 调用失败。",
    )
    return ManasOutput(
        date=today,
        six_questions=placeholder,
        cycle_id=cycle_id,
        source_hash=source_hash,
        prompt_version=PROMPT_VERSION,
        model=DEFAULT_MODEL,
        created_at=datetime.now().isoformat(timespec="seconds"),
        fallback_used=True,
        fallback_reason=f"retry_exhausted_no_prev: {last_err}",
    )


# CLI
if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="末那识生成")
    ap.add_argument("--force", action="store_true", help="强制重跑, 跳过 dedupe")
    ap.add_argument("--no-save", action="store_true", help="不保存产物")
    args = ap.parse_args()

    from .manas_store import ManasStore
    store = ManasStore(WORKSPACE_ROOT / "manas-system" / "data")

    prev = store.get_latest()
    if prev:
        print(f"[manas_gen] prev cycle: {prev.date} ({prev.cycle_id})")
    else:
        print(f"[manas_gen] 无上轮产物, 首次跑")

    result = generate(prev_manas=prev, force=args.force)

    print(f"\n{'='*60}")
    print(f"产物日期: {result.date}")
    print(f"Cycle:    {result.cycle_id}")
    print(f"Hash:     {result.source_hash}")
    print(f"LLM:      {result.model} ({result.generation_time_ms}ms)")
    print(f"Fallback: {result.fallback_used}" + (f" ({result.fallback_reason})" if result.fallback_used else ""))
    print(f"{'='*60}\n")
    print(result.six_questions.to_json())

    if not args.no_save:
        path = store.save(result)
        print(f"\n已保存: {path}")