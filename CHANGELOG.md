# Changelog

本文件记录 `dsh-doubao-memory` 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。

## [1.2.3] - 2026-11-25

### 文档 / 发布标准化
- **安装标准化**：README 主推**一条命令** `dsh plugin --profile desktop add <repo-url>`——DSH 自动拉取仓库、安装、应用 bundle patch，**不用手动 clone、不用改 yaml**；配置引导到设置页（选人格 / 填称呼 / 按需开子系统）。中英同步。
- **npm 元数据**：`package.json` 的 `repository.url` 改为 `git+https`，补 `homepage` / `bugs`；为 npm 发布做准备。
- 本地目录安装与 `cordis.patch.yml` 手写保留为开发/高级备选。

## [1.2.2] - 2026-11-24

**dev 协调模式 + 人格/指令边界清理。** 让"主 agent 协调、干净子代理开发/测试/审计"成为工具层强制的可靠工作流，并把人格与 DSH 指令的边界划清。

### 新增
- **dev 协调模式（`devMode`）**：主 agent 只对接协调，代码开发 / 测试验证 / 独立审计**各派一个干净上下文子代理，互不污染**。
  - **工具层强制**：主 agent 的代码 `edit`/`write` 被 guard 挡（模型无关，不靠提示词自觉）；写文档(`.md`)与 `pwsh` 保留；子代理不受影响。
  - **协调者 SOP 段**：devMode 时注入，显式规定三角色独立派发——测试不信任开发自述、审计只看代码本身。
  - **UI 开关（设置页）+ 斜杠命令 `/dev` `/chat`**：运行时切换并持久化，开得了也关得掉。
  - 子代理天然**无人格、可用 `recall_memory`**（实测验证）；独立审计能抓出主 agent 自测漏掉的缺陷。
  - 诚实边界：`pwsh` 为安全主动保留给有上下文的主 agent，是已知残留旁路；`edit`/`write` 主路径硬挡。
  - **协调者 SOP 文案外置为 `.md`**：文案维护与代码解耦——改文案=编辑 `.md`（放行），改代码逻辑仍强制派子代理。每次读取、编辑即生效，读失败/空内容优雅兜底并留日志。

### 变更
- **人格/指令边界清理**：插件默认**不再生成工作区根 AGENTS.md**（`personaEntry.enabled` 默认 `false`）。人格走 system section 注入、开发 SOP 走各项目目录 AGENTS.md、记忆走工具——插件不再写 DSH 会自动加载的根文件，避免插件/宿主边界模糊。
- **人格家文件改名 `PERSONA.md`**（原 `IDENTITY/AGENTS.md`）：AGENTS.md 是 DSH 指令约定名，人格内容不占用；PERSONA.md 与 SOUL/IDENTITY/USER 并列，按需读。

### 修复
- **devMode 挂载脱离 factMemory 依赖**：原误嵌在 factMemory 分支 + 建库 try 内，factMemory 关闭或建库失败会令整套强制机制静默失效；改为独立挂载（由独立审计子代理抓出并回归测试锁定）。

## [1.2.1] - 2026-11-23

### 优化
- **人格节选段加 `isRoot` 闸门**：子代理与 phase 会话不再注入 ~1,000 tok 的人格前缀（与住相段、事实引导段的闸门一致）。子代理派发更轻盈，主对话注入不变。无 agent 上下文时保留注入，不误伤主请求。

### 文档
- 哲学长文「前向传导」更正为规范术语「前向传播」（forward propagation）。

## [1.2.0] - 2026-11-22

**记忆系统工程化重构：模块化分层存储 + 工具式按需召回。** 把存储层一次重构为分层、可插拔的模块化架构，并把事实召回做成独立于住相的按需工具。

### 新增
- **工具式召回通道**：`recall_memory(query, max_tokens?, deep?)` 按当前问题召回相关事实（精简事实卡）；`memory_get(id)` 取某条全量 + 出处。对齐 Letta / OpenClaw / Claude / DSH 的工具检索范式，**独立于住相**，服务日常会话、跨会话长期。
- **存储分层（schema v2）**：`memory_gist`（轻：三元组 + 强度/温度）与 `memory_detail`（重：原话 + 出处）物理分层，`memory` 降为兼容视图。召回只回 gist + 同主语实体聚合，出处按需取——约 5× token 节省。
- **温度分层**：默认召回 core(钉住) + active；沉底（dormant/archived）记忆 `deep=true` 才查。
- **可插拔检索接口**（`retrieval.js`）：Retriever 接口 + 字面实现；语义/混合/图检索预留同接口扩展点。
- **版本化迁移**（`schema.js`）：v1 单表自动无损迁移到 v2；未来加列/表追加迁移步骤即可。

