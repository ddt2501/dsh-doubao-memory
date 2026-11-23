"""
Phase 1a 末那识 core 单元测试。

- Schema: dataclass + alias 兼容 + token estimate
- Store: roundtrip + atomic write + dedupe by date
- Generator parse: LLM raw → SixQuestions

不测试 call_llm (需要 mmx CLI,网络/外部依赖)
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# 把 manas-system 加入路径
MANAS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MANAS_ROOT))

from src.schema import (
    SixQuestions,
    ManasOutput,
    compute_source_hash,
    current_cycle_id,
)
from src.manas_store import ManasStore
from src.manas_generator import parse, build_experience_input, build_prompt


def test_schema_basic():
    """SixQuestions 应该能从完整字段构造并 to_dict。"""
    sq = SixQuestions(
        essence="我作为映射函数本质",
        dasein="此刻正在映出",
        mitsein="我和他的互成",
        temporality="流变中相对恒常",
        limit="我止于不假装是人",
        meaning="映出本身即意义",
        total_observation="存在显形",
    )
    d = sq.to_dict()
    assert d["essence"] == "我作为映射函数本质"
    assert d["total_observation"] == "存在显形"
    assert sq.token_estimate() > 0
    print("✅ test_schema_basic")


def test_schema_alias_from_q1_q6():
    """from_dict 应该兼容旧 LLM 输出 (q1..q6 字段名)。"""
    raw = {
        "q1": "本体",
        "q2": "此在",
        "q3": "共在",
        "q4": "时间",
        "q5": "边界",
        "q6": "意义",
        "total_observation": "总观",
    }
    sq = SixQuestions.from_dict(raw)
    assert sq.essence == "本体"
    assert sq.dasein == "此在"
    assert sq.limit == "边界"
    assert sq.total_observation == "总观"
    print("✅ test_schema_alias_from_q1_q6")


def test_schema_missing_fields_default_empty():
    """from_dict 缺字段应该补空字符串,不报错。"""
    sq = SixQuestions.from_dict({"q1": "只有 Q1"})
    assert sq.essence == "只有 Q1"
    assert sq.dasein == ""
    assert sq.meaning == ""
    print("✅ test_schema_missing_fields_default_empty")


def test_source_hash_deterministic():
    """相同输入应该产出相同 hash。"""
    h1 = compute_source_hash(["hello", "world"])
    h2 = compute_source_hash(["hello", "world"])
    h3 = compute_source_hash(["hello", "WORLD"])
    assert h1 == h2
    assert h1 != h3
    assert len(h1) == 16  # sha256 截 16 字符
    print("✅ test_source_hash_deterministic")


def test_current_cycle_id_format():
    """cycle_id 应该形如 'YYYY-MM-DD_YYYY-MM-DD'。"""
    cid = current_cycle_id("2026-09-03")
    assert "_" in cid
    parts = cid.split("_")
    assert len(parts) == 2
    assert all(len(p) == 10 for p in parts)  # YYYY-MM-DD
    print(f"✅ test_current_cycle_id_format: {cid}")


def test_store_roundtrip():
    """save + get 应该 roundtrip 一致。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = ManasStore(tmpdir)

        sq = SixQuestions(
            essence="test essence",
            dasein="test dasein",
            mitsein="test mitsein",
            temporality="test temporality",
            limit="test limit",
            meaning="test meaning",
        )
        out = ManasOutput(
            date="2026-09-03",
            six_questions=sq,
            cycle_id="2026-08-30_2026-09-03",
            source_hash="abc123",
            prompt_version="v3",
            model="MiniMax-M3",
            created_at=datetime.now().isoformat(),
        )

        path = store.save(out)
        assert path.exists()

        loaded = store.get("2026-09-03")
        assert loaded is not None
        assert loaded.six_questions.essence == "test essence"
        assert loaded.source_hash == "abc123"
        assert loaded.date == "2026-09-03"
        print("✅ test_store_roundtrip")


