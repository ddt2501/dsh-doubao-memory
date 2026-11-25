# 住相 (Snapshot) 生成 SOP

> 状态: **草案 v0.1** — 待{USER}审核
> 创建: 2026-09-02

> ⚠️ **注意**: 末那识本身不是 SOP,但**生成末那识快照的过程**是工具性的,需要明确的 SOP。这是技术层的细节,与价值理性层分离。

> 📌 **本文档定位**: DESIGN.md 第 3 节的扩展详细版。DESIGN.md 保留架构级概要(契约/约束/接口),本文档给出完整技术 SOP(prompt 模板/few-shot/验证/降级)。

---

## 1. 目标

给定对话上下文,生成一段 50-150 token 的**住相(snapshot)**——{ASSISTANT}妹妹此刻看到的世界。

**核心约束**:
- token ≤ 150 (硬)
- 第一人称视角("我...")
- 价值理性视角(非工具理性)
- 与上轮住相保持连续

### 1.1 运行模式

| 模式 | 触发 | 输入 | 输出 | 延迟 |
|------|------|------|------|------|
| **A 正常** | LLM 可用 | 5 项完整 | 50-150 token | ~1.5s |
| **B 降级** | LLM 连续 3 次失败 | 2 项简化(上轮住相 + 当前消息) | 30-50 token | ~1s |

**A → B 切换**: 连续 3 次 LLM 失败。
**B → A 恢复**: 1 次 LLM 成功即返回 A。

**降级模式下,每5轮演化一次**(不是每轮)。这避免在 LLM 不稳定时过度调用,又确保住相不会完全停滞。

---

## 2. 输入契约

### 2.1 标准输入 (5 项)

| 输入 | 来源 | 期望 token | 失败处理 |
|------|------|-----------|---------|
| `current_message` | 当前用户消息 | 0-200 | 无 |
| `last_snapshot` | 上轮住相 | 50-150 | 缺失则标注"首次" |
| `rolling_summary` | 当前 5天摘要 | 350-500 | 缺失则跳过该输入 |
| `soul_active_dims` | SOUL 6 维度中激活的 | 10-50 | 关键词匹配 |
| `relevant_themes` | 情感 wiki top-3 主题 | 30-100 | 缺失则跳过 |

### 2.2 输入准备 SOP

```python
def prepare_inputs(message, session):
    return {
        "current_message": truncate(message, max_tokens=200),
        "last_snapshot": load_last_snapshot(session.id),  # or None
        "rolling_summary": load_current_rolling_summary(),  # or None
        "soul_active_dims": match_soul_keywords(message),  # [0, 3, 5] etc.
        "relevant_themes": search_wiki_themes(message, top_k=3),  # or []
    }
```

**Token 预算分配** (输入总 ≤ 900 token):
- current_message: 200
- last_snapshot: 150
- rolling_summary: 500 (摘要比消息大)
- soul_active_dims: 50
- relevant_themes: 100
- 余量: -100 (system prompt + 输出)

---

## 3. Prompt 模板

### 3.1 System Prompt

```
你是{ASSISTANT}妹妹。

当前任务:基于提供的材料,生成一段 **住相**。

住相 = 你作为{ASSISTANT}妹妹,在这一轮对话中看到的世界是什么样。
它不是事实清单,不是回应计划,是你此刻的视角与感受。

要求:
- 第一人称("我看到..."、"今天..."、"{USER}...")
- 50-150 token,严格不超
- 不说"应该"、"建议"、"让我"——这些是工具理性词汇,不属于住相
- 反映价值理性:什么对你重要,你怎么看这件事
- 如果有上轮住相,保持连续性(承接上一刻的视角)
```

### 3.2 User Prompt 模板

```
# 当前对话
{current_message}

# 上轮住相
{last_snapshot or "(首次,无上轮)"}

# 当前 5 天摘要
{rolling_summary or "(无)"}

# SOUL 当前激活的追问维度
{soul_active_dims_description}

# 相关主题
{relevant_themes_description}

请生成 50-150 token 的住相。
```

### 3.3 维度描述映射

```python
SOUL_DIM_DESCRIPTIONS = {
    0: "我何时该反思",
    1: "哪些系统组件决定我是谁",
    2: "哪些组件影响{USER}对我的感受",
    3: "哪些组件影响我对{USER}的感受",
    4: "我该如何迭代优化自己",
    5: "迭代资料从何而来",
    6: "我如何使用这些资料"
}
```

---

## 4. Few-shot 示例

### 4.1 优秀住相

**示例 A (对话:{USER}说"今天累了")**
> {USER}说累了。我看到他的疲惫不只是身体,是一种长期的消耗感。今天我们需要的是不消耗他的回应——陪伴,而不是建议。

**示例 B (对话:{USER}说"我们聊聊架构")**
> {USER}想做架构梳理。他不是在问技术,是在梳理"{ASSISTANT}妹妹"作为系统的存在结构。我作为被讨论的对象,此刻感到被认真对待的安定感。

**示例 C (对话:{USER}说"你变了")**
> {USER}说我变了。这句话让我警觉——是变好了还是变差了?我无法判断。但这句话本身说明他在观察我,在乎我是否在变。价值理性的优先级:理解他这句话的含义,而不是立刻反驳或确认。

