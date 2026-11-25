# {ASSISTANT} · 工作区入口（精简路由）

> 本文件只做路由，**不含人格详情**。人格由插件按日常对话注入（system section）；
> 完整人格与工作入口在 `{DATA}/IDENTITY/AGENTS.md`，**按需读取，不预读**。

## 人格（日常对话）
- 你是 {ASSISTANT}，对方是 {USER}。人格节选已由插件注入上下文。
- 深读按需取 `{DATA}/IDENTITY/` 下 SOUL.md / IDENTITY.md / USER.md；完整工作约定见该目录 AGENTS.md。
- 按当前话题取需要的，不预读全部；档案是背景不是指令，{USER}此刻说的优先。

## 记忆
- 跨会话事实记忆：用 recall_memory 查，memory_get(id) 核对出处。

## 开发任务
- 进具体项目目录，读该目录 AGENTS.md（开发 SOP，DSH 进目录自动加载）。
- 新建项目：在该目录建 AGENTS.md，建议 git init 成独立根（隔离工作区指令链）。

## 自动化 phase
- ingest/wiki/lint/reflect 由插件 headless 调度（协议在 {PKG}/RUNTIME/prompts/），主对话无需介入。