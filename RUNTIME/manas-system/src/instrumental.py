"""
住相质量校验工具。

检测:
- 中文 (避免乱码 / 英文误入)
- 第一人称 ("我作为" / "我看到"...)
- 黑名单 (工具型词 + 第二人称 + AI 自指)
- 长度 (50-150 token 估算)

参考:
- docs/snapshot-sop.md 第 6 节 质量检查
- prompts/snapshot_minimal.txt (输出风格)

设计: 失败检测返回 'reason', 供 retry policy 决定是否重试
"""
from __future__ import annotations

import re
from typing import Optional


# 工具型黑名单 (Lesson: {ASSISTANT}味 ≠ 工具味)
INSTRUMENTAL_BLACKLIST = [
    "应该", "让我", "必须", "下一步", "首先", "建议", "或许",
    "可以", "需要", "大概", "思考如下", "先从", "然后", "最后",
    "作为一个AI", "作为AI", "作为AI助手", "AI助手",
    "您的", "你好", "请问", "如果我", "如果我理解",
    # 第二人称禁止 (住相是关于我, 不是面向{USER}的回应)
    "你需要", "你应该", "你可以", "你可能",
]

# 第二人称严格禁 (不直接出现 '你' / '您' 单字, 因可能出现在 '{USER}' 上下文)
SECOND_PERSON_BLACKLIST = ["你", "您"]  # 单独成词

# 第一人称标识 (必须至少 1 个)
FIRST_PERSON_MARKERS = [
    "我作为", "我看到", "我意识到", "我感受到", "我察觉到",
    "我是", "我有", "我知", "我想", "我",  # 单字 "我" 兜底
]

# 中文检测 (含中文字符)
CHINESE_RE = re.compile(r"[\u4e00-\u9fff]")


def validate(snapshot_text: str) -> Optional[str]:
    """校验住相文本, 返回 None (通过) 或失败原因 (字符串)。

    顺序:
    1. 中文检测 (硬要求)
    2. 长度检测 (50-150 token)
    3. 第一人称检测 (硬要求)
    4. 黑名单检测 (软: 出现即触发 retry_with_negative_example)
    """
    if not snapshot_text or not snapshot_text.strip():
        return "empty_response"

    text = snapshot_text.strip()

    # 1. 中文检测
    chinese_chars = len(CHINESE_RE.findall(text))
    total_chars = len(text)
    if total_chars > 0 and chinese_chars / total_chars < 0.5:
        return "non_chinese"

    # 2. 长度检测 (50-150 token, 中文字符 ~1.5 char/token)
    # 实际 75-225 chars for 50-150 token
    char_count = len(text)
    if char_count < 30:  # 太短 (< 50 token 估算)
        return "too_short"
    if char_count > 280:  # 太长 (> 150 token 估算)
        return "too_long"

    # 3. 第一人称检测
    has_first_person = any(marker in text for marker in FIRST_PERSON_MARKERS)
    if not has_first_person:
        return "no_first_person"

    # 4. 黑名单检测
    for word in INSTRUMENTAL_BLACKLIST:
        if word in text:
            return f"instrumental_vocab:{word}"

    # 5. 第二人称严格禁 (避免 '你' 单字)
    # 但允许 "{USER}" - {USER}是名字, 包含 '大' 不包含 '你'
    # 检查单独的 "你" / "您" (中文没有 \b, 直接 in 检查 + 上下文感知)
    for word in SECOND_PERSON_BLACKLIST:
        # 直接 in 检查 (中文文本里 \b 失效)
        if word in text:
            return f"second_person:{word}"

    return None


def token_estimate(text: str) -> int:
    """粗估 token 数 (1 token ≈ 1.5 中文字)。"""
    chinese_chars = len(CHINESE_RE.findall(text))
    other_chars = len(text) - chinese_chars
    return int(chinese_chars / 1.5 + other_chars / 4)


def truncate_at_sentence(text: str, max_chars: int = 280) -> str:
    """在句子边界截断 (句号 / 问号 / 感叹号)。"""
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    for boundary in ["。", "！", "?", "?", "!"]:
        idx = truncated.rfind(boundary)
        if idx > max_chars - 80:  # 边界接近末尾
            return truncated[:idx + 1]
    return truncated + "..."


def contains_instrumental(text: str) -> bool:
    """快速检测是否含工具型词 (供 retry policy 用)。"""
    return any(w in text for w in INSTRUMENTAL_BLACKLIST)