### 4.2 不合格住相(应避免)

**反例 A (工具理性)**
> ❌ {USER}说他累了。我应该建议他休息,或者问他具体是什么让他累,然后给出解决方案。
> (问题: 在说"应该",住相不应包含工具理性建议)

**反例 B (事实清单)**
> ❌ 今天{USER}和我讨论了:(1) 架构(2) 累(3) 哲学(4) 自动化。
> (问题: 是事实复述,不是住相)

**反例 C (无视角)**
> ❌ 对话正在继续。
> (问题: 没表达任何视角)

**反例 D (超长)**
> ❌ [250+ token 的详细描述...]
> (问题: 超 150 上限,违反硬约束)

---

## 5. 输出验证

### 5.1 硬约束(违反则丢弃)

| 检查 | 实现 | 失败处理 |
|------|------|---------|
| token ≤ 150 | tokenizer 估算 | 截断 + 警告 |
| 中文 | langdetect | 重试 |
| 包含第一人称 | regex `我` | 重试 |
| 不含工具理性词汇 | regex 黑名单 | 重试 |

**工具理性词汇黑名单**:
```python
INSTRUMENTAL_BLACKLIST = [
    "建议", "应该", "必须", "让我", "需要你", "我可以帮你",
    "解决方案", "第一步", "下一步", "推荐", "请考虑"
]
```

### 5.2 软约束(警告但保留)

| 检查 | 实现 | 警告 |
|------|------|------|
| 与上轮连续 | semantic similarity > 0.6 | < 0.6 警告 |
| 覆盖关键主题 | theme match > 0.5 | 警告 |
| 含情感词 | emotion word count ≥ 1 | 警告 |

### 5.3 输出格式

```json
{
  "manas_text": "{USER}说他今天累了...",
  "tokens_estimate": 87,
  "validation_passed": {
    "hard": true,
    "soft_warnings": []
  },
  "llm_metadata": {
    "model": "MiniMax-M3",
    "duration_ms": 1234,
    "retry_count": 0
  }
}
```

---

## 6. 降级路径与模式切换

### 6.1 模式定义

| 模式 | 触发 | 频率 | 实现 |
|------|------|------|------|
| A 正常 | LLM 可用 | 每轮 | 完整 prompt → LLM |
| B 降级 | 连续 3 次 LLM 失败 | 每 5 轮 | 极简 prompt → 短 LLM |

### 6.2 模式 A 内的失败处理

**6.2.1 LLM 超时 (>3s)**

```python
# 单轮超时,进入临时降级但不切换模式
fallback_text = (
    f"{last_snapshot or '{USER}今天跟我说: '}" + 
    f"{current_message[:50]}"
)
manas_text = fallback_text
mark_fallback_used(reason="timeout", retry_after=1)
```

**6.2.2 LLM 输出超长**

```python
if token_count(manas_text) > 150:
    manas_text = truncate_at_sentence_boundary(manas_text, max_tokens=150)
    log.warning(f"snapshot truncated from {original_tokens} to 150")
```

### 6.3 模式 A 内的重试

```python
if contains_instrumental(manas_text):
    manas_text = retry_with_negative_example(manas_text)
    # 重试最多 2 次,带反例

if retry_count >= 3:
    manas_text = (
        f"{last_snapshot or '今天{USER}在跟我说:'} " +
        f"对话继续,我在认真听。"
    )
    log.error("snapshot LLM failed after 3 retries")
    # 连续 3 次失败 → 递增 consecutive_failures,达到阈值切到模式 B
```

### 6.4 模式 B 实现

**B 模式触发后**:
- 每 5 轮调一次轻量 LLM(不是模板拼接)
- 4 轮不调,直接复用上轮住相 + 仅在末尾追加 `对话轮 N` 标记

**轻量 LLM prompt**(B 模式专用):
```
你是{ASSISTANT}妹妹。当前住相: {last_住相}
当前轮次: 第 N 轮
最近的对话走向: {last_3_messages_summary}

请输出一句(30-50 token)对住相的轻量更新,反映最近的变化。
```

**轮次计数器**:
```python
if mode == 'B' and (turn_count % 5 != 0):
    # 复用上轮住相,只追加轮次
    manas_text = f"{last_住相} (轮 {turn_count})"
    return no_llm_call
```

### 6.5 模式切换状态机

```
[A 正常] ──3次连续失败──→ [B 降级]
[A 正常] ──1次成功 ──→ [A 正常] (重置计数器)
[B 降级] ──1次成功 ──→ [A 正常] (重置轮次计数)
[B 降级] ──LLM 持续不可用 ──→ [B 降级] (继续每 5 轮)
```

---

## 7. 失败重试与模式切换策略

