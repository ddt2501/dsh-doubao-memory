"""E2E test: 跑真生成器, 打印产物, 保存。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.manas_generator import generate
from src.manas_store import ManasStore

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
store = ManasStore(DATA_DIR)

prev = store.get_latest()
if prev is None:
    print("无上轮产物, 首次跑")
else:
    print(f"上轮 cycle: {prev.date} ({prev.cycle_id})")

print("调 LLM 生成末那识 ...")
result = generate(prev_manas=prev, force=True)

print("\n" + "=" * 60)
print(f"日期:    {result.date}")
print(f"Cycle:   {result.cycle_id}")
print(f"Hash:    {result.source_hash}")
print(f"Model:   {result.model} ({result.generation_time_ms}ms)")
print(f"Fallback: {result.fallback_used}")
print(f"Tokens:  ~{result.six_questions.token_estimate()}")
print("=" * 60 + "\n")
print("六问产物:")
print(result.six_questions.to_json())

path = store.save(result)
print(f"\n✅ 已保存: {path}")