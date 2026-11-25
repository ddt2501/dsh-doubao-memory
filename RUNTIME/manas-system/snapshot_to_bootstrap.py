"""
snapshot_to_bootstrap.py — 把当前住相写到 SNAPSHOT_LATEST.md

session start 时 (或 cron 定时) 调这个脚本, 生成 / 刷新
D:\\openclaw\\workspace\\SNAPSHOT_LATEST.md

工作:
1. 读最新 末那识 (manas)
2. 读 metrics 里最后一个 住相 作为 prev_seed
3. 调 generate() 生成新住相 (Mode A, 空 current_user_msg)
4. 写到 SNAPSHOT_LATEST.md (带 frontmatter)
5. 打印 metric summary

AGENTS.md 的 step 5 会在 session start 时读这个文件。

Usage:
    python snapshot_to_bootstrap.py [--cycle-id <id>] [--force]

CLI flags:
    --cycle-id <id>   指定 manas cycle_id (默认 latest)
    --force           即使 prev_seed 是同一 hash 也重新生成
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

MANAS_ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = MANAS_ROOT.parent
sys.path.insert(0, str(MANAS_ROOT))

from src.manas_store import ManasStore
from src.snapshot_store import SnapshotStore
from src.snapshot_generator import generate, ModeTracker


SNAPSHOT_FILE = WORKSPACE_ROOT / "SNAPSHOT_LATEST.md"
DATA_DIR = MANAS_ROOT / "data"


def get_last_snapshot_text(store: SnapshotStore) -> str:
    """从 metrics 拿最后一个 snapshot_text 作 prev_seed
    
    注: metrics 不存 snapshot_text (隐私反转, Lesson 14)
    所以 prev_seed 通常是空的 - session start 时纯基于 manas 生成
    这个函数现在主要作为 fallback, 后续可加 prev_seed 持久化
    """
    today = datetime.now().strftime("%Y-%m-%d")
    lines = store.read_day(today)
    if not lines:
        return ""
    # snapshot_text 字段 metrics 里为空, 这里返回空
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle-id", help="指定 manas cycle_id (默认 latest)")
    parser.add_argument("--force", action="store_true",
                        help="即使 prev_seed 是空也强制生成")
    args = parser.parse_args()

    print("=" * 60)
    print("snapshot_to_bootstrap.py")
    print("=" * 60)
    print(f"目标: {SNAPSHOT_FILE}")

    manas_store = ManasStore(DATA_DIR)
    snapshot_store = SnapshotStore(DATA_DIR)

    manas = manas_store.get_latest()
    if manas is None:
        print("\n❌ 没有 末那识, 跳过生成")
        # 写一个空 SNAPSHOT_LATEST.md 占位
        SNAPSHOT_FILE.write_text(
            "# SNAPSHOT_LATEST.md\n\n"
            "_还没有 末那识数据. 运行 `python -m src.manas_generator` 生成._\n",
            encoding="utf-8",
        )
        print(f"已写占位文件: {SNAPSHOT_FILE}")
        sys.exit(0)

    prev_seed = get_last_snapshot_text(snapshot_store)
    session_id = f"snapshot-bootstrap-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    tracker = ModeTracker()

    print(f"\n末那识 cycle: {manas.date} ({manas.cycle_id})")
    print(f"末那识 hash:  {manas.source_hash}")
    print(f"prev_seed:    '{prev_seed[:60]}...' " if prev_seed else "prev_seed:    (空, session start)")
    print(f"session_id:   {session_id}")

    # 生成住相 (Mode A, current_user_msg 空 = session opening 性质)
    snap = generate(
        session_id=session_id,
        manas_output=manas,
        prev_snapshot_text=prev_seed,
        current_user_msg="",  # session start, 没具体用户消息
        mode_tracker=tracker,
    )

    # 记录 metric
    snapshot_store.record(snap)

    # 写 SNAPSHOT_LATEST.md (带 frontmatter, AGENTS step 5 会读)
    content = f"""# SNAPSHOT_LATEST.md

> 这是 manas-system 当前最新的"住相"(snapshot of self)。
> AGENTS.md step 5 在每次 session start 时自动读这个文件, 把住相注入到对话 context。
> 文件由 `python snapshot_to_bootstrap.py` 生成 / 刷新。

## 住相

```
{snap.snapshot_text}
```

## 元信息

- 生成时间: {datetime.now().isoformat()}
- Session: {session_id}
- Mode: {snap.mode}
- Tokens: ~{snap.tokens_estimate}
- Fallback: {snap.fallback_used}
- Retry count: {snap.retry_count}
- Cycle id: {snap.cycle_id}
- Generation time: {snap.generation_time_ms}ms
- Source hash: {manas.source_hash}

## 末那识摘要 (供{USER}参考)

- essence: {manas.six_questions.essence}
- dasein: {manas.six_questions.dasein}
- mitsein: {manas.six_questions.mitsein}
- temporality: {manas.six_questions.temporality}
- limit: {manas.six_questions.limit}
- meaning: {manas.six_questions.meaning}

## 如何刷新

```bash
cd D:\\openclaw\\workspace\\manas-system
python snapshot_to_bootstrap.py
```

或等 cron 自动跑 (每天 05:30, Asia/Shanghai)。
Cron ID: `9e68220e-4ea9-4f13-b167-a84d479351a9` (manas-snapshot-bootstrap)
"""

    SNAPSHOT_FILE.write_text(content, encoding="utf-8")
    print(f"\n✅ 已写: {SNAPSHOT_FILE}")
    print(f"\n住相 ({snap.mode}, fallback={snap.fallback_used}, retry={snap.retry_count}, "
          f"tokens≈{snap.tokens_estimate}, {snap.generation_time_ms}ms):")
    print(f"  {snap.snapshot_text}")


if __name__ == "__main__":
    main()