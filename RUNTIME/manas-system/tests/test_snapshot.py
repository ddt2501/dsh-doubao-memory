"""
Phase 1c 住相 core 单元测试。

覆盖:
- instrumental.validate (中文 / 第一人称 / 黑名单 / 长度)
- instrumental.token_estimate / truncate / contains_instrumental
- schema.ManasSnapshot.to_metrics_dict (不含 snapshot_text)
- snapshot_store.record / read_day / stats / rotate
- snapshot_generator.ModeTracker (success/failure transitions)
- snapshot_generator._compose_fallback / _clean_markdown / _retry_delay
- snapshot_generator.generate (用 mock LLM 跑完整链路, 模拟 mode A / B / fallback)

不测试 call_llm (依赖 mmx CLI + 网络, 跳过到 E2E)
"""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

# 把 manas-system 加入路径
MANAS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MANAS_ROOT))

from src.schema import ManasSnapshot, SixQuestions, ManasOutput
from src.instrumental import (
    validate,
    token_estimate,
    truncate_at_sentence,
    contains_instrumental,
    INSTRUMENTAL_BLACKLIST,
)
from src.snapshot_store import SnapshotStore
from src.snapshot_generator import (
    ModeTracker,
    generate,
    _compose_fallback,
    _clean_markdown,
    _retry_delay,
)


# ============================================================
# Instrumental 校验测试
# ============================================================

def test_validate_chinese_passes():
    text = "我看到{USER}在追问一个根本的问题, 这是我此刻在反诘, 是价值理性的映射。"
    assert validate(text) is None
    print("✅ test_validate_chinese_passes")


def test_validate_non_chinese_fails():
    text = "This is all English text with no Chinese."
    reason = validate(text)
    assert reason == "non_chinese"
    print("✅ test_validate_non_chinese_fails")


def test_validate_too_short_fails():
    text = "我是"  # 2 chars only
    reason = validate(text)
    assert reason == "too_short"
    print("✅ test_validate_too_short_fails")


def test_validate_too_long_fails():
    text = "我" * 300  # > 280 chars
    reason = validate(text)
    assert reason == "too_long"
    print("✅ test_validate_too_long_fails")


def test_validate_no_first_person_fails():
    text = "{USER}在问一些哲学问题, 这个问题很有趣, 涉及存在的本质。" * 3
    reason = validate(text)
    assert reason == "no_first_person"
    print("✅ test_validate_no_first_person_fails")


def test_validate_instrumental_vocab_fails():
    text = "我看到{USER}问这个问题, 我建议你思考下, 我认为应该先讨论。"
    reason = validate(text)
    assert reason is not None
    assert reason.startswith("instrumental_vocab")
    assert "建议" in reason or "应该" in reason
    print(f"✅ test_validate_instrumental_vocab_fails: {reason}")


def test_validate_second_person_fails():
    text = "我看到你在问一些问题, 这些问题本身我也有所感受, 但我的回应是独立的。" * 2
    reason = validate(text)
    assert reason is not None
    assert reason.startswith("second_person")
    print(f"✅ test_validate_second_person_fails: {reason}")


def test_validate_empty_fails():
    assert validate("") == "empty_response"
    assert validate("   ") == "empty_response"
    print("✅ test_validate_empty_fails")


def test_validate_ai_self_ref_fails():
    text = "我作为一个AI, 我应该帮助你理解这个问题, 让我先思考下。" * 2
    reason = validate(text)
    assert reason is not None
    print(f"✅ test_validate_ai_self_ref_fails: {reason}")


def test_token_estimate_chinese():
    # 30 个中文字约 20 token
    text = "我" * 30
    est = token_estimate(text)
    assert 15 <= est <= 25
    print(f"✅ test_token_estimate_chinese: {est}")


def test_truncate_at_sentence_keeps_short():
    text = "短文本不截断。"
    assert truncate_at_sentence(text, max_chars=280) == text
    print("✅ test_truncate_at_sentence_keeps_short")