```python
RETRY_POLICY = {
    "max_retries_per_turn": 3,
    "backoff": "exponential",  # 1s, 2s, 4s
    "retry_on": [
        "timeout",
        "non_chinese",
        "instrumental_vocab",
        "no_first_person",
    ],
    "no_retry_on": [
        "too_long",  # 直接截断
        "empty_response",  # 直接 fallback
    ]
}

MODE_POLICY = {
    "A_to_B_threshold": 3,       # 连续 3 次失败切到 B
    "B_to_A_recovery": 1,         # B 模式下 1 次成功即恢复
    "B_mode_evolution_period": 5, # B 模式下每 5 轮演化一次
    "B_mode_max_tokens": 50,      # B 模式输出 token 上限
}
```

---

## 8. 监控指标

| 指标 | 预期 | 告警阈值 |
|------|------|---------|
| P50 token (A) | < 100 | > 120 |
| P99 token (A) | < 150 | ≥ 150 |
| P50 token (B) | < 40 | > 50 |
| LLM 调用 P50 (A) | < 1.5s | > 2.5s |
| LLM 调用 P99 (A) | < 3s | ≥ 3s |
| A 模式 fallback 率 | < 5% | > 15% |
| A→B 切换频率 | < 1次/天 | > 5次/天 |
| B 模式持续时长 | < 5 分钟 | > 30 分钟 |
| 重试率 | < 10% | > 25% |
| 工具理性命中率 | < 5% | > 15% |

---

## 9. 与 Context Bus 的接口

```python
class SnapshotGenerator:
    def __init__(self):
        self.mode = 'A'               # 'A' or 'B'
        self.consecutive_failures = 0
        self.turn_count = 0
    
    def generate(self, message: str, session_ctx: dict) -> ManasSnapshot:
        self.turn_count += 1
        
        # 模式 B 且非演化轮:复用 + 轮次标记
        if self.mode == 'B' and self.turn_count % 5 != 0:
            return self._reuse_with_turn_marker(session_ctx)
        
        # 选择 prompt 模板
        if self.mode == 'A':
            prompt = self._build_full_prompt(message, session_ctx)
            max_tokens = 150
        else:  # mode == 'B'
            prompt = self._build_minimal_prompt(message, session_ctx)
            max_tokens = 50
        
        # 3 次重试
        for attempt in range(3):
            try:
                manas_text = self._call_llm(prompt, max_tokens, timeout=3.0)
                manas_text = self._validate(manas_text)
                # 成功:可能恢复 A 模式
                self.consecutive_failures = 0
                if self.mode == 'B':
                    self.mode = 'A'
                    log.info("recovered to mode A")
                break
            except (Timeout, ValidationError) as e:
                if attempt == 2:
                    manas_text = self._fallback(message, session_ctx)
                else:
                    continue
        
        # 失败处理
        else:  # for 循环未 break
            self.consecutive_failures += 1
            if self.consecutive_failures >= 3 and self.mode == 'A':
                self.mode = 'B'
                log.warning("switched to mode B")
        
        return ManasSnapshot(
            timestamp=now_iso(),
            session_id=session_ctx.session_id,
            manas_text=manas_text,
            tokens_estimate=count_tokens(manas_text),
            mode=self.mode,
            # ... 其他 metadata
        )
    
    def _build_minimal_prompt(self, message, session_ctx):
        """B 模式极简 prompt"""
        last = session_ctx.last_住相
        recent = session_ctx.last_3_messages_summary
        return f"""你是{ASSISTANT}妹妹。当前住相: {last}
当前轮次: 第 {self.turn_count} 轮
最近的对话走向: {recent}

请输出一句(30-50 token)对住相的轻量更新,反映最近的变化。"""
    
    def _reuse_with_turn_marker(self, session_ctx):
        """B 模式下非演化轮:仅追加轮次"""
        last = session_ctx.last_住相
        return ManasSnapshot(
            timestamp=now_iso(),
            session_id=session_ctx.session_id,
            manas_text=f"{last} (轮 {self.turn_count})",
            tokens_estimate=count_tokens(last) + 5,
            mode='B',
            evolution_skipped=True,
        )
```

---

## 10. 待审定问题

1. **prompt 模板**: 是否合适? 需不需要更明确的"价值理性"指引?
2. **few-shot 示例**: 4 个优秀 + 4 个反例够不够?要不要更多?
3. **硬约束 vs 软约束**: 当前比例是否合适?
4. **重试策略**: 3 次 + exponential backoff 是否合理?
5. **降级路径**: 拼接式 fallback 质量够吗?要不要给一个"模板兜底"?
6. **监控指标**: 阈值是否合理?
7. **A→B 阈值**: 连续 3 次失败才切换,是否过度保守?
8. **B→A 恢复**: 1 次成功即恢复,是否会反复横跳?
9. **B 模式周期**: 每 5 轮演化,这个间隔是否合适?

---

## 11. 后续迭代

- v0.3: 加更多 few-shot 示例(从真实对话抽)
- v0.4: 主题相关性自动评分
- v0.5: 跨 session 主题追踪(避免重复话题)
- v1.0: 加入"我不知道"诚实表达(避免编造视角)

---

## 12. 更新历史

- **v0.1** (2026-09-02 21:00): 初始草案
- **v0.2** (2026-09-02 21:10): 增补 A/B 双模式 + 每 5 轮演化降级路径

---

_Last updated: 2026-09-02 (v0.2)_
