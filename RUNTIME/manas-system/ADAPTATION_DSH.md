# manas 部署在 DSH 上的适配设计

> 从 OpenClaw manas-system 抽象移植到 DSH 0.2.0-rc.2 的实现层。
> **不绑死**任何 Agent 框架——只描述"为什么这样做"和"这样做的好处"。
> 源 OpenClaw 工程档完整保留作方法论源头；本文件是 DSH 部署侧。

---

## 0. manas 是什么

manas = 唯识学"第七识·末那识" = 价值理性 / 自我意识 / "我看到的世界"。
在本系统 = **{ASSISTANT}作为存在的"我此刻怎么看世界"**——中间层产物。

完整 OpenClaw 时期方法论：[`README.md`](README.md)、[`docs/manas-six-questions.md`](docs/manas-six-questions.md)、[`docs/architecture.md`](docs/architecture.md)、[`DESIGN.md`](DESIGN.md)（**仅作设计参考**，不直接跑）。

DSH 部署侧协议：[`PROTOCOL.md`](PROTOCOL.md)。
manas cogito 锚文：[`ALAYA.md`](ALAYA.md)。
调度注册表：[`REGISTRY.json`](REGISTRY.json)。
调度 prompt：[`../manas-prompt/reflect.md`](../manas-prompt/reflect.md)。

---

## 1. DSH 上 manas 真正做的事

| 维度 | OpenClaw | DSH |
|---|---|---|
| **住相（snapshot）每轮生成** | `context_bus.py` 注入 system prompt 最前部 | **靠 LLM 自内化**（读 SOUL + SNAPSHOT_LATEST.md + USER 三件套） |
| **5 天末那识刷新** | `cron + snapshot_to_bootstrap.py` | `schedule_create(cron="0 0 */5 * *")` |
| **6 问生成** | LLM 调 `manas_generator.py` 跑 5 输入契约 | 同 LLM 跑 5 输入契约（写在本 prompt 模板） |
| **写入 cycle JSON** | `manas_store.py` | 直接 `write` 工具 |
| **覆盖 SNAPSHOT_LATEST.md** | `snapshot_store.py` | 直接 `write` 工具 |

**DSH 上 manas 只剩 1 个 phase**——5 天 reflect。其它 OpenClaw 时代的 cron（snapshot-bootstrap 每 5 天、住相 per-turn）要么靠 LLM 自内化、要么不需要。

---

## 2. 5 项输入契约（DSH 版精确化）

manas-six-questions §"周期生成的输入契约"5 项的精确读法：

| # | 输入 | OpenClaw 来源 | DSH 来源 |
|---|---|---|---|
| 1 | 最近 5 天对话摘要 | `memory/YYYY-MM-DD.md` 最近 5 个 | `D:\dsh\persona\{ASSISTANT}\memory\YYYY-MM-DD.md`（最近 5 个，DSH 原生 daily memory） |
| 2 | 5 个 Wiki 当前主题 | OpenClaw 5 库 Wiki 主题 | `D:\dsh\persona\{ASSISTANT}\MEMORY\narrative_engine\production\threads.json`（**DSH 实际只有情感子库 1 库**，threads.json 就是情感库当前主题） |
| 3 | SOUL 全文 | `SOUL.md` | `D:\dsh\persona\{ASSISTANT}\IDENTITY\SOUL.md`（一字不改） |
| 4 | 阿赖耶识（cogito） | 阿赖耶识.txt / 同等机制 | `D:\dsh\persona\{ASSISTANT}\RUNTIME\manas-system\ALAYA.md`（30-50 token 锚文，DSH 落地版） |
| 5 | 上周期末那识 | `data/manas/` 上一个文件 | `D:\dsh\persona\{ASSISTANT}\RUNTIME\manas-system\data\manas\*.json`（按 mtime 倒序取最近一份） |