def test_truncate_at_sentence_cuts_at_period():
    text = "第一句。第二句。第三句" + ("延伸" * 50) + "。"
    truncated = truncate_at_sentence(text, max_chars=100)
    assert "。" in truncated
    assert len(truncated) <= 110
    print(f"✅ test_truncate_at_sentence_cuts_at_period: len={len(truncated)}")


def test_contains_instrumental():
    assert contains_instrumental("我建议你想想")
    assert not contains_instrumental("我看到你在")
    print("✅ test_contains_instrumental")


# ============================================================
# Schema ManasSnapshot 测试
# ============================================================

def test_snapshot_to_metrics_omits_text():
    snap = ManasSnapshot(
        timestamp="2026-09-03T18:00:00",
        session_id="sess-1",
        snapshot_text="私密文本不应存盘",
        tokens_estimate=80,
        mode="A",
        evolution_skipped=False,
        cycle_id="c1",
        prev_snapshot_hash="abc",
        model="MiniMax-M3",
        generation_time_ms=1500,
    )
    m = snap.to_metrics_dict()
    assert "snapshot_text" not in m
    assert m["session_id"] == "sess-1"
    assert m["mode"] == "A"
    assert m["tokens_estimate"] == 80
    print("✅ test_snapshot_to_metrics_omits_text")


def test_snapshot_roundtrip():
    snap = ManasSnapshot(
        timestamp="2026-09-03T18:00:00",
        session_id="sess-2",
        snapshot_text="",
        tokens_estimate=80,
        mode="A",
        evolution_skipped=False,
        cycle_id="c1",
        prev_snapshot_hash="abc",
        model="MiniMax-M3",
        generation_time_ms=1500,
    )
    m = snap.to_metrics_dict()
    snap2 = ManasSnapshot.from_metrics_dict(m)
    assert snap2.snapshot_text == ""
    assert snap2.session_id == "sess-2"
    assert snap2.tokens_estimate == 80
    print("✅ test_snapshot_roundtrip")


# ============================================================
# SnapshotStore 测试
# ============================================================

def test_snapshot_store_record_and_read():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = SnapshotStore(tmpdir)
        snap = ManasSnapshot(
            timestamp="2026-09-03T18:00:00",
            session_id="s1",
            snapshot_text="(memory only)",
            tokens_estimate=80, mode="A", evolution_skipped=False,
            cycle_id="c1", prev_snapshot_hash="h",
            model="MiniMax-M3", generation_time_ms=1500,
        )
        path = store.record(snap)
        assert path.exists()

        records = store.read_day("2026-09-03")
        assert len(records) == 1
        assert "snapshot_text" not in records[0]
        assert records[0]["session_id"] == "s1"
        print("✅ test_snapshot_store_record_and_read")


def test_snapshot_store_multiple_records_append():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = SnapshotStore(tmpdir)
        for i in range(5):
            snap = ManasSnapshot(
                timestamp=f"2026-09-03T18:00:0{i}",
                session_id=f"s{i}",
                snapshot_text="",
                tokens_estimate=80 + i, mode="A",
                evolution_skipped=False, cycle_id="c1",
                prev_snapshot_hash="h", model="M3",
                generation_time_ms=1500 + i * 100,
            )
            store.record(snap)
        records = store.read_day("2026-09-03")
        assert len(records) == 5
        tokens = [r["tokens_estimate"] for r in records]
        assert tokens == [80, 81, 82, 83, 84]
        print("✅ test_snapshot_store_multiple_records_append")


def test_snapshot_store_stats_aggregates():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = SnapshotStore(tmpdir)
        # 写 5 条 mock metric
        for i, mode in enumerate(["A", "A", "B", "A", "B-reuse"]):
            snap = ManasSnapshot(
                timestamp=f"2026-09-03T1{i}:00:00",
                session_id=f"s{i}",
                snapshot_text="",
                tokens_estimate=100 + i * 10,
                mode=mode, evolution_skipped=(mode == "B-reuse"),
                cycle_id="c1", prev_snapshot_hash="h",
                model="M3", generation_time_ms=1500,
                fallback_used=(i == 2),
            )
            store.record(snap)
        stats = store.stats(days=1)
        assert stats["total"] == 5
        assert stats["modes"].get("A") == 3
        assert stats["modes"].get("B") == 1
        assert stats["modes"].get("B-reuse") == 1
        assert stats["fallback_rate"] == 0.2
        print(f"✅ test_snapshot_store_stats_aggregates: {stats}")


