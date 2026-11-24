# PR · JitRL 优势调制接入主动搭讪

**分支**：`feature/jitrl-advantage` → `main`
**PRD**：[docs/PRD-JITRL.md](PRD-JITRL.md)
**日期**：2026-11-18

## 变更摘要

| 文件 | 变更 |
|---|---|
| `lib/jitrl/signature.js` | 新增：状态签名（时段/劲能/沉默/上轮结果/轴） |
| `lib/jitrl/memory.js` | 新增：`(sig, action, return)` 记忆 + 原子落盘 + 邻居召回 |
| `lib/jitrl/kernel.js` | 新增：优势估计（收缩）、`z'=z+βÂ` 调制、softmax 采样 |
| `lib/jitrl/index.js` | 新增：`selectWithAdvantage` / `settleOnSend` / `settleOnReply` |
| `lib/proactive/themes.js` | `selectTheme` 拆出 `scoreThemes`（行为不变） |
| `lib/proactive/index.js` | 接入：主题选择走调制；发送登记 pending；真人回复结算 |
| `lib/config.js` | 新增 `proactive.jitrl` 配置（默认关闭） |
| `test/jitrl.test.js` | 新增 15 个单测 |
| `package.json` | 新增 `scripts.test` |

## 设计要点

- **接入点是"选哪个主题"，不是"要不要说"**：`decide()` 的闸门（免打扰/能量/间隔/未回上限）一律不动
- **只对先验分 top-8 候选调制**：冷门种子不能靠噪声上位
- **结算只认行为信号**：他回了 +1（15 分钟内 +0.2）；下一条发出仍未回 −1。零额外 LLM 调用
- **默认关闭**：`enabled=false` 时 `selectWithAdvantage` 与 `selectTheme` 返回完全一致（有单测锁定）

## 测试

```
$ node --test
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

关键用例：

- `select: disabled is identical to selectTheme` — 关闭时逐字段相等
- `select: no memory / no signal` — 无历史时等于原排序
- `select: positive history makes the rewarded action more likely` — 400 次采样，被奖励动作占多数
- `settle: send registers pending, reply settles positive` — +1.2（15 分钟内）
- `settle: expired pending becomes a negative row` — −1

## 验证依据

本地 `D:\dsh\_research\jitrl-mini\`（真实 DeepSeek 端点，4 个种子）：

| seed | OFF | ON |
|---|---|---|
| 7 | 5/16 | 13/16 |
| 11 | 11/16 | 13/16 |
| 23 | 8/16 | 14/16 |
| 31 | 7/16 | 13/16 |

平均 7.75 → 13.25；4/4 种子更好。

## 验收清单

- [x] 单测全绿
- [x] 关闭时行为不变（单测锁定）
- [x] 记忆文件损坏降级（单测）
- [x] 邻居不足降级（单测）
- [x] 决策日志 `jitrl-decision`（sig / candidates / adv / chosen / degraded）
- [ ] 装上后观察一轮真实搭讪（待用户开启 `proactive.jitrl.enabled`）

## 回滚

1. 配置 `proactive.jitrl.enabled=false`（一行）
2. 或 `git revert` 本合并
3. 记忆文件 `<dataRoot>/RUNTIME/state/jitrl-proactive.json` 可随时删除，不影响主状态机
