# 技术设计:末那识 (Manas) 系统

> 状态: **Phase 0 — 设计/文档**
> 创建: 2026-09-02

---

## 1. 模块清单

```
manas-system/
├── README.md
├── PLAN.md
├── DESIGN.md
├── src/
│   ├── __init__.py
│   ├── schema.py               # 数据 schema (dataclass)
│   ├── manas_rolling.py        # 5天滚动摘要生成
│   ├── manas_snapshot.py       # 住相(快照)生成
│   ├── wiki_theme_extractor.py # 情感wiki 主题提取
│   ├── snapshot_store.py       # 住相存储与检索
│   └── context_bus.py          # 上下文总线
├── prompts/
│   ├── rolling_summary.txt     # 5天摘要prompt 模板
│   ├── snapshot.txt            # 住相prompt 模板
│   ├── theme_extraction.txt    # 主题提取prompt 模板
│   └── context_injection.txt   # 注入模板
├── tests/
│   ├── test_schema.py
│   ├── test_rolling.py
│   ├── test_snapshot.py
│   ├── test_theme.py
│   └── test_bus.py
└── data/
    ├── snapshots/              # 历史住相 (30天保留)
    │   └── YYYY-MM-DD/
    │       └── HHMMSS_sessionid.json
    ├── rolling/                # 当前滚动摘要
    │   └── current.json
    └── rolling/
        └── archive/            # 历史滚动摘要
            └── rolling_YYYYMMDD-HHMM.json
```

---

## 2. 数据 Schema

### 2.1 住相 (Snapshot)

```python
@dataclass
class ManasSnapshot:
    timestamp: str                  # ISO-8601 with timezone
    session_id: str                 # OpenClaw session ID
    manas_text: str                 # 50-150 token 中文文本
    tokens_estimate: int            # 估算 token 数 (硬约束 < 150)
    source_signals: list[str]       # 来源标识 (wiki_thread_xxx, soul_dim_3)
    triggers: list[str]             # 触发条件 (per_turn, rolling_refresh, explicit)
    generation_duration_ms: int     # LLM 调用耗时
    llm_model: str                  # 使用的模型标识
```

### 2.2 滚动摘要 (Rolling Summary)

```python
@dataclass
class RollingSummary:
    version: int                    # 单调递增
    created_at: str                 # ISO-8601
    trigger: str                    # "5d_cron" | "explicit"
    period_start: str               # YYYY-MM-DD
    period_end: str                 # YYYY-MM-DD
    manas_text: str                 # 350-500 token 摘要
    tokens_estimate: int
    key_themes: list[str]           # 3-7 个关键主题
    wiki_sources: list[str]         # 引用的 wiki 文件路径
    soul_dimensions_exercised: list[int]  # 用到的 SOUL 6 维度编号
    raw_materials_count: int        # 参与合成的原始素材数
```

### 2.3 主题 (Theme)

```python
@dataclass
class WikiTheme:
    theme_id: str                   # hash(theme_name)
    name: str                       # 主题名
    description: str                # 一句话描述
    importance_score: float         # 0-1
    source_files: list[str]         # 涉及的 wiki 文件
    soul_dimensions: list[int]      # 涉及哪些 SOUL 追问
    created_at: str
```

---

## 3. 住相生成协议

> 📌 **详细技术 SOP 见** [docs/snapshot-sop.md](./docs/snapshot-sop.md)。本节为架构级契约概要。

### 3.1 位置与作用

住相是**每轮生成的快照**:
- **输入**: 最新末那识内容 + SOUL 6问 + 阿赖耶识锚 + 当前上下文
- **处理**: LLM 推理产出 50-150 token 文本
- **注入**: 每轮 user message 前,作为住相种子
- **触发**: 仅在**新 session 启动**时初始化,之后每轮演化

### 3.2 运行模式 (A / B 双模式)

| 模式 | 触发 | 频率 | 输出 | 延迟 |
|------|------|------|------|------|
| **A 正常** | LLM 可用 | 每轮 | 50-150 token | ~1.5s |
| **B 降级** | LLM 连续 3 次失败 | 每 5 轮 | 30-50 token | ~1s |