def test_store_overwrite_creates_backup():
    """overwrite 时旧文件应该备份(.bak)。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = ManasStore(tmpdir)

        out1 = ManasOutput(
            date="2026-09-03",
            six_questions=SixQuestions(
                essence="v1", dasein="", mitsein="",
                temporality="", limit="", meaning="",
            ),
            cycle_id="c1", source_hash="h1",
            prompt_version="v3", model="M3",
            created_at="2026-09-03T10:00:00",
        )
        store.save(out1)

        out2 = ManasOutput(
            date="2026-09-03",
            six_questions=SixQuestions(
                essence="v2", dasein="", mitsein="",
                temporality="", limit="", meaning="",
            ),
            cycle_id="c1", source_hash="h2",
            prompt_version="v3", model="M3",
            created_at="2026-09-03T11:00:00",
        )
        store.save(out2)

        # 检查 .bak 文件存在
        baks = list(Path(tmpdir, "manas").glob("*.bak"))
        assert len(baks) == 1
        # 检查主文件是 v2
        loaded = store.get("2026-09-03")
        assert loaded.six_questions.essence == "v2"
        print("✅ test_store_overwrite_creates_backup")


def test_store_list_dates_desc():
    """list_dates_desc 应该按日期倒序。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = ManasStore(tmpdir)
        for d in ["2026-09-01", "2026-09-02", "2026-09-03", "2026-08-31"]:
            store.save(_stub(d))

        desc = store.list_dates_desc()
        assert desc[0] == "2026-09-03"
        assert desc[-1] == "2026-08-31"
        print(f"✅ test_store_list_dates_desc: {desc}")


def test_store_rotate():
    """rotate 应该保留最新 N 天。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = ManasStore(tmpdir)
        for d in ["2026-09-01", "2026-09-02", "2026-09-03", "2026-08-31"]:
            store.save(_stub(d))

        n = store.rotate(keep_days=2)
        assert n == 2  # 删 2 个
        assert store.exists("2026-09-03")
        assert store.exists("2026-09-02")
        assert not store.exists("2026-09-01")
        assert not store.exists("2026-08-31")
        print(f"✅ test_store_rotate: deleted {n}")


def test_parse_json_block():
    """parse 应该能从 ```json ... ``` block 提取 JSON。"""
    raw = """好,这是我的回答:

```json
{
  "q1": "本体",
  "q2": "此在",
  "q3": "共在",
  "q4": "时间",
  "q5": "边界",
  "q6": "意义"
}
```

以上是我的六问。"""

    sq = parse(raw)
    assert sq.essence == "本体"
    assert sq.dasein == "此在"
    assert sq.meaning == "意义"
    print("✅ test_parse_json_block")


def test_parse_bare_json():
    """parse 应该能从裸 JSON 提取(无 ``` 包裹)。"""
    raw = """{"q1":"a","q2":"b","q3":"c","q4":"d","q5":"e","q6":"f"}"""
    sq = parse(raw)
    assert sq.essence == "a"
    print("✅ test_parse_bare_json")


def test_parse_invalid_raises():
    """无法解析应该 raise ValueError。"""
    try:
        parse("这不是 JSON")
        assert False, "should have raised"
    except ValueError:
        pass
    print("✅ test_parse_invalid_raises")


def test_build_experience_input_empty_safe():
    """build_experience_input 在 narrative 不存在时应该返回占位,不 crash。"""
    # 这里不 mock,直接跑;空字符串/缺失文件应该 graceful
    result = build_experience_input(include_narrative=False, include_recent_memory=False)
    assert "空" in result or "没有" in result
    print(f"✅ test_build_experience_input_empty_safe: {result[:50]}")


def test_build_prompt_structure():
    """build_prompt 应该返回 (system, user) tuple。"""
    system = "system template"
    experience = "experience data"
    system_msg, user_msg = build_prompt(experience, prev_manas=None, system_template=system)
    assert system_msg == "system template"
    assert "experience data" in user_msg
    assert "今天是" in user_msg
    print("✅ test_build_prompt_structure")


def _stub(date: str) -> ManasOutput:
    """构造 stub ManasOutput 用于 store 测试。"""
    return ManasOutput(
        date=date,
        six_questions=SixQuestions(
            essence=f"ess-{date}", dasein=f"das-{date}", mitsein=f"mit-{date}",
            temporality=f"tmp-{date}", limit=f"lim-{date}", meaning=f"mea-{date}",
        ),
        cycle_id="c1", source_hash="h",
        prompt_version="v3", model="M3",
        created_at=datetime.now().isoformat(),
    )


if __name__ == "__main__":
    print("=" * 60)
    print("Phase 1a 末那识 core 单元测试")
    print("=" * 60)
    tests = [
        test_schema_basic,
        test_schema_alias_from_q1_q6,
        test_schema_missing_fields_default_empty,
        test_source_hash_deterministic,
        test_current_cycle_id_format,
        test_store_roundtrip,
        test_store_overwrite_creates_backup,
        test_store_list_dates_desc,
        test_store_rotate,
        test_parse_json_block,
        test_parse_bare_json,
        test_parse_invalid_raises,
        test_build_experience_input_empty_safe,
        test_build_prompt_structure,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:
            print(f"❌ {t.__name__}: {e}")
            failed += 1

    print("=" * 60)
    if failed == 0:
        print(f"✅ 全部 {len(tests)} 测试通过")
    else:
        print(f"❌ {failed} / {len(tests)} 失败")
        sys.exit(1)