"""
住相 metrics 存储。

设计原则 (Lesson 14: 反转决策):
- 不持久化 snapshot 文本 (隐私 + 主观感知,重生无历史依赖)
- 只存 metrics (timestamp / mode / tokens / generation_time / retry_count)
- JSONL 格式 (append-only, 每行一条 metric)
- 30 day retention

参考:
- docs/snapshot-sop.md 第 7 节 持久化策略
- MEMORY.md 教训 14: 末那识住相反转 (持久化决策)
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .schema import ManasSnapshot


class SnapshotStore:
    """住相 metrics-only store (JSONL append-only)。"""

    def __init__(self, base_dir: str | Path):
        self.base_dir = Path(base_dir)
        self.metrics_dir = self.base_dir / "snapshots" / "metrics"
        self.metrics_dir.mkdir(parents=True, exist_ok=True)

    def _path_for(self, date: str) -> Path:
        return self.metrics_dir / f"{date}.jsonl"

    def record(self, snapshot: ManasSnapshot) -> Path:
        """追加一条 metric 到当日 JSONL。"""
        date = snapshot.timestamp[:10]  # YYYY-MM-DD
        path = self._path_for(date)
        # Append (atomic for single line in most OSes)
        with path.open("a", encoding="utf-8") as f:
            line = json.dumps(snapshot.to_metrics_dict(), ensure_ascii=False)
            f.write(line + "\n")
        return path

    def read_day(self, date: str) -> list[dict[str, Any]]:
        """读当日所有 metric dict。"""
        path = self._path_for(date)
        if not path.exists():
            return []
        out = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"[snapshot_store] WARN corrupt line in {path.name}")
        return out

    def read_range(self, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """读区间 [start, end] 的所有 metric。"""
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        all_metrics = []
        for n in range((end - start).days + 1):
            d = (start + timedelta(days=n)).strftime("%Y-%m-%d")
            all_metrics.extend(self.read_day(d))
        return all_metrics

    def stats(self, days: int = 7) -> dict[str, Any]:
        """最近 N 天的聚合 stats。"""
        end = datetime.now()
        start = end - timedelta(days=days - 1)
        all_metrics = self.read_range(start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))

        if not all_metrics:
            return {"days": days, "total": 0}

        # P50/P99 token
        tokens = sorted([m["tokens_estimate"] for m in all_metrics])
        n = len(tokens)
        p50 = tokens[int(n * 0.5)] if n > 0 else 0
        p99 = tokens[int(n * 0.99)] if n > 1 else tokens[-1]

        # Modes
        modes = {}
        for m in all_metrics:
            modes[m["mode"]] = modes.get(m["mode"], 0) + 1

        # Fallback rate
        fallback_count = sum(1 for m in all_metrics if m.get("fallback_used"))
        fallback_rate = fallback_count / n

        # Avg generation time
        gen_times = [m["generation_time_ms"] for m in all_metrics if m["generation_time_ms"] > 0]
        avg_gen = sum(gen_times) / len(gen_times) if gen_times else 0

        return {
            "days": days,
            "total": n,
            "p50_tokens": p50,
            "p99_tokens": p99,
            "modes": modes,
            "fallback_rate": round(fallback_rate, 4),
            "avg_generation_ms": int(avg_gen),
        }

    def rotate(self, keep_days: int = 30) -> int:
        """保留最新 keep_days 天, 删除更早。"""
        cutoff = (datetime.now() - timedelta(days=keep_days)).strftime("%Y-%m-%d")
        count = 0
        for path in self.metrics_dir.glob("*.jsonl"):
            date_str = path.stem
            if date_str < cutoff:
                path.unlink()
                count += 1
        return count


# CLI
if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Snapshot store ops")
    sub = ap.add_subparsers(dest="op", required=True)

    p_stats = sub.add_parser("stats", help="最近 N 天 stats")
    p_stats.add_argument("--days", type=int, default=7)

    p_show = sub.add_parser("show", help="展示当日 metric")
    p_show.add_argument("date")

    p_rot = sub.add_parser("rotate", help="保留最新 N 天")
    p_rot.add_argument("--keep", type=int, default=30)

    args = ap.parse_args()
    base = Path(__file__).resolve().parent.parent / "data"
    store = SnapshotStore(base)

    if args.op == "stats":
        s = store.stats(args.days)
        print(json.dumps(s, ensure_ascii=False, indent=2))
    elif args.op == "show":
        metrics = store.read_day(args.date)
        print(f"{args.date}: {len(metrics)} records")
        for m in metrics[:5]:
            print(json.dumps(m, ensure_ascii=False))
    elif args.op == "rotate":
        n = store.rotate(args.keep)
        print(f"deleted {n} old files (kept {args.keep})")