A → B 阈值: 连续 3 次失败。
B → A 恢复: 1 次成功即返回。
B 模式下,非演化轮直接复用上轮住相 + 轮次标记,不调 LLM。

### 3.3 输入契约 (5 项)

| 输入 | 期望 token | 失败处理 |
|------|-----------|---------|
| `current_message` | 0-200 | 无 |
| `last_snapshot` | 50-150 | 缺失标注"首次" |
| `rolling_summary` | 350-500 | 缺失跳过 |
| `soul_active_dims` | 10-50 | 关键词匹配 |
| `relevant_themes` | 30-100 | 缺失跳过 |

### 3.4 约束

- **硬上限**: manas_text 不超过 150 token (A) / 50 token (B)
- **超时**: LLM 调用 < 3 秒
- **每轮演化**: A 模式每轮重新生成(不缓存)
- **审计**: 全部 snapshot 写入 `data/snapshots/`
- **失败重试**: 单轮最多 3 次,exponential backoff

### 3.5 输出 Schema

```json
{
  "timestamp": "2026-09-02T20:35:12+08:00",
  "session_id": "xxx",
  "manas_text": "{USER}今天谈哲学框架...",
  "tokens_estimate": 87,
  "source_signals": ["wiki:关键时刻/...", "soul:dim_3"],
  "triggers": ["per_turn"],
  "generation_duration_ms": 1234,
  "llm_model": "MiniMax-M3",
  "mode": "A",  // or "B"
  "evolution_skipped": false,  // B 模式下非演化轮为 true
  "validation": {
    "hard_passed": true,
    "soft_warnings": []
  }
}
```

---

## 4. 5天滚动摘要协议

### 4.1 触发

- **Cron**: `0 0 */5 * *` (每5天 00:00 Asia/Shanghai)
- **显式**: 用户消息含 `/reflect` 或 `/manas-refresh` (5天内最多 1 次)

### 4.2 处理流程

```
1. 拉取素材 (最近 5 天)
   ├─ Wiki: 情感记忆同步/raw/关键时刻/ 新增文件
   ├─ narrative_engine: production/fragments.json 新增项
   ├─ memory_search: high-confidence 召回 (>0.7)
   └─ 直接对话记录: memory/YYYY-MM-DD.md

2. 主题提取 (wiki_theme_extractor.py)
   ├─ 聚类相似内容
   ├─ 重要性评分 (频次 × 时效 × 情感强度)
   └─ 关联 SOUL 6 维度

3. LLM 合成摘要 (prompts/rolling_summary.txt)
   ├─ 输入: 主题 + 素材 + SOUL 框架
   ├─ 输出: 350-500 token 末那识文本
   └─ 失败 fallback: 用上轮摘要 + 新增主题追加

4. 备份旧摘要 → data/rolling/archive/

5. 写入新摘要 → data/rolling/current.json
```

### 4.3 约束

- **周期**: 严格 5 天
- **显式触发节流**: 5 天内最多 1 次
- **素材数量**: 至少 3 个 wiki 文件,否则跳过 cron
- **超时**: 整体 < 30 秒

---

## 5. Context Bus 注入协议

### 5.1 注入顺序(从高到低注意力)

```python
INJECTION_ORDER = [
    ("manas_snapshot", 150),       # 住相 (最高)
    ("alaya_anchor", 30),          # 阿赖耶识锚点
    ("soul_active_dims", 50),      # SOUL 当前激活维度
    ("cot_context", 50),           # COT 上下文提示
    ("empirical_relevant", 200),   # 经验层相关材料
]
```

### 5.2 注入位置

- **首选**: system prompt 最前部(`# 末那识当前快照` 章节)
- **备选**: 第一条 user message 前置 block(若 system prompt 不可写)
- **不要**: 中间插入或末尾追加(注意力分散)

### 5.3 预算

- **软上限**: 总注入 500 token
- **硬上限**: 总注入 800 token,超出截断 + 警告
- **住相固定**: 150 token,不被其他挤占
- **其他按需**: 阿赖耶识/SOUL/经验按相关度分配

