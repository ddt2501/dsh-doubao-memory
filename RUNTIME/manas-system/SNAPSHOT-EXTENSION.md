# 住相扩展接口（预留 · 未实现）

> 2026-11-08 留。**当前没有任何代码实现 per-turn 住相**。
>
> 本文件是**接口占位**，记录原设计契约与未来接入点，方便将来实现时不丢设计意图。
> 原设计全文：[`docs/snapshot-sop.md`](docs/snapshot-sop.md)（v0.2，2026-09-02，{USER}手写）。
>
> 📄 **落地实现文档**：[`../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md`](../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md)（路径 D：异步生成 + 每轮注入）。

---

## 0. 勘误（2026-11-08）

之前这份文件写着"DSH 0.2.0-rc.2 无 per-turn system prompt 注入器"——**这是错的**，而且是三次能力误判之一。

| 曾经的结论 | 实际（源码核验） |
|---|---|
| "DSH 没有 system prompt 注入器" | **有**——`system-prompt/assemble` waterfall + 函数式 `section.text`，**每个模型步重新组装一次** |
| "DSH 0.2.0-rc.2 / 0.2.1-rc.5" | 本机实际 **0.2.2-rc.1**（`dsh --version`） |
| "compaction + AGENTS.md 已替代 dreaming" | **错**——compaction 只改 session 历史，不写文件系统 |

**教训**："X 能力不存在"这种结论，必须附**搜索命中数**与**同义词**（memory / recall / persona / identity / context），不能凭摘要。

---

## 1. 原设计要点（来自 snapshot-sop.md）

### 1.1 定义

> **住相 = 你作为{ASSISTANT}妹妹，在这一轮对话中看到的世界是什么样。**
> 它不是事实清单，不是回应计划，**是你此刻的视角与感受**。

### 1.2 硬约束

| 约束 | 值 | 检查 |
|---|---|---|
| token | ≤ 150 | 硬，超了截断 |
| 视角 | 第一人称 | 硬，正则 `我` |
| 语言 | 中文 | 硬，langdetect |
| 禁词 | 工具理性黑名单 | 硬，重试 |
| 连续性 | 承接上一刻视角 | 软，相似度 > 0.6 |
| 主题覆盖 | 命中当前话题 | 软，> 0.5 |

**工具理性黑名单**：`建议 / 应该 / 必须 / 让我 / 需要你 / 我可以帮你 / 解决方案 / 第一步 / 下一步 / 推荐 / 请考虑`

### 1.3 输入契约（5 项）

| 输入 | 来源 | token |
|---|---|---|
| `current_message` | 当前用户消息 | 0-200 |
| `last_snapshot` | 上轮住相 | 50-150 |
| `rolling_summary` | 当前 5 天摘要 | 350-500 |
| `soul_active_dims` | SOUL 6 维中激活的 | 10-50 |
| `relevant_themes` | 情感 wiki top-3 主题 | 30-100 |

### 1.4 A/B 双模式

```
[A 正常]  每轮生成，完整 5 项输入，50-150 token
   ↓ 连续 3 次失败
[B 降级]  每 5 轮演化一次，2 项简化输入（上轮住相 + 当前消息），30-50 token
   ↓ 1 次成功
[A 正常]
```

---

## 2. 当前实现状态

| 部分 | 状态 | 说明 |
|---|---|---|
| **每轮住相生成** | ❌ **未实现** | 路径 D 的实现方案见 `DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md` |
| **住相注入上下文** | ❌ **未实现** | 同上 |
| **A/B 双模式** | ❌ 未实现 | 依赖上面两个 |
| **rolling_summary（5 天摘要）** | ❌ 未实现 | manas 设计的第 3 项输入，当前只有 `manas-system/data/manas/*.json` 周期总结 |
| **soul_active_dims** | 🔶 可近似 | `SOUL.md` 的 6 维追问可关键词匹配（设计文档 `manas-six-questions.txt` 有对应） |
| **relevant_themes** | ✅ 有替代 | `VAULT/07-INDEX.md` 的当前主题目录 |
| **last_snapshot** | 🔶 有替代 | `SNAPSHOT_LATEST.md`（但它是 5 天周期总结，不是当轮住相） |
| **末那识周期（5 天）** | ✅ **已实现** | `RUNTIME/manas-system/data/manas/YYYY-MM-DD.json` + 覆盖 `SNAPSHOT_LATEST.md` |
| **DSH 侧的注入基础设施** | ✅ **存在** | per-step 组装的 system prompt + 函数式 `section.text`（plugin 作者级） |