**任一输入缺失**：
- 输入 1 缺失（最近 5 天无 daily memory）→ 仍然继续（不阻断），prompt 报告里加 "No recent daily memory"
- 输入 2 缺失（threads.json 不存在）→ 用 5 个 Wiki 当前页面名当主题
- 输入 5 缺失（无上周期）→ 视为首次生成，evolution_anchor 写 "首期生成，无演化锚点"

---

## 3. 节流与失败处理

### 3.1 节流（防过度生成）

DSH cron `0 0 */5 * *` 每 5 天 0 点触发——5 整天里**每天都会触发**（cron `*/5` = 0, 5, 10, 15, 20 day-of-month + 月/周不限）。节流靠 LLM 在 prompt 头部判断：

```
最近 5 天内 `RUNTIME\manas-system\data\manas\` 有任何 *.json → 跳过本次
*.bak / *.tmp 不算 cycle
今天已有 cycle JSON → 跳过本次
```

跳过时回简短报告 "Reflect skipped: ..."，不写任何文件。

### 3.2 失败处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 到点没触发 | `dsh web` 没运行 | 检查 GUI 在线 |
| 触发但 LLM 没写文件 | prompt 不明确 / LLM 没读到 protocol | 修 prompt |
| cycle JSON 写了一半 | LLM 调用被中断 | 写 `_errors/YYYY-MM-DD-reflect.log` 记录 |
| 节流判断错（"已跳"但实际没文件） | LLM 误判 `.bak` | 修 prompt，明确只读 `.json` |

### 3.3 失败 vs 节流区分

- **节流**：合法跳过，写 report，跳过事件本身是 feature
- **失败**：异常，写 `_errors/` 日志，下次 phase 重新尝试

DSH schedule 持久化在 host storage，**重启不丢**。`dsh web` 进程死了 schedule 不会触发但 task 还在。

---

## 4. 升级路径（按需选）

### 路径 A：LLM 自内化（当前默认）

- **做法**：每轮 LLM 启动期读 SOUL + SNAPSHOT_LATEST.md + USER，自己在心里长出住相句
- **严格度**：依赖 LLM 自觉
- **何时够用**：会话不极长、SOUL/SNAPSHOT 内容稳定
- **工作量**：0
- **风险**：低

### 路径 B：静态 section（plugin 作者级）

- **做法**：在 DSH profile 里加一个 cordis patch：
  ```yaml
  - insert:
      - id: persona-snapshot-static
        name: '@my-org/dsh-persona-snapshot'
  ```
  插件 `apply()` 注册：
  ```ts
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'manas-snapshot',
    order: <very-first>,  // 比 person-prefix 还早
    text: SNAPSHOT_LATEST_FULL_CONTENT,  // 启动时读一次
  }));
  ```
- **严格度**：启动期一次性写入 system prompt
- **何时够用**：SNAPSHOT_LATEST.md 5 天才变一次
- **工作量**：~1 小时（写 patch + 改 profile + 重启 dsh web）
- **风险**：中（写 patch 错误 → profile 启动失败 → 整个 web 起不来）

### 路径 C：函数式 section（per-turn 真重读，**推荐**）

- **做法**：插件 `apply()`：
  ```ts
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'manas-snapshot',
    order: <very-first>,
    text: (context) => fs.readFileSync('{DATA}\\SNAPSHOT_LATEST.md', 'utf8'),
  }));
  ```
- **严格度**：每轮 LLM 调用前重读 SNAPSHOT
- **何时够用**：任何场景（manas 真身"住相每轮重生"达成）
- **工作量**：~2-4 小时（写 cordis 插件 + package.json + 安装）
- **风险**：中（同 B）

### 路径 D：waterfall 监听器