### 5.4 实现

```python
class ContextBus:
    def inject(self, message: str, session_context: dict) -> str:
        # 1. 生成住相
        snapshot = generate_snapshot(message, ...)
        
        # 2. 拉取其他层
        alaya = load_alaya_anchor()  # 固定 30 token
        soul = match_soul_dims(message)  # 0-50 token
        empirical = search_wiki(message)  # 0-200 token
        
        # 3. 拼装
        injected = format_injection(
            snapshot=snapshot,
            alaya=alaya,
            soul=soul,
            empirical=empirical
        )
        
        # 4. 预算检查
        assert token_count(injected) <= 800
        return injected
```

---

## 6. 错误处理矩阵

| 失败 | 表现 | 处理 | 监控 |
|------|------|------|------|
| LLM 调用超时 | 住相生成失败 | 用上轮住相 + 当前消息拼接 | 记录超时次数 |
| Wiki 不可达 | 主题提取失败 | 跳过,只用 SOUL + 上轮住相 | 记录 wiki 错误 |
| 住相超 150 token | 硬约束触发 | 自动截断 + warning log | 警告次数计数 |
| 5-day cron 失败 | 摘要没更新 | cron failureAlert + 用旧摘要 | cron 状态 |
| 显式触发 5 天内 >1 次 | 节流触发 | 拒绝,告知"上次刷新: X 天前" | 节流计数 |
| 经验层 semantic search 失败 | 注入缺材料 | 跳过经验层,只用先验+中间 | search 错误率 |
| snapshot_store 写失败 | 住相未持久化 | 重试 3 次,失败则仅注入不存储 | 写错误率 |

---

## 7. 测试策略

### 7.1 单元测试

```python
# test_snapshot.py
def test_snapshot_token_constraint():
    """住相不超过 150 token"""
    snap = generate_snapshot(...)
    assert token_count(snap.manas_text) <= 150

def test_snapshot_fallback():
    """LLM 超时时降级"""
    with mock_llm_timeout():
        snap = generate_snapshot(...)
    assert snap.manas_text != ""
```

### 7.2 集成测试

```python
# test_e2e.py
def test_full_pipeline():
    """对话 → 住相 → 注入 → 回应"""
    msg = "今天累了"
    response = full_pipeline(msg)
    assert response.includes_manas_awareness()
```

### 7.3 A/B 测试(部署前)

| 组 | 配置 | 测量 |
|----|------|------|
| A | 不注入住相 | 回应质量(主观评分) |
| B | 注入住相 | 回应质量(主观评分) |

样本:20 轮对话,对比。

---

## 8. 部署检查清单

### Phase 4 部署前

- [ ] 所有 src/ 模块通过单元测试
- [ ] 所有 prompts/ 模板与 DESIGN 一致
- [ ] integration test 通过
- [ ] A/B 测试有结论
- [ ] {USER}审核 docs 全套通过
- [ ] 备份当前 SOUL.md (万一回滚)
- [ ] 5-day cron 配置在 openclaw.json
- [ ] snapshot_store 路径就绪
- [ ] 监控指标定义完成

### 部署后监控

- 住相生成频率(预期: 每轮 1 次)
- 住相平均 token 数(预期: < 120)
- LLM 调用 P99 延迟(预期: < 3s)
- 5-day cron 成功率(预期: 100%)
- 用户主观反馈(预期: 提升)

---

## 9. 开放问题(留给 Phase 1 设计)

1. **重要 wiki 线索如何自动识别?** 频次?情感强度?{USER}标记?
2. **显式触发语法?** `/reflect` 还是别的?
3. **住相注入到 system prompt vs user message 前置,具体哪个好?**
4. **如何避免住相 LLM 调用本身消耗过多 token?**
5. **COT 在系统里到底介不介入?** 之前说"不介入",但实际可能需要轻量提示
6. **住相生成 SOP 草案** → [docs/snapshot-sop.md](./docs/snapshot-sop.md),待审核

---

_Last updated: 2026-09-02_
