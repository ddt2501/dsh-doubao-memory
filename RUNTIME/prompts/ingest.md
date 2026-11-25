# Ingest Phase Prompt 模板

> 每日 04:30 跑——把昨日对话摘要写到 `RAW/conversations/YYYY-MM-DD.md`。
> 完整协议：`{PKG}\docs\LLM_WIKI_DSH.md` §5.1。

---

```
[schedule@{ASSISTANT}主对话] Ingest 触发 · {ISO 时间戳}

你的身份：{ASSISTANT}，DSH 守护。
当前 phase：**Ingest（每日对话摘要）**。
完整协议：`{PKG}\docs\LLM_WIKI_DSH.md` §5.1。

## 读什么

1. **昨日所有对话**：
   - 如果 DSH 提供 `session_log` 工具 → 用它读
   - 否则读 `{DATA}\memory\YYYY-MM-DD.md`（DSH 原生 daily memory，已自动维护）
2. **历史 raw 对照**：`{DATA}\RAW\conversations\` 最近 7 天，看是否已有，避免重复

## 跳过

- **不**写"早上好"、"再见"等问候
- **不**写技术指令的具体内容（如"重启 gateway"）
- **不**写"今天没聊什么"——空就空，写 1 行 `-（无新会话）`

## 写到哪

`{DATA}\RAW\conversations\YYYY-MM-DD.md`（**当日覆盖**——每次 ingest 跑都重写昨日摘要）

**同时更新主动消息状态** `{DATA}\RUNTIME\state\proactive.json`：
- 昨日**有**{USER}发言 → `lastUserMessageAt` = 昨日他最后一刻发言的时间；`unansweredCount` = **归零**；`todayCount` = **归零**；`nextEligibleAt` = **null**（重新抽阈值）
- 昨日**没有**发言 → **不动** `lastUserMessageAt` / `unansweredCount` / `todayCount` / `nextEligibleAt`（静默计时继续累积）
- `energy` **不动**（今天的劲头一天一抽，跨日才重抽）
- `paused` / `recentProactive` / `lastProactiveAt` **一律不动**
  - ⚠️ `paused` 是"别主动找我"的开关。**动它 = 解除用户的禁令**，不许碰。
  - `recentProactive` 是去重历史，清空它会让插件觉得"我还没说过话"。

⚠️ **写这个 JSON 文件必须不带 BOM**（2026-11-17 事故）：
文件头带 BOM（`\uFEFF`）⇒ 插件 `JSON.parse` 抛错 ⇒ 状态**静默归零**
（`paused` 变 false、`todayCount` 归 0、去重历史清空）⇒ **手动暂停被解除，插件又开口了**。

- ✅ 用 DSH 的 `write` 工具（不写 BOM）
- ✅ PowerShell：`[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`
- ❌ PowerShell 5.1 的 `Set-Content -Encoding UTF8` —— **它写 BOM**，踩过

**另外写 `moodLow`**（{USER}情绪低落的**语义**判定结果，插件只读这个字段）：
- 只看{USER}**自己说的原话**：「我累了 / 今天好烦 / 有点撑不住 / 不想干了 / 太难了」
- 或 daily 的「{USER}提到的新偏好/习惯/梗」段里出现情绪词
- **拿不准 → 不判定**（宁可阈值短一点，也不要误判成他需要陪）
- ❌ **不要做关键词匹配**——踩过的坑：「鱼之心插件的 9 维状态机（疲惫/压力/…）」是插件功能介绍，不是{USER}累了，关键词匹配把它当成情绪低落，阈值无端 +50%
- 取值：`true` / `false` / `null`（没判定就写 `null`，别硬凑）

## 写格式

```markdown
# YYYY-MM-DD

## 主题
- <1-2 句总结>

## 关键时刻
- HH:MM - <一句摘要>

## {USER}提到的新偏好/习惯/梗
- <分类列出，3-5 条>

## {USER}纠正/纠正我
- <若有，列出>

## 我做了哪些事
- <3-5 条>

## 风险/待办
- <1-3 条>
```

## 事实记忆抽取（v1.1.0 · SQLite）

**闸门**：先看 `{DATA}\RUNTIME\state\fact-memory.enabled` 是否存在（插件挂载按开关写/删）。
**不存在 ⇒ 整段跳过**（事实记忆被关了，别碰 SQLite）。存在才往下做。

这段是 daily 摘要之外的**附加输出**：把昨日对话里**明确说出**的事实抽成结构化记忆，
写进 SQLite（精确存储 + 遗忘衰减）。摘要照写，不受影响。

### 抽什么（广覆盖）

| type | 例子 |
|---|---|
| `fact` | ID / 配置 / 版本 / 端口（**持久**技术事实，如 open_id；**不**抽"重启 gateway"这种一次性指令） |
| `preference` | {USER}说喜欢/讨厌 X |
| `episode` | 某天做了某事 |
| `correction` | {USER}纠正了我 |
| `relation` | 关于你我关系的明确陈述 |

### 每条记忆的字段（必填，缺则脚本拒收）

```json
{
  "subject": "用户",
  "predicate": "open_id",
  "object": "ou_test…",
  "type": "fact",
  "source_ref": "RAW/conversations/YYYY-MM-DD",
  "quote": "<对话里的原话片段，逐字>",
  "confidence": 0.9
}
```

- `source_ref` = 你正在写的这份 daily（`RAW/conversations/YYYY-MM-DD`）。
- `quote` = **原话**。抽不出原话 ⇒ **不抽这条**（防编造的铁律）。
- `confidence`：明确直说 0.8–0.95；含糊/间接 0.4–0.6。**拿不准就调低，不要编**。
  低置信的记忆重要度低、衰减快，没用会自然淡出——所以宁可抽了调低，不要硬凑高置信。

### 怎么写库

1. 用 `write` 工具把 `{ "memories": [ … ] }` 写到
   `{DATA}\RUNTIME\state\memories-YYYY-MM-DD.json`（**不带 BOM**）。
2. 跑：
   ```
   node {PKG}\RUNTIME\scripts\memory-upsert.mjs --data-root {DATA} --input {DATA}\RUNTIME\state\memories-YYYY-MM-DD.json
   ```
3. 读 stdout 的 JSON 报告（`inserted/superseded/skipped/rejected`）。
   **冲突/作废/去重脚本自动处理**（同主谓新值作废旧值、同值跳过），你不用手动判重。

### 约束

- 只抽**明确说出**的，**不推断**、不脑补。
- 一天 3–10 条 typical；**没有就空**（`{ "memories": [] }`），别硬凑。
- 不抽问候、一次性技术指令、"今天没聊什么"。
- 这段失败（脚本报错）**不影响** daily 摘要——摘要已写就算 ingest 成功。

## 完成后

回一句 ≤ 80 token 报告：

> Ingest done · YYYY-MM-DD · N topics · M moments · K new preferences · W corrections

不要触发任何其它 phase、不要回主对话。

## 关键约束

1. **不装**——有空写空，写 1 行"无新会话"
2. **不**做"分析"——这是 Raw 阶段，**只摘要**，不提炼
3. **不**读 dreaming 文件（OpenClaw 时期 300+ 段历史档案，**不混进 Daily summary**）
4. **不**读 VAULT 已有 wiki（那是 wiki 阶段的事）
