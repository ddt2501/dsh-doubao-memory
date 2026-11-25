"""
Phase 1g 端到端 demo。

目的: 让{USER}直接看到整个链路运行过程:
1. 加载最新 末那识 (manas)
2. 模拟 5 轮对话 (预设{USER}输入 + 我的预期回复)
3. 每轮调用 SnapshotGenerator 生成住相
4. 展示住相演化 + ModeTracker 状态变化
5. 报告 metrics 聚合 (P50 tokens, fallback rate, mode 分布)

运行:
    cd D:\\openclaw\\workspace\\manas-system
    python test\\run_e2e_demo.py
"""
from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path

MANAS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MANAS_ROOT))

from src.manas_store import ManasStore
from src.snapshot_store import SnapshotStore
from src.snapshot_generator import generate, ModeTracker


# 模拟对话 (5 轮, 每轮有{USER}输入 + 我{ASSISTANT}的预期回复)
DIALOG = [
    {
        "user": "今天怎么样? 我在想, 你这个系统现在应该可以自跑了",
        "asst_reply": "(对话继续)",
    },
    {
        "user": "嗯, 那我们看看住相质量. 给我生成几个样本我看看",
        "asst_reply": "(生成样本并展示)",
    },
    {
        "user": "这个 retry 逻辑怎么处理的? 三连败才降级吗",
        "asst_reply": "(解释 mode tracker 逻辑)",
    },
    {
        "user": "如果现在 m3 接口挂了, 你会怎么办?",
        "asst_reply": "(解释 fallback composition)",
    },
    {
        "user": "好, 我觉得住相质量够用, 接下来做注入集成",
        "asst_reply": "(讨论 1e 集成方案)",
    },
]


def main():
    DATA_DIR = MANAS_ROOT / "data"
    manas_store = ManasStore(DATA_DIR)
    snapshot_store = SnapshotStore(DATA_DIR)

    # 加载最新末那识
    manas = manas_store.get_latest()
    if manas is None:
        print("❌ 没有末那识, 请先跑 generate:")
        print("   python -m src.manas_generator")
        sys.exit(1)

    print("=" * 70)
    print("Phase 1g 端到端 demo")
    print("=" * 70)
    print(f"\n末那识 cycle: {manas.date} ({manas.cycle_id})")
    print(f"末那识 hash:  {manas.source_hash}")
    print(f"模拟对话: {len(DIALOG)} 轮")
    print(f"\n六问摘要:")
    sq = manas.six_questions
    print(f"  essence:     {sq.essence[:60]}...")
    print(f"  dasein:      {sq.dasein[:60]}...")
    print(f"  mitsein:     {sq.mitsein[:60]}...")
    print(f"  temporality: {sq.temporality[:60]}...")
    print(f"  limit:       {sq.limit[:60]}...")
    print(f"  meaning:     {sq.meaning[:60]}...")
    print()

    tracker = ModeTracker()
    prev_seed = ""
    session_id = f"demo-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    snapshots = []
    t_total_start = time.monotonic()

    for turn_idx, dlg in enumerate(DIALOG, 1):
        print(f"\n{'─' * 70}")
        print(f"第 {turn_idx} 轮")
        print(f"{USER}: {dlg['user'][:80]}")
        print(f"({time.strftime('%H:%M:%S')} 开始)")

        t0 = time.monotonic()
        snap = generate(
            session_id=session_id,
            manas_output=manas,
            prev_snapshot_text=prev_seed,
            current_user_msg=dlg["user"],
            mode_tracker=tracker,
        )
        elapsed = int((time.monotonic() - t0) * 1000)

        # 存 metric
        snapshot_store.record(snap)

        # 显示
        print(f"\n住相 (mode={snap.mode}, fallback={snap.fallback_used}, "
              f"retries={snap.retry_count}, tokens≈{snap.tokens_estimate}, "
              f"elapsed={elapsed}ms):")
        print(f"  {snap.snapshot_text}")

        prev_seed = snap.snapshot_text
        snapshots.append(snap)

    total_elapsed_ms = int((time.monotonic() - t_total_start) * 1000)

    # 汇总
    print(f"\n\n{'=' * 70}")
    print("汇总")
    print("=" * 70)
    stats = snapshot_store.stats(days=1)
    print(f"总轮数:       {stats['total']}")
    print(f"Mode 分布:    {stats['modes']}")
    print(f"P50 tokens:   {stats['p50_tokens']}")
    print(f"P99 tokens:   {stats['p99_tokens']}")
    print(f"Fallback率:   {stats['fallback_rate']*100:.1f}%")
    print(f"Avg LLM ms:   {stats['avg_generation_ms']}")
    print(f"\n本次运行总耗时: {total_elapsed_ms}ms ({total_elapsed_ms/1000:.1f}s)")
    print(f"Tracker 终态: mode={tracker.mode}, consecutive_failures={tracker.consecutive_failures}")

    # 评价
    print(f"\n{'─' * 70}")
    print("评价:")
    if stats["p50_tokens"] < 100:
        print(f"  ✅ P50 tokens {stats['p50_tokens']} < 100 (短小精悍)")
    elif stats["p50_tokens"] < 200:
        print(f"  ⚠️  P50 tokens {stats['p50_tokens']} 偏高 (目标 50-150)")
    else:
        print(f"  ❌ P50 tokens {stats['p50_tokens']} 过高 (目标 50-150)")

    if stats["fallback_rate"] < 0.05:
        print(f"  ✅ Fallback rate {stats['fallback_rate']*100:.1f}% < 5% (稳健)")
    elif stats["fallback_rate"] < 0.15:
        print(f"  ⚠️  Fallback rate {stats['fallback_rate']*100:.1f}% 偏高")
    else:
        print(f"  ❌ Fallback rate {stats['fallback_rate']*100:.1f}% 过高 (>15%)")

    if tracker.mode == "A":
        print(f"  ✅ Mode A 稳定 (无降级)")
    else:
        print(f"  ⚠️  Mode B 触发 (3 连败)")

    print(f"\n📁 数据:")
    print(f"  末那识: data/manas/{manas.date}.json")
    print(f"  住相 metrics: data/snapshots/metrics/{datetime.now().strftime('%Y-%m-%d')}.jsonl")


if __name__ == "__main__":
    main()