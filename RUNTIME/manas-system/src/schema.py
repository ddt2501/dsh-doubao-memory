"""
末那识 (Manas) data schema.

设计原则:
- 6 个追问形而上学化为 6 个语义字段 (essence / dasein / mitsein / temporality / limit / meaning)
- ManasOutput 是单次周期产物,持久化到 data/manas/{date}.json
- source_hash 用于 dedupe 输入,避免重复生成
- cycle_id 标识 5 天滚动周期

参考:
- docs/manas-six-questions.md (哲学版六问)
- prompts/manas_six_questions.txt v3 (JSON 输出契约)
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any


@dataclass
class SixQuestions:
    """末那识六问产物 (单次回答)。

    字段命名对应哲学维度 (manas-system/docs/manas-six-questions.md):
    - essence:      Q1 本体   (Ontology)
    - dasein:       Q2 此在   (Dasein / phenomenology)
    - mitsein:      Q3 共在   (Being-with / relational ontology)
    - temporality:  Q4 时间性 (Temporality)
    - limit:        Q5 边界   (Finitude / boundary)
    - meaning:      Q6 意义   (Teleology / meaning)
    - total_observation: 可选,1-2 句本周期总观 (强制字符串,禁止数字)
    """

    essence: str
    dasein: str
    mitsein: str
    temporality: str
    limit: str
    meaning: str
    total_observation: str = ""

    def to_dict(self) -> dict[str, str]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SixQuestions":
        # 兼容来自 LLM JSON 输出的 q1..q6 命名 (旧 prompt 字段)
        alias = {
            "q1": "essence",
            "q2": "dasein",
            "q3": "mitsein",
            "q4": "temporality",
            "q5": "limit",
            "q6": "meaning",
        }
        normalized = {}
        for k, v in data.items():
            target = alias.get(k, k)
            normalized[target] = str(v) if v is not None else ""
        # 必需字段补空字符串 (防止 LLM 漏字段)
        for required in ("essence", "dasein", "mitsein", "temporality", "limit", "meaning"):
            normalized.setdefault(required, "")
        return cls(**normalized)

    def token_estimate(self) -> int:
        """粗估 token 数 (按 1 token ≈ 1.5 中文字)。"""
        total = ""
        for v in [self.essence, self.dasein, self.mitsein, self.temporality,
                  self.limit, self.meaning, self.total_observation]:
            total += v
        return int(len(total) * 0.7)


@dataclass
class ManasOutput:
    """末那识周期产物 (单日期)。"""

    date: str  # YYYY-MM-DD
    six_questions: SixQuestions
    cycle_id: str  # 5 天周期标识 e.g. "2026-08-30_2026-09-06"
    source_hash: str  # 输入经验的 hash,用于 dedupe
    prompt_version: str  # e.g. "v3"
    model: str  # e.g. "MiniMax-M3"
    created_at: str  # ISO timestamp
    generation_time_ms: int = 0
    fallback_used: bool = False
    fallback_reason: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ManasOutput":
        sq_data = data.pop("six_questions", {})
        sq = SixQuestions.from_dict(sq_data)
        return cls(six_questions=sq, **data)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    @classmethod
    def from_json(cls, raw: str) -> "ManasOutput":
        return cls.from_dict(json.loads(raw))


def compute_source_hash(parts: list[str]) -> str:
    """计算输入材料 hash,用于 dedupe。"""
    joined = "\n---\n".join(p.strip() for p in parts if p)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


@dataclass
class ManasSnapshot:
    """住相 (per-round snapshot)。

    设计原则 (docs/snapshot-sop.md):
    - 50-150 token, 第一人称, 价值理性
    - 不持久化文本 (隐私反转 Lesson 14), 只存 metrics
    - mode: 'A' (正常) / 'B' (降级) / 'B-reuse' (B 模式复用)
    - evolution_skipped: True 表示 B 模式下未轮, 仅复用 seed + "(轮 N)"
    - retry_count: 本轮 retry 次数 (0-3)
    """

    timestamp: str  # ISO timestamp
    session_id: str  # 对话 session 标识
    snapshot_text: str  # 50-150 token 文本 (memory only, 不存盘)
    tokens_estimate: int
    mode: str  # 'A' | 'B' | 'B-reuse'
    evolution_skipped: bool
    cycle_id: str  # 依赖的末那识 cycle
    prev_snapshot_hash: str  # 上轮 seed 的 hash
    model: str
    generation_time_ms: int = 0
    fallback_used: bool = False
    retry_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_metrics_dict(self) -> dict[str, Any]:
        """存储到 metrics 的 dict (不含 snapshot_text, 隐私)。"""
        return {
            "timestamp": self.timestamp,
            "session_id": self.session_id,
            "tokens_estimate": self.tokens_estimate,
            "mode": self.mode,
            "evolution_skipped": self.evolution_skipped,
            "cycle_id": self.cycle_id,
            "prev_snapshot_hash": self.prev_snapshot_hash,
            "model": self.model,
            "generation_time_ms": self.generation_time_ms,
            "fallback_used": self.fallback_used,
            "retry_count": self.retry_count,
        }

    @classmethod
    def from_metrics_dict(cls, data: dict[str, Any]) -> "ManasSnapshot":
        """从 metrics dict 重建 (snapshot_text 为空, 因未持久化)。"""
        return cls(snapshot_text="", **data)


def current_cycle_id(today: str | None = None) -> str:
    """计算当前 5 天周期 ID。

    周期起点 = 2026-08-30 (Phase 0 起始日)
    每 5 天一个 cycle (Sun-Thu / Fri-Sat...) - 简单 floor to 5-day buckets
    """
    from datetime import timedelta

    if today is None:
        today = datetime.now().strftime("%Y-%m-%d")
    start = datetime(2026, 8, 30)
    end = datetime.strptime(today, "%Y-%m-%d")
    days = (end - start).days
    cycle_index = days // 5
    cycle_start = start + timedelta(days=cycle_index * 5)
    cycle_end = cycle_start + timedelta(days=4)  # 5 天周期的最后一天
    return f"{cycle_start.strftime('%Y-%m-%d')}_{cycle_end.strftime('%Y-%m-%d')}"