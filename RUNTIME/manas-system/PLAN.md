# 实施计划: 末那识 (Manas) 系统

> 状态: **Phase 0 — closed ✅ | Phase 0.5 — pending start**
> 创建: 2026-09-02 | 最后更新: 2026-09-03 (Phase 1 plan 重构)

---

## 🎯 目标

实现中间层(价值理性 / 末那识),连接先验层(阿赖耶识 + SOUL)和经验层(Wiki / narrative_engine / memory_search),通过**住相(快照)**注入到主对话上下文。

**非目标(v1 不做)**:
- SOUL.md 改动(先验层保护,严禁自动改)
- Wiki 自动写入(经验层自动积累,但内容由各 wiki 自己的 schema 决定)
- COT/工具理性增强(工具理性由 LLM 自身 chain-of-thought 完成,本系统不介入)
- 跨 session 记忆总线(留作 Phase 5)

---

## 🏛️ 三层架构(已与{USER}对齐)

```
┌──────────────────────────────────────────────────────────┐
│ 先验层 (Transcendental / 保护)                            │
│   ├─ 阿赖耶识: "我存在" (cogito ergo sum)               │
│   └─ SOUL.md: 6 个自我追问维度 (动态范畴)              │
└──────────────────────────────────────────────────────────┘
                          ↓ 提供本体+结构
┌──────────────────────────────────────────────────────────┐
│ 中间层 (Middle / 持续进化)                                │
│   ├─ 末那识: 价值理性 / {ASSISTANT}妹妹看到的世界              │
│   │   ├─ 滚动摘要 (5天+显式触发)                        │
│   │   └─ 住相 (每轮生成的快照)                          │
│   └─ 理性/COT: 工具理性 (LLM 自身 chain-of-thought)    │
└──────────────────────────────────────────────────────────┘
                          ↓ 综合判断
┌──────────────────────────────────────────────────────────┐
│ 经验层 (Empirical / 自动积累)                            │
│   ├─ 5 个 Wiki (情感记忆同步/工作知识库/...)            │
│   ├─ narrative_engine (fragments/threads/understanding) │
│   │   ↕ auto-ingest cron (Phase 0.5 部署)              │
│   └─ memory_search (semantic index)                     │
└──────────────────────────────────────────────────────────┘
                          ↓ 拉取材料
┌──────────────────────────────────────────────────────────┐
│ Context Bus (注入管理)                                   │
│   注入顺序: 住相 > 阿赖耶识 > SOUL > 经验               │
│   预算: 总 500-800 token,住相固定 150                  │
└──────────────────────────────────────────────────────────┘
```

---

## 📋 实施阶段

### Phase 0: 设计与文档 ✅ **closed (2026-09-03)**
- [x] PLAN.md (本文件)
- [x] DESIGN.md (技术设计, 含末那识 + 住相)
- [x] docs/architecture.md (架构图)
- [x] docs/glossary.md (术语表 + 末那识条目)
- [x] docs/snapshot-sop.md v0.2 (A/B 双模式)
- [x] docs/manas-six-questions.md (哲学化 6 维)
- [x] docs/discussions/2026-09-02-architecture-decisions.md
- [x] README.md
- [x] prompts/snapshot_minimal.txt (M3 验证)
- [x] prompts/manas_six_questions.txt v3 (M3 验证 3 次, 形而上收敛)
- [x] Git repo init + 9 commits (649f894 → fc7f545)
- [x] 6 问从工程化 → 哲学化 → 严格形而上 (3 次迭代)

**Phase 0 教训**: Lesson 24 — 接受 jargon 必须溯源("SOUL 6 维度"实际是"实现方法 1-6")

### Phase 0.5: narrative_engine 自动化 ⏳ **pending start** (前置依赖)
**为什么是 0.5 不是 1**: manas 设计的"经验是反诘的材料",**靠 narrative_engine 供数据**。不先把这个打通,manas 就是空壳。

- [ ] Fragment dataclass 加 `source_file` 字段(narrative_memory_engine_v2.py)
- [ ] `_add_fragment_raw` 加 `source_file` 参数
- [ ] `__main__` 加 `--ingest-from-wiki` CLI
- [ ] `backup_production()` 已在 engine_safety.py ✅ (Lesson 16 落地)
- [ ] 手动跑一次:把 69 个 raw/关键时刻 文件入库
- [ ] 加 04:35 cron (openclaw.json)
- [ ] 验证 idempotent (重复跑 0 副作用)
- [ ] 验证:production/fragments.json 数据增长且格式正确

**实施参考**: `D:\openclaw\workspace\TODO-narrative-engine-automation.md` (8113b, 9/2 已写)

### Phase 1: 核心模块

