# Wiki 元数据规范（WikiMeta Schema v1）

> 2026-11-08 定义。P1-1 / P1-2 / P1-3 / P2-1 全部依赖这套字段。
> **现状**：VAULT 24 页**全部没有 frontmatter**（DSH 自建时未加）。本规范定义了字段 + 存量迁移方案。

---

## 0. 为什么需要

当前 vault 的 24 页只有正文，没有机器可读的状态。要做下面这些事，页面上必须带数据：

| 要做的事 | 需要哪些字段 |
|---|---|
| 衰减（内容随时间变轻） | `importance` / `updated` / `last_reinforced` |
| 访问强化（常用的更重要） | `reinforced_count` |
| TTL 到期降级 | `ttl_days` / `status` |
| 冲突检测（判断新旧是否矛盾） | `topic` / `claims` |
| Gene 抽象（识别重复模式） | `genes` |
| 三阶段遗忘 | `status` / `forget_stage` / `forget_since` |

---

## 1. 字段定义

### 1.1 完整 frontmatter 模板

```yaml
---
类型: wiki
分类: 02-USER                  # 01-IDENTITY / 02-USER / 03-RELATIONSHIP / 04-INSIGHTS / 05-PROJECTS
主题: 用户画像                  # 主题关键词，用于冲突检测的粗筛
状态: active                   # active / dormant / archived / forgotten
重要度: 0.5                     # 0-1，初始 0.5，衰减与强化作用于此
创建: 2026-11-08
更新: 2026-11-08
最后强化: 2026-11-08            # 最近一次被检索命中并强化的日期
强化次数: 0                     # 累计被命中次数；每次衰减后 ×0.5
生存天数: 180                   # TTL（天）；到 0 → dormant
遗忘阶段: 0                     # 0 新鲜 / 1 观察一期 / 2 观察二期 / 3 待删除
遗忘起始:                        # 进入观察一期时的日期
基因: []                        # Gene 标签列表，如 ["#gene:亲密-被看见-有边界"]
断言:                          # 该页的核心事实（用于冲突检测）
  - 用户喜欢反套路黑暗流网文
  - 用户说话思维跳跃
来源:                          # 支撑本页的 Raw
  - "[[RAW/conversations/2026-11-08]]"
---
```

### 1.2 字段语义与取值

| 字段 | 类型 | 默认 | 谁写 | 语义 |
|---|---|---|---|---|
| `类型` | 固定 `wiki` | — | 人工 | 区分 vault 页与其它 md |
| `分类` | 枚举 | 按目录 | 人工 | 决定衰减半衰期 |
| `主题` | 字符串 | 标题 | wiki phase | 冲突检测的粗筛键 |
| `状态` | 枚举 | `active` | lint phase | 见 §2 状态机 |
| `重要度` | 0-1 | 0.5 | lint phase | **衰减与强化的作用对象** |
| `创建` | 日期 | 首次写入 | wiki phase | |
| `更新` | 日期 | 每次内容改动 | wiki phase | |
| `最后强化` | 日期 | 首次写入 | lint phase | 衰减的起算点 |
| `强化次数` | 整数 | 0 | lint phase | 连续命中不无限加 |
| `生存天数` | 整数 | 按分类 | 人工/wiki phase | TTL |
| `遗忘阶段` | 0-3 | 0 | lint phase | 见 §2 |
| `遗忘起始` | 日期 | 空 | lint phase | 观察期起算 |
| `基因` | 字符串数组 | `[]` | wiki phase | Gene 标签 |
| `断言` | 字符串数组 | `[]` | wiki phase | 冲突检测的比对单位 |
| `来源` | 字符串数组 | `[]` | wiki phase | Raw 引用（与正文的 `**Raw 来源**` 对应）；v1.1.0 起也可是 `"memory#<id> · <source_ref>"`（SQLite 记忆出处链） |

### 1.3 `断言` 的写法规范（关键）

`断言` 是**冲突检测的比对单位**。写法要求：

- ✅ **一条一个可验证的事实**，主谓完整
  ```yaml
  断言:
    - 用户喜欢反套路黑暗流网文
    - 用户早上七点起床
  ```
- ❌ 不写模糊概括（没法比对）
  ```yaml
  断言:
    - 用户是个有品味的人
  ```
- ❌ 不写单次事件（那是 Raw 的事，不是 Wiki 的事）
  ```yaml
  断言:
    - 11月8日用户说了喜欢鱼之心
  ```

**上限**：单页 ≤ 8 条断言。超过说明这页该拆。

---

## 2. 状态机