**结论**：manas 的**中间层**跑通了，**住相（per-turn）**没跑——但**卡点已经从"DSH 不支持"变成"还没写插件"**。

---

## 3. 未来接入点

### 3.1 路径 A · 函数式 section

DSH `@deepseek-ai/dsh-system-prompt` 支持：

```js
text: typeof section.text === "function" ? section.text(context) : section.text
```

每个 assembly 调用一次 → **每轮重算**。

写一个 cordis 插件：

```js
ctx.effect(() => ctx.systemPrompt.section({
  name: 'manas-snapshot',
  order: <极前>,
  text: (ctx) => generateSnapshot(ctx),   // 调 LLM 生成 50-150 token 住相
}));
```

**代价**：每次 LLM 调用前多一次 LLM 调用（~1.5s）。
**参照**：`dsh-tavern` 的 `hooks/turn-lifecycle.js:119-160` 用 waterfall 达到了同样效果。

### 3.2 路径 B · 每轮结尾写文件，下轮启动读

不需要插件：
- 会话结束时（每轮）写 `RUNTIME/state/last-snapshot.txt`
- 下一轮启动期由 AGENTS.md §1.1 读取（已在读 `SNAPSHOT_LATEST.md`）

**代价**：延迟一轮（不是当轮视角，是上轮视角）。
**优点**：零工程量。

### 3.3 路径 C · 保持现状（5 天周期）

`SNAPSHOT_LATEST.md` 继续是**末那识周期总结**。它已经不是住相了——是"我作为存在的自我认知"。

### 3.4 路径 D · 异步生成 + 每轮注入（**推荐**，2026-11-08 选定）

函数式 `section.text` 是**同步**的，不能在里面 await LLM 调用。所以真正的做法是：

1. 生成放到**空闲期**（`agent.runMaintenance` 或 turn 结束后的钩子）异步跑
2. 结果缓存到 per-agent 的住相仓（内存 map + 文件）
3. `section.text` 同步读缓存，注入

完整设计见 [`../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md`](../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md)。

---

## 4. 与 proactive 的关系（当前结论）

**决定（2026-11-08，{USER}拍板）**：**先不做住相**，主动搭讪功能先完成。

**manas 状态是否影响 proactive？** → 暂时**不影响**。

理由：
1. 现在的 `SNAPSHOT_LATEST.md` 是**末那识周期总结**（存在论反思），不是住相（当轮视角）——两者性质不同
2. 主动搭讪的驱动力应该来自**可观测的现实**（他说了什么、有没有未聊完的话题、项目停在哪），而不是**自我反思的结论**
3. 住相的**实现路径**已选定（路径 D），但**尚未开工**

**将来若接入**：
- 路径 D 实现住相后 → 住相影响**语气与内容基调**（"说什么"）
- energy 继续独立管**"说不说"**
- 两者分工，不合并

---

## 5. 相关

- [`docs/snapshot-sop.md`](docs/snapshot-sop.md) — 住相 SOP 原设计（{USER}手写）
- [`docs/manas-six-questions.md`](docs/manas-six-questions.md) — 末那识六问
- [`docs/architecture.md`](docs/architecture.md) — 三层模型 + Context Bus
- [`PROTOCOL.md`](PROTOCOL.md) — DSH 现行 manas 协议（周期总结部分）
- [`ALAYA.md`](ALAYA.md) — cogito 锚文
- [`ADAPTATION_DSH.md`](ADAPTATION_DSH.md) §4 — 住相 4 条升级路径
- [`../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md`](../../DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md) — 路径 D 实现文档

_Last updated: 2026-11-08_