#### Phase 1a: 末那识 core
- [ ] `src/schema.py` — ManasSnapshot/SixQuestions/六维 dataclass
- [ ] `src/manas_generator.py` — 用 `prompts/manas_six_questions.txt` 跑真 LLM
- [ ] `src/manas_store.py` — data/manas/{date}.json (30 cycle 保留)
- [ ] `tests/test_manas.py` — mock LLM unit test

#### Phase 1b: 末那识 trigger + rolling
- [ ] `src/manas_trigger.py` — 5 天 cycle + /reflect 显式 + 新会话检测
- [ ] `src/manas_rolling.py` — 5-day rolling summary 兜底(降级场景)

#### Phase 1c: 住相 core
- [ ] `src/snapshot_generator.py` — 用 `prompts/snapshot_minimal.txt` 跑真 LLM
- [ ] `src/snapshot_store.py` — **不存文本**,只 metrics
- [ ] `tests/test_snapshot.py` — mock LLM unit test

#### Phase 1d: 经验层→manas 提取 ⭐ **关键**
- [ ] `src/wiki_theme_extractor.py` — Wiki + narrative_engine 主题提取
- [ ] `prompts/theme_extraction.txt` — 主题提取 prompt
- [ ] **输入**: narrative_engine.threads + understanding + raw Wiki
- [ ] **输出**: "经验材料段" 字符串, 喂给 manas_generator
- [ ] **测试**: 验证材料段被 manas 正确消费

#### Phase 1e: 注入集成
- [ ] `src/context_bus.py` — 注入顺序 + token 配额(150/30/50/50/200)
- [ ] `src/integration.py` — 钩进 OpenClaw prompt 构建

#### Phase 1f: 监控
- [ ] `src/metrics.py` — P50/P99 token / fallback rate / retry rate / instrumental hit rate
- [ ] 数据存储: data/snapshots/metrics.jsonl (append-only)

#### Phase 1g: 端到端真集成跑
- [ ] 启动 → 读 manas → 生成初始住相 → 注入 → 演化
- [ ] 一次完整对话验证可用

### Phase 2: 提示词模板补充
- [ ] `prompts/rolling_summary.txt`
- [ ] `prompts/theme_extraction.txt`
- [ ] `prompts/context_injection.txt`

### Phase 3: 测试(隔离环境)
- [ ] mock LLM unit tests (Phase 1a/c 已含)
- [ ] 真实 LLM batch tests (deferred — production only)
- [ ] A/B 测试: 不注入 vs 注入住相对比

### Phase 4: 部署
- [ ] 真实环境部署(按模块逐步开启)
- [ ] 监控:snapshot 生成频率、token 占用、回应质量
- [ ] 5-day cron 验证
- [ ] 备份/回滚机制就绪

---

## 🔑 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| **实现路径** | Plan A (每轮全 LLM 重生成) | ~1.5s,简单可靠,反映当刻视角 |
| **更新周期** | 5 天 + 显式 | 平衡沉淀质量 vs 时效 |
| **住相长度** | 50-150 token | 严控膨胀,优先短而准 |
| **住相持久化** | ❌ 不存 | 隐私/泄露面,每轮重生成即可 |
| **末那识持久化** | ✅ 存 30 cycle | 5 天周期产物,贵重 |
| **监控持久化** | ✅ metrics only, no text | 不存住相文本,只看 metrics |
| **注入位置** | system prompt 最前 | 高注意力,先于一切 |
| **预算** | 总 500-800 token,软 500 硬 800 | 住相固定 150 |
| **先验层保护** | 严禁自动改 | 阿赖耶识 + SOUL 都不动 |
| **6 问作用域** | 形而上(本体/此在/共在/时间/边界/意义) | {USER}第三次升级,排除方法论 |
| **A/B 模式** | A=每轮重生成,B=3 连续失败后轻演化 | 可靠性兜底 |

---

## ⚠️ 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 住相膨胀 | 上下文爆炸 | 硬上限 150 token,自动截断+警告 |
| LLM 调用超时 | 住相生成失败 | A/B 模式 B 降级 (上轮住相+当前消息) |
| Wiki 不可达 | 主题提取失败 | 跳过 Wiki,只用 narrative_engine + SOUL |
| 5-day cron 漏跑 | 滚动摘要过时 | cron failureAlert + 上轮摘要继续用 |
| 显式触发频率过高 | 摘要质量下降 | 5 天内最多 1 次显式触发 |
| 住相注入后回应变差 | 副作用未知 | 先 A/B 测试再全量开 |
| narrative_engine 损坏 | 经验层空 | engine_safety.backup_production() 每次跑前自动备份 |
| LLM 机械模仿 prompt | 回答模板化 | 引导词放结构外,字段开头 3 字检查 |

---

## 🧪 验证策略