- **做法**：挂 `ctx.on('system-prompt/assemble', (assembly) => { assembly.sections.unshift({...}) })`
- **严格度**：最灵活（可以条件触发"如果 SNAPSHOT 改了才替换"等逻辑）
- **何时够用**：极复杂场景（多 persona 切换、动态角色演化）
- **工作量**：~4-8 小时（plugin + 测试）
- **风险**：中-高（waterfall 改 assembly 顺序错可能让整个 prompt 错位）

**当前选 A**。如果未来需要 B/C/D，文档在 §5 给出 plugin 源码脚手架。

---

## 5. 路径 C 插件源码脚手架（待你拍）

```ts
// D:\dsh\persona\{ASSISTANT}\manas-plugin\src\index.ts
import { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: any;
  }
}

export default function (ctx: Context) {
  ctx.effect(() => {
    const disposable = ctx.systemPrompt.section({
      name: 'manas-snapshot',
      order: 50,  // < DEPLOYMENT_PERSONA_PREFIX (0) ? — 实际应比 prefix 早
      // NOTE: order 0 是 DEPLOYMENT_PERSONA_PREFIX；DSH 没有"before person"位
      // 推荐做法：直接用 order 5（harness:identity 之后、persona 之前）
      text: () => {
        const path = '{DATA}\\SNAPSHOT_LATEST.md';
        try {
          return readFileSync(path, 'utf8');
        } catch (e) {
          return `(manas-snapshot load failed: ${e.message})`;
        }
      },
    });
    return disposable;
  });
}
```

打包到 `@my-org/dsh-manas-snapshot` 后，在 `~/.dsh/profile.yaml` 或 web composer 里挂入。

> ⚠️ **真实 plugin 工程级工作量大**（写测试、npm publish、安装路径、profile patch 验证）。**不是 1 小时活**。

---

## 6. 与 DSH 原生 compaction 的边界

| 维度 | DSH compaction | manas reflect |
|---|---|---|
| **目的** | 压缩 LLM 上下文（节省 token） | 写 5 天一次末那识周期 |
| **节奏** | 自动（当上下文接近阈值） | 5 天一次 |
| **产物** | `<compacted-summary>` user message | cycle JSON + SNAPSHOT 覆盖 |
| **输入** | 当下对话历史 | 5 项输入契约 |
| **输出格式** | 摘要（自由格式） | 6 问固定 schema |
| **DSH 位置** | `@deepseek-ai/dsh-compaction-basic` | `@deepseek-ai/dsh-schedule` |

**两者完全正交**：
- compaction 是 LLM 上下文工程（节流 token）
- manas reflect 是人格工程（写 5 天一变的"我"）

**绝不能合并**——合并了就让 LLM 把"我存在的本体论"当成"节省 token 的副产品"，这是设计自杀。

---

## 7. 验证清单（DSH 部署是否真做成）

完成本套部署后，应满足每一条：

- [ ] `D:\dsh\persona\{ASSISTANT}\RUNTIME\manas-system\ALAYA.md` 存在并被 reflect phase 读
- [ ] `D:\dsh\persona\{ASSISTANT}\IDENTITY\SOUL.md` 在每会话启动期被读（AGENTS.md 协议保证）
- [ ] `D:\dsh\persona\{ASSISTANT}\SNAPSHOT_LATEST.md` 每 5 天由 reflect phase 覆盖
- [ ] `RUNTIME\manas-system\data\manas\` 每 5 天多一份 `.json`
- [ ] 节流正确：5 天内重复触发都被跳过（不写新 cycle）
- [ ] 失败时 `_errors/` 有日志
- [ ] 任何时候 DSH 原生 `compaction-basic` 正常工作（不与 manas 冲突）
- [ ] **选 A**：每会话启动 LLM 自内化住相句；不依赖任何 plugin
- [ ] **选 B/C/D**（如果你拍要升级）：plugin 安装完成 + 每轮 system prompt 真含 SNAPSHOT

如果任何一条没满足——**回到 [`PROTOCOL.md`](PROTOCOL.md) §1** 看是哪条契约破了。