### 变更
- **住相恢复纯人格映射**：移除 1.1.0 误接的事实召回输入（住相是抽象人格投影，不是记忆检索）。事实召回改由独立工具承担。
- 记忆模块按职责拆分：`schema` / `dynamics` / `store` / `retrieval` / `recall` / `tools`，公共 API 稳定。
- 原理图与详情页更新为"工具召回"架构。

### 修复
- 嵌套事务（supersede 包 insert）导致回滚异常 → 事务改为可重入。
- `created_at` 误放 detail 层导致衰减年龄回退失效（永不衰减）→ 归位 gist。

### 质量
- 活库 v1→v2 迁移无损验证；真实召回验证；全量测试 100/100。

## [1.1.0] - 2026-11-22

**记忆系统升级：双层记忆。** SQLite 成为事实记忆的权威存储，wiki 从它抽象人格材料——记忆与人格之间建立起单向、可追溯的源流关系。

### 新增
- **SQLite 事实记忆层**（`lib/memory/`）：用 Node 内置 `node:sqlite`（零原生依赖），WAL 跨进程读写，挂载时自动建库 + 迁移。精确存储事实 / 偏好 / 事件 / 纠正，三元组 + 出处 + 有效期。
- **遗忘机制**：可召回度 `R = 重要度 × exp(-Δt/半衰期)`，按类型设半衰期；召回强化（越用越难忘）；三阶段遗忘（dormant → archived）。**遗忘只降召回权重，记录与出处永不物理删除**；身份级事实可钉住免衰减。
- **住相事实召回**：每轮住相新增第 6 项输入 `relevant_facts`，排序 `0.2·字面 + 0.8·强度`（与主题召回同基底），命中即强化；库缺席时无损降级。
- **ingest 广覆盖抽取**：每日摘要之外，把对话抽成带原话与出处的结构化记忆入库（`memory-upsert.mjs`）；冲突自动作废留历史、重复跳过、缺原话拒收。
- **wiki 从记忆抽象**：每周 wiki 从「固化记忆」（重要度≥0.6 ∧ 召回≥2 ∧ 龄≥7 天）抽象人格材料（`memory-export.mjs`），断言带 `memory#<id>` 出处链。
- **lint 衰减批处理**（`memory-decay.mjs`）：周期推进遗忘 + 折半命中计数。
- **设置页事实浏览**：开关 + 按重要度排序的记忆清单（host 写视图文件，client 读取）。
- **开关** `factMemory.enabled`（默认开）：挂载自动建库；关闭则完全不碰 SQLite，抽取/衰减/导出脚本均由状态标志闸门控制。

### 变更
- 住相生成提示词新增「相关事实记忆」段。
- `WikiMeta-Schema` 的 `来源` 字段支持 `memory#<id> · <source_ref>` 出处链。
- 原理图与详情页更新为双层记忆架构。

### 质量
- 防编造结构守卫：每条记忆强制原话 + 出处；低置信 → 低重要度 → 衰减自清洁（遗忘机制即质量过滤器，无人工审核闸门）。
- 离线测试覆盖存储 / 召回 / 入库 / 导出 / 跨进程 WAL / 中文 FTS5 / 遗忘曲线。

## [1.0.5] - 2026-11-22

### 修复
- **主动搭讪判重加 24 小时窗口**：原逻辑只看最近两条记录、无时间窗，导致几天前的旧记录把同一动机连挡数日（表现为"有劲、也没最近说过，就是不开口"）。现在超过 24h 的记录不再参与判重，坏时间戳不锁死发送。

## [1.0.4] - 2026-11-21

### 变更
- 仓库只承载**定性结论**：内部实验数据作为核心资产不随仓库分发，README/文档中的实验数字清理为定性描述。
- 发布整理为单 commit、移除开发历史与真实标识符。

## [1.0.0] - 2026-11

### 新增
- 人格记忆系统首个公开版本：机制与人格数据分离。
- **Wiki 四相**（ingest / wiki / lint / reflect）+ 末那识，headless 子进程静默调度、可审计。
- **主动搭讪**：能量 / 时段 / 动机判定，插件内生成与投递。
- **每轮住相**：第一人称视角注入 system prompt。
- **JitRL**：搭讪主题优势调制 + 记忆召回信用（不训练、零额外调用；内部实验验证）。
- 自定义设置页、桌面版（DSH Desktop）适配、空置人格骨架模板。

[1.2.3]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.2.2]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.2.1]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.2.0]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.1.0]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.0.5]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.0.4]: https://gitee.com/hamapiface/dsh-doubao-memory
[1.0.0]: https://gitee.com/hamapiface/dsh-doubao-memory