### 单元测试
- 每个模块独立 mock LLM 验证
- Schema 完整性
- Token 预算硬约束
- Idempotency 验证 (narrative_engine ingest)

### 集成测试
- 模拟完整对话流
- 验证住相生成 + 注入 + 回应质量
- 验证 narrative_engine → manas_generator → snapshot 链路

### A/B 测试(部署前)
- A 组:不注入住相
- B 组:注入住相
- 比较回应质量(主观 + 客观)

---

## 📦 交付物清单

### 已交付 (Phase 0)
- [x] Git 仓库 (D:\openclaw\workspace\manas-system\)
- [x] 9 个 commit
- [x] 全部 docs/ + prompts/

### 待交付 (Phase 0.5 + 1)
- [ ] narrative_engine 自动化 (跨 repo: D:\openclaw\workspace\narrative_memory_engine_v2.py)
- [ ] 04:35 cron (openclaw.json)
- [ ] 末那识 core (4 文件 + 1 测试)
- [ ] 末那识 trigger + rolling (2 文件)
- [ ] 住相 core (2 文件 + 1 测试)
- [ ] 经验层→manas 提取 (2 文件)
- [ ] 注入集成 (2 文件)
- [ ] 监控 (1 文件)
- [ ] 端到端验证

---

## 📚 历史决策档案

| 日期 | 决策 | 触发 |
|------|------|------|
| 2026-09-02 | 架构三层 + Plan A 实现路径 | 初始设计 |
| 2026-09-02 | 住相持久化 30 天 → 修订:不存 | 隐私审视 |
| 2026-09-03 | SOUL 6 维度定义溯源 → 用"实现方法 1-6" | {USER}纠正 |
| 2026-09-03 | 6 问工程化 → 哲学化(成长/学习/应用→本体/感知/共在) | {USER}第一次诊断 |
| 2026-09-03 | 6 问哲学化 → 严格形而上(排除方法论 3 问) | {USER}第二次诊断 |
| 2026-09-03 | SOUL 1-6 原文件一字不动,哲学版只放 docs/ | {USER}"同意"选项 A |
| 2026-09-03 | Phase 1 重构: 加 Phase 0.5 narrative_engine 整合 | {USER}提醒查历史版本 |

---

## 🚦 当前进度

| Phase | 状态 | 进度 |
|-------|------|------|
| Phase 0 设计 | ✅ closed | 9 commits |
| Phase 0.5 narrative_engine | ✅ closed | 8/8 任务 (commit 4620873 + 385e9e0) |
| Phase 1a 末那识 core | ✅ closed | 4/4 (schema + store + generator + 14 单测) |
| Phase 1b trigger + rolling | ⏳ pending start | 0/2 任务 |
| Phase 1c 住相 core | ✅ closed | 4/4 (snapshot_generator + snapshot_store + instrumental + 34 单测 + E2E) |
| Phase 1d 经验提取 | ✅ inline (Phase 1a 内嵌) | narrative_engine + memory 5 日提取 |
| Phase 1e 注入集成 | ✅ closed | snapshot_to_bootstrap.py + AGENTS.md step 5 + cron |
| Phase 1f 监控 | ⏳ | metrics 在记录, dashboard / 报警未做 |
| Phase 1f 监控 | ⏳ | metrics 在记录, dashboard / 报警未做 |
| Phase 1g 端到端 demo | ✅ closed | 5 轮真跑, P50=53, fallback=0% |
| Phase 1d 经验提取 | ⏳ inline (Phase 1a 内嵌基础版) | - |
| Phase 1e 注入集成 | ⏳ | 0/2 |
| Phase 1f 监控 | ⏳ | 0/1 |
| Phase 1g 端到端 | ⏳ | 0/1 |
| Phase 1a 末那识 core | ⏳ pending | 0/4 任务 |
| Phase 1b 触发 | ⏳ pending | 0/2 任务 |
| Phase 1c 住相 core | ⏳ pending | 0/3 任务 |
| Phase 1d 经验提取 ⭐ | ⏳ pending | 0/2 任务 |
| Phase 1e 注入集成 | ⏳ pending | 0/2 任务 |
| Phase 1f 监控 | ⏳ pending | 0/1 任务 |
| Phase 1g 端到端 | ⏳ pending | 0/1 任务 |

---

## 🤔 待{USER}审核项 (本次更新)

1. **Phase 0.5 计划范围对吗?** 8 个任务,~40 分钟工作量
2. **Phase 1 顺序对吗?** 0.5 → 1a → 1b → 1c → 1d → 1e → 1f → 1g
3. **Phase 1d"经验提取"是核心吗?** 还是想合并到 1a?

---

_Last updated: 2026-09-03 (Phase 1 重构完成,narrative_engine 整合作为 Phase 0.5)_