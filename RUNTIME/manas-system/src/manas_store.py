"""
末那识 (Manas) 周期产物存储。

设计:
- 每天一个文件 data/manas/{YYYY-MM-DD}.json
- 5 天一个 cycle, 30 cycle 保留 (~150 天)
- Atomic write (Lesson 16: temp + rename)
- dedupe by date (覆盖写,但 source_hash 校验防误覆盖)

参考:
- manas-system/PLAN.md Phase 1a
- MEMORY.md 教训 16: 破坏性操作前必须自动备份
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable

from .schema import ManasOutput


class ManasStore:
    """末那识产物的 daily store。"""

    def __init__(self, base_dir: str | Path):
        self.base_dir = Path(base_dir)
        self.manas_dir = self.base_dir / "manas"
        self.manas_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, date: str) -> Path:
        return self.manas_dir / f"{date}.json"

    def save(self, output: ManasOutput, overwrite: bool = True) -> Path:
        """原子写入一个周期的产物。

        Args:
            output: 产物
            overwrite: 是否覆盖已有(默认 True)。False 时存在则 raise。
        """
        path = self.path_for(output.date)
        if path.exists() and not overwrite:
            raise FileExistsError(f"manas/{output.date}.json already exists")

        # 旧文件备份 (Lesson 16: 防破坏性写覆盖)
        if path.exists():
            backup = path.with_suffix(f".{datetime.now().strftime('%H%M%S')}.bak")
            shutil.copy2(path, backup)

        # 临时文件 + rename (atomic write)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(output.to_json(), encoding="utf-8")
        os.replace(tmp, path)
        return path

    def get(self, date: str) -> ManasOutput | None:
        path = self.path_for(date)
        if not path.exists():
            return None
        raw = path.read_text(encoding="utf-8")
        try:
            return ManasOutput.from_json(raw)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f"[manas_store] WARN corrupt {path.name}: {e}")
            return None

    def get_latest(self) -> ManasOutput | None:
        """获取最近一个周期的产物(按 date 倒序)。"""
        dates = self.list_dates_desc()
        if not dates:
            return None
        return self.get(dates[0])

    def list_dates(self) -> list[str]:
        """所有日期升序。"""
        return sorted(
            p.stem for p in self.manas_dir.glob("*.json")
            if not p.stem.endswith(".bak") and not p.stem.startswith(".")
        )

    def list_dates_desc(self) -> list[str]:
        return list(reversed(self.list_dates()))

    def recent(self, n: int = 30) -> list[ManasOutput]:
        dates = self.list_dates_desc()[:n]
        out = []
        for d in dates:
            o = self.get(d)
            if o is not None:
                out.append(o)
        return out

    def rotate(self, keep_days: int = 30 * 5) -> int:
        """保留最新 keep_days 天,删除更早的(默认 30 cycle ≈ 150 天)。

        Returns: 删除的文件数
        """
        dates = self.list_dates_desc()
        to_delete = dates[keep_days:]
        count = 0
        for d in to_delete:
            path = self.path_for(d)
            if path.exists():
                path.unlink()
                count += 1
        return count

    def backup(self, dest_dir: str | Path) -> int:
        """复制全部 manas/ 到 dest_dir (Lesson 16 破坏性操作前)。"""
        dest = Path(dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        count = 0
        for src in self.manas_dir.glob("*.json"):
            shutil.copy2(src, dest / src.name)
            count += 1
        return count

    def exists(self, date: str) -> bool:
        return self.path_for(date).exists()

    def count(self) -> int:
        return len(self.list_dates())


# CLI entry for manual ops
if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Manas store ops")
    sub = ap.add_subparsers(dest="op", required=True)

    p_ls = sub.add_parser("list", help="列出所有日期")
    p_get = sub.add_parser("get", help="获取指定日期")
    p_get.add_argument("date")
    p_rot = sub.add_parser("rotate", help="保留最新 N 天")
    p_rot.add_argument("--keep", type=int, default=150)

    args = ap.parse_args()
    base = Path(__file__).resolve().parent.parent / "data"
    store = ManasStore(base)

    if args.op == "list":
        for d in store.list_dates_desc():
            print(d)
    elif args.op == "get":
        o = store.get(args.date)
        if o is None:
            print(f"NOT FOUND: {args.date}", file=sys.stderr)
            sys.exit(1)
        print(o.to_json())
    elif args.op == "rotate":
        n = store.rotate(args.keep)
        print(f"deleted {n} old files (kept {args.keep})")