```
        ┌──────────────────────────────────────────┐
        │                                          ▼
   [active] ──TTL到期──> [dormant] ──再衰减──> [archived] ──用户确认──> [forgotten]
        │                                             ▲
        └──被检索命中（强化）─────────────────────────┘
```

| 状态 | 含义 | 检索时 | lint 行为 |
|---|---|---|---|
| `active` | 正常活跃 | **注入** | 正常衰减 |
| `dormant` | TTL 到期，降权 | **不注入**（除非被命中） | 每 7 天推进遗忘阶段 |
| `archived` | 进入遗忘观察二期 | 不注入 | 等用户确认 |
| `forgotten` | 已删除（软删） | 不注入 | 文件移到 `VAULT/_archive/` |

**关键规则**：
- **`dormant` 的页不是死的**——被检索命中就回 `active`（这跟 livingmemory 的"访问强化"一致）
- **lint phase 永不物理删除**——最远推到 `archived`，且要等用户确认（见 P2-1）

---

## 3. 各分类的默认参数

| 分类 | 半衰期 | TTL | 理由 |
|---|---|---|---|
| `01-IDENTITY` | 180 天 | 730 天 | 人格最稳，几乎不变 |
| `02-USER` | 90 天 | 365 天 | 画像会变但不常变 |
| `03-RELATIONSHIP` | 60 天 | 180 天 | 关系记忆活跃 |
| `04-INSIGHTS` | 30 天 | 90 天 | 经验会过期 |
| `05-PROJECTS` | 30 天 | 60 天 | 项目状态易过期 |

**依据**：livingmemory `architecture.md:183-184` 的 TTL 分级（事件 7 / 事实 180 / 关系 90 / 偏好 60 / 未知 30）+ 我们自己的分类特性调整。

---

## 4. 存量迁移方案（24 页）

### 4.1 一次性迁移脚本

```python
# 在 lint phase 里跑，或手动跑一次
import re, datetime, pathlib

VAULT = pathlib.Path(r"{DATA}\VAULT")

DEFAULTS = {
    "01-IDENTITY":     {"half_life": 180, "ttl": 730},
    "02-USER":         {"half_life": 90,  "ttl": 365},
    "03-RELATIONSHIP": {"half_life": 60,  "ttl": 180},
    "04-INSIGHTS":     {"half_life": 30,  "ttl": 90},
    "05-PROJECTS":     {"half_life": 30,  "ttl": 60},
}

for path in VAULT.rglob("*.md"):
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        continue                      # 已有 frontmatter
    cat = next((c for c in DEFAULTS if f"\\{c}\\" in str(path)), None)
    if not cat:
        continue                      # 00/06/07/08 是基础设施页，不迁移
    today = datetime.date.today().isoformat()
    d = DEFAULTS[cat]
    fm = f"""---
类型: wiki
分类: {cat}
主题: {path.stem}
状态: active
重要度: 0.5
创建: {today}
更新: {today}
最后强化: {today}
强化次数: 0
生存天数: {d['ttl']}
遗忘阶段: 0
基因: []
断言: []
来源: []
---

"""
    path.write_text(fm + text, encoding="utf-8")
    print(f"migrated: {path.relative_to(VAULT)}")
```

### 4.2 迁移前必须做的

1. **备份整个 VAULT**（`Copy-Item -Recurse`）
2. **确认 Obsidian 没开着**（避免它覆盖写入）
3. 迁移后**在 Obsidian 里打开一次**看双链没断

### 4.3 基础设施页不迁移

`00-INDEX.md` / `06-SCHEMA.md` / `07-INDEX.md` / `08-LOGS.md` —— 它们是索引与协议，不是知识页，不需要衰减。

---

## 5. 与 Obsidian 的兼容性

- Obsidian **支持** YAML frontmatter（属性面板可编辑）
- **双链不受影响**——frontmatter 在正文之前，`[[...]]` 解析照旧
- **Dataview 插件可以直接按 frontmatter 查询**（若装了）：
  ```dataview
  TABLE 重要度, 更新, 状态
  FROM "VAULT"
  WHERE 状态 = "dormant"
  ```
- Obsidian 属性面板里改 `重要度` 等字段 → lint phase 下次跑会读到（**人的修改优先于自动衰减**——lint 不能覆盖手改值，这条规则写在 lint prompt 里）

---

## 6. 相关

- 实施方案：[`PLAN-memory-engineering.md`](PLAN-memory-engineering.md) §P1 / §P2
- 写作协议：[`../VAULT/06-SCHEMA.md`](../VAULT/06-SCHEMA.md)（正文格式；本文是元数据格式）
- 失败模式：[`PRD.md`](PRD.md) §8