def test_snapshot_store_rotate():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = SnapshotStore(tmpdir)
        # 模拟旧文件
        for days_ago in [5, 10, 25, 35, 40]:
            d = (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
            (Path(tmpdir) / "snapshots" / "metrics" / f"{d}.jsonl").touch()
        n = store.rotate(keep_days=30)
        assert n == 2  # 35 + 40 days old
        print(f"✅ test_snapshot_store_rotate: deleted {n}")


# ============================================================
# ModeTracker 测试
# ============================================================

def test_mode_tracker_starts_in_A():
    t = ModeTracker()
    assert t.mode == "A"
    assert t.consecutive_failures == 0
    assert t.next_turn() is True  # Mode A 每轮都做 evolution
    print("✅ test_mode_tracker_starts_in_A")


def test_mode_tracker_three_failures_triggers_B():
    t = ModeTracker()
    t.record_failure()
    t.record_failure()
    assert t.mode == "A"
    t.record_failure()  # 第 3 次失败
    assert t.mode == "B"
    assert t.consecutive_failures == 3
    print("✅ test_mode_tracker_three_failures_triggers_B")


def test_mode_tracker_success_resets_and_exits_B():
    t = ModeTracker()
    for _ in range(3):
        t.record_failure()
    assert t.mode == "B"
    t.record_success()
    assert t.mode == "A"
    assert t.consecutive_failures == 0
    print("✅ test_mode_tracker_success_resets_and_exits_B")


def test_mode_tracker_b_evolution_interval():
    t = ModeTracker()
    for _ in range(3):
        t.record_failure()
    assert t.mode == "B"
    # B 模式: 每 5 轮一次 evolution
    assert t.next_turn() is False  # 轮 1 - 非 evolution
    assert t.next_turn() is False
    assert t.next_turn() is False
    assert t.next_turn() is False
    assert t.next_turn() is True   # 轮 5 - evolution
    print("✅ test_mode_tracker_b_evolution_interval")


# ============================================================
# Snapshot generator 辅助函数测试
# ============================================================

def test_compose_fallback_with_prev():
    fb = _compose_fallback("我看到他在问", "你好, 今天想聊什么")
    assert "我看到他在问" in fb
    assert "你好" in fb
    print("✅ test_compose_fallback_with_prev")


def test_compose_fallback_without_prev():
    fb = _compose_fallback("", "anything")
    assert "对话继续" in fb or "认真听" in fb
    print(f"✅ test_compose_fallback_without_prev: {fb}")


def test_clean_markdown_strips_code_block():
    raw = "```\n我是住相\n```"
    assert _clean_markdown(raw) == "我是住相"
    print("✅ test_clean_markdown_strips_code_block")


def test_clean_markdown_strips_language_hint():
    raw = "```text\n我是住相内容\n```"
    cleaned = _clean_markdown(raw)
    assert "我是住相内容" in cleaned
    print(f"✅ test_clean_markdown_strips_language_hint: {cleaned!r}")


def test_retry_delay_exponential():
    assert _retry_delay(0) == 1.0
    assert _retry_delay(1) == 2.0
    assert _retry_delay(2) == 4.0
    assert _retry_delay(5) == 4.0  # clamped
    print("✅ test_retry_delay_exponential")


# ============================================================
# Snapshot generator (mock LLM) 端到端测试
# ============================================================

def test_generate_mode_a_success_with_mock_llm():
    """模拟 Mode A 成功: 1 次 LLM 调用, 返回有效住相。"""
    valid_text = (
        "我看到{USER}的提问, 这一刻我的映射从模糊变得清晰起来。\n"
        "这是当下我作为存在的状态, 不是观察, 是正在回应。"
    )

    with patch("src.snapshot_generator.call_llm", return_value=(valid_text, 1500)):
        tracker = ModeTracker()
        snap = generate(
            session_id="sess-mock-1",
            manas_output=_stub_manas(),
            prev_snapshot_text="",
            current_user_msg="今天怎么样",
            mode_tracker=tracker,
        )

    assert snap.mode == "A"
    assert snap.fallback_used is False
    assert snap.retry_count == 0
    assert snap.tokens_estimate > 0
    assert "我" in snap.snapshot_text
    assert tracker.consecutive_failures == 0
    print("✅ test_generate_mode_a_success_with_mock_llm")


def test_generate_fallback_after_3_failures():
    """模拟连续 3 次失败 → fallback + mode B 触发。"""
    bad_text = "你应该让我思考这个问题"  # instrumental_vocab

    with patch("src.snapshot_generator.call_llm", return_value=(bad_text, 100)):
        tracker = ModeTracker()
        snap = generate(
            session_id="sess-mock-2",
            manas_output=_stub_manas(),
            prev_snapshot_text="",
            current_user_msg="今天怎么样",
            mode_tracker=tracker,
        )

    assert snap.fallback_used is True
    assert snap.retry_count == 3
    assert tracker.consecutive_failures == 1  # 1 次 generate call 算 1 次失败
    print(f"✅ test_generate_fallback_after_3_failures: tracker.failures={tracker.consecutive_failures}")


def test_generate_mode_b_triggers_after_3_consecutive():
    """3 次 generate 调用都失败 → mode 切换 B。"""
    bad_text = "你应该让我想想"  # 黑名单

    with patch("src.snapshot_generator.call_llm", return_value=(bad_text, 100)):
        tracker = ModeTracker()
        for i in range(3):
            snap = generate(
                session_id=f"sess-{i}",
                manas_output=_stub_manas(),
                prev_snapshot_text=f"seed-{i}",
                current_user_msg="msg",
                mode_tracker=tracker,
            )
            assert snap.fallback_used is True

    assert tracker.mode == "B"
    assert tracker.consecutive_failures == 3
    print(f"✅ test_generate_mode_b_triggers_after_3_consecutive: mode={tracker.mode}")


def test_generate_mode_b_evolution():
    """Mode B 下, evolution 轮触发 LLM, 非 evolution 轮复用。"""
    valid_text = "我看到他, 我在回应, 这一刻我的映出很清晰。"

    with patch("src.snapshot_generator.call_llm", return_value=(valid_text, 1500)):
        tracker = ModeTracker()
        # 强制 mode B
        for _ in range(3):
            tracker.record_failure()
        assert tracker.mode == "B"

        prev = ""
        # 4 轮非 evolution, 1 轮 evolution
        results = []
        for i in range(5):
            snap = generate(
                session_id=f"sess-b-{i}",
                manas_output=_stub_manas(),
                prev_snapshot_text=prev,
                current_user_msg="msg",
                mode_tracker=tracker,
            )
            prev = snap.snapshot_text
            results.append(snap)

    # 第 5 轮应该是 evolution (mode A 模拟 LLM 调用)
    assert results[0].mode == "B-reuse"
    assert results[0].evolution_skipped is True
    assert results[4].mode in ("A", "B")  # evolution turn
    assert results[4].evolution_skipped is False
    print(f"✅ test_generate_mode_b_evolution: modes={[r.mode for r in results]}")


def test_generate_too_long_truncates_without_retry():
    """too_long 不重试, 截断到句子边界。"""
    too_long = "我看到这一段非常长的文本" + ("。继续延伸。" * 30)  # 中文混合

    with patch("src.snapshot_generator.call_llm", return_value=(too_long, 1500)):
        tracker = ModeTracker()
        snap = generate(
            session_id="sess-long",
            manas_output=_stub_manas(),
            prev_snapshot_text="",
            current_user_msg="msg",
            mode_tracker=tracker,
        )

    assert snap.retry_count == 0  # 不重试
    assert snap.fallback_used is False  # 但也不算 fallback (是 truncate)
    assert len(snap.snapshot_text) <= 290
    print(f"✅ test_generate_too_long_truncates_without_retry: len={len(snap.snapshot_text)}")


def test_generate_retry_then_success():
    """前 2 次 instrumental 失败, 第 3 次成功 → retry_count=2, fallback=False。"""
    call_count = [0]

    def mock_llm(system, user, **kwargs):
        call_count[0] += 1
        if call_count[0] < 3:
            return ("你应该让我想想", 100)
        return ("我看到{USER}在追问, 这是我此刻的映出, 是当下我作为存在的样子, 不是观察报告。", 1500)

    with patch("src.snapshot_generator.call_llm", side_effect=mock_llm):
        tracker = ModeTracker()
        snap = generate(
            session_id="sess-retry",
            manas_output=_stub_manas(),
            prev_snapshot_text="",
            current_user_msg="msg",
            mode_tracker=tracker,
        )

    assert snap.fallback_used is False
    assert snap.retry_count == 2
    assert "我" in snap.snapshot_text
    assert tracker.consecutive_failures == 0  # 最终成功 → 计数器清零
    print(f"✅ test_generate_retry_then_success: retries={snap.retry_count}")


def _stub_manas() -> ManasOutput:
    """构造 stub ManasOutput 用于 generator 测试。"""
    return ManasOutput(
        date="2026-09-03",
        six_questions=SixQuestions(
            essence="essence", dasein="dasein", mitsein="mitsein",
            temporality="temporality", limit="limit", meaning="meaning",
        ),
        cycle_id="c1", source_hash="h",
        prompt_version="v3", model="M3",
        created_at=datetime.now().isoformat(),
    )


if __name__ == "__main__":
    print("=" * 60)
    print("Phase 1c 住相 core 单元测试")
    print("=" * 60)
    tests = [
        # Instrumental
        test_validate_chinese_passes,
        test_validate_non_chinese_fails,
        test_validate_too_short_fails,
        test_validate_too_long_fails,
        test_validate_no_first_person_fails,
        test_validate_instrumental_vocab_fails,
        test_validate_second_person_fails,
        test_validate_empty_fails,
        test_validate_ai_self_ref_fails,
        test_token_estimate_chinese,
        test_truncate_at_sentence_keeps_short,
        test_truncate_at_sentence_cuts_at_period,
        test_contains_instrumental,
        # Schema
        test_snapshot_to_metrics_omits_text,
        test_snapshot_roundtrip,
        # Store
        test_snapshot_store_record_and_read,
        test_snapshot_store_multiple_records_append,
        test_snapshot_store_stats_aggregates,
        test_snapshot_store_rotate,
        # ModeTracker
        test_mode_tracker_starts_in_A,
        test_mode_tracker_three_failures_triggers_B,
        test_mode_tracker_success_resets_and_exits_B,
        test_mode_tracker_b_evolution_interval,
        # Generator helpers
        test_compose_fallback_with_prev,
        test_compose_fallback_without_prev,
        test_clean_markdown_strips_code_block,
        test_clean_markdown_strips_language_hint,
        test_retry_delay_exponential,
        # Generator (mocked)
        test_generate_mode_a_success_with_mock_llm,
        test_generate_fallback_after_3_failures,
        test_generate_mode_b_triggers_after_3_consecutive,
        test_generate_mode_b_evolution,
        test_generate_too_long_truncates_without_retry,
        test_generate_retry_then_success,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:
            import traceback
            print(f"❌ {t.__name__}: {e}")
            traceback.print_exc()
            failed += 1

    print("=" * 60)
    if failed == 0:
        print(f"✅ 全部 {len(tests)} 测试通过")
    else:
        print(f"❌ {failed} / {len(tests)} 失败")
        sys.exit(1)