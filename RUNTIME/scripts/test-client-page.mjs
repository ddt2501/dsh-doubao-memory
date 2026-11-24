/**
 * 设置页组件测试 —— 在**假 React + 假宿主**里真的把组件跑一遍。
 *
 * 为什么值得写：插槽组件一旦抛错，DSH 会静默把整个插槽条目置空
 * （控制台只有一行 `slot entry crashed in '<slot>'`），
 * 表现就是"设置页什么都没有"，而且从日志里看不出来。
 *
 * 覆盖：
 *   1. summary 视图（宿主不给 form）不崩
 *   2. page 视图正常渲染
 *   3. **同一组件在两种视图间切换时 hooks 数量不变**（React 铁律）
 *   4. 没有 form 时给出可读提示而不是抛错
 *   5. 两个槽都注册了，key 正确
 *   6. 保存时 mutate 的 ops 形状正确（path 是数组、op 是 set）
 */
import { readFileSync } from 'node:fs'

const CLIENT = 'D:/dsh/packages/dsh-doubao-memory/lib/client.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) }
  catch (e) { fail++; console.log(`FAIL  ${name} — ${e?.message ?? e}`) }
}

// ── 假 React：记录每次渲染的 hook 调用数量，切视图时比对 ────────
function makeReact() {
  let renderState = null      // 当前渲染的 hook 计数
  let hookIndex = 0
  const effects = []

  const React = {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children }
    },
    useState(init) {
      hookIndex++
      const v = typeof init === 'function' ? init() : init
      return [v, () => {}]
    },
    useEffect(fn) {
      hookIndex++
      effects.push(fn)
      return undefined
    },
    useRef(init) {
      hookIndex++
      return { current: init }
    },
    useMemo(fn) { hookIndex++; return fn() },
    useCallback(fn) { hookIndex++; return fn },
  }

  /** 每个组件函数各自的 hook 数量基线（React 真正比较的是这个） */
  const hookBaseline = new Map()
  const hookDrift = []

  /**
   * 递归渲染：函数组件真的被调用。
   * 同时校验 **同一个组件函数**每次渲染的 hook 数量是否稳定 —— 这才是 React 的规则。
   * （跨不同组件比较总数是错的：summary 用 PersonaSummary、page 用 PersonaPage。）
   */
  function render(fn, props, depth = 0) {
    if (depth > 30) throw new Error('渲染层数过深（可能自引用）')
    hookIndex = 0
    effects.length = 0
    const tree = fn(props)
    const own = hookIndex

    const prev = hookBaseline.get(fn)
    if (prev === undefined) hookBaseline.set(fn, own)
    else if (prev !== own) hookDrift.push(`${fn.name || '匿名'}: ${prev} → ${own}`)

    const eff = [...effects]
    if (tree && tree.__el && typeof tree.type === 'function') {
      const sub = render(tree.type, tree.props, depth + 1)
      eff.push(...sub.effects)
      // 返回**最内层**的渲染结果：SlotEntry 只是分发壳，真正的内容在它下面。
      return { tree: sub.tree, own, effects: eff }
    }
    return { tree, own, effects: eff }
  }

  return { React, render, hookDrift, hookBaseline }
}

/** 假宿主：捕获 __ModuleLoader__.load 的工厂 */
function loadClient() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { captured = spec },
    },
  }
  const src = readFileSync(CLIENT, 'utf8')
  // 直接在 node 里 eval：client.js 只依赖 window.__ModuleLoader__ 和 require('react')
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', src)(globalThis.window, (id) => {
    if (id === 'react') return currentReact
    throw new Error(`不能 require: ${id}`)
  })
  if (!captured) throw new Error('没有捕获到 __ModuleLoader__.load')
  return captured
}

let currentReact = null
const { React, render, hookDrift, hookBaseline } = makeReact()
currentReact = React

const spec = loadClient()
check('模块 id 是包名', () => {
  if (spec.id !== 'dsh-doubao-memory') throw new Error(spec.id)
})

const mod = spec.factory((id) => {
  if (id === 'react') return React
  throw new Error(`不能 require: ${id}`)
})
check('factory 返回 inject + apply', () => {
  if (typeof mod.apply !== 'function') throw new Error('没有 apply')
  if (!Array.isArray(mod.inject)) throw new Error('没有 inject')
})
check('inject 包含 slots 和 configForms', () => {
  for (const s of ['slots', 'configForms']) {
    if (!mod.inject.includes(s)) throw new Error(`缺 ${s}`)
  }
})

// ── 假 ctx：捕获槽注册 ──────────────────────────────────────
const registrations = []
const fakeForm = {
  getSnapshot() {
    return {
      status: 'ready',
      writable: true,
      revision: 7,
      value: {
        persona: {
          activeId: '', newId: '', userName: '用户', assistantName: '助手',
          selfDescription: '', coreTraits: [], tone: '', taboos: [], regenerate: false,
        },
        phaseModel: { mode: 'follow', provider: '', model: '' },
      },
    }
  },
  subscribe() { return () => {} },
  async mutate(ops, rev) { this.lastOps = ops; this.lastRev = rev; return true },
}

const fakeCtx = {
  configForms: { get(ns) { return ns === 'doubao-memory' ? fakeForm : undefined } },
  slots: {
    inject(slotName, fn) { return fn() },
    register(opts, Component) { registrations.push({ opts, Component }); return () => {} },
  },
}

mod.apply(fakeCtx)

check('注册了两个槽', () => {
  if (registrations.length !== 2) throw new Error(`注册了 ${registrations.length} 个`)
})
check('槽名与 key 正确', () => {
  const byName = Object.fromEntries(registrations.map((r) => [r.opts.name, r.opts]))
  if (!byName['plugins.bundle.config']) throw new Error('缺 bundle 槽')
  if (byName['plugins.bundle.config'].key !== 'dsh-doubao-memory') {
    throw new Error(`bundle key=${byName['plugins.bundle.config'].key}`)
  }
  if (!byName['plugins.row.config']) throw new Error('缺 row 槽')
  if (byName['plugins.row.config'].key !== 'dsh-doubao-memory#doubao-memory') {
    throw new Error(`row key=${byName['plugins.row.config'].key}`)
  }
})

const Entry = registrations.find((r) => r.opts.name === 'plugins.row.config').Component

// ── 1. summary 视图（不给 form）──────────────────────────────
let summary = null
check('summary 视图不崩', () => { summary = render(Entry, { view: 'summary' }) })
check('summary 渲染出文案', () => {
  if (!summary.tree) throw new Error('没有输出')
})

// ── 2/3. page 视图 + hooks 数量一致性 ────────────────────────
let page = null
check('page 视图不崩（有 form）', () => { page = render(Entry, { view: 'page', form: fakeForm }) })
check('page 视图渲染出了控件', () => {
  if (!page.tree) throw new Error('没有输出')
})
check('SlotEntry 分发层自身不调 hook（视图切换安全）', () => {
  const n = hookBaseline.get(Entry)
  if (n !== 0) throw new Error(`Entry 用了 ${n} 个 hook，视图切换会崩`)
})
check('切换视图后每个组件的 hooks 数量都稳定', () => {
  // 再渲染一轮：summary → page → summary
  render(Entry, { view: 'summary' })
  render(Entry, { view: 'page', form: fakeForm })
  render(Entry, { view: 'summary' })
  if (hookDrift.length) throw new Error(hookDrift.join(' | '))
})

// ── 4. page 视图但没有 form ⇒ 可读提示，不抛错 ──────────────
check('page 无 form ⇒ 提示而不是抛错', () => {
  const r = render(Entry, { view: 'page' })
  if (!r.tree) throw new Error('没有输出')
})

// ── 5. bundle 槽的 form 来自注入 ───────────────────────────
{
  const Bundle = registrations.find((r) => r.opts.name === 'plugins.bundle.config').Component
  check('bundle 页能用注入的 configForm', () => {
    const injected = Bundle.props
    const r = render(Bundle, { view: 'page', configForm: fakeForm })
    if (!r.tree) throw new Error('没有输出')
  })
}

// ── 6. 保存时 mutate 的 ops 形状 ───────────────────────────
{
  // 直接调组件内部的 save 不现实，改为校验源码里的 ops 构造
  const src = readFileSync(CLIENT, 'utf8')
  check('ops 用 {op:"set", path:[...], value}', () => {
    if (!/op:\s*'set'/.test(src)) throw new Error('没有 op:set')
    if (!/path:\s*\[\s*'persona'/.test(src)) throw new Error('path 不是数组形式')
  })
  check('mutate 传了 revision', () => {
    if (!/mutate\(ops,\s*form\.getSnapshot\(\)\.revision\)/.test(src)) {
      throw new Error('没传 revision')
    }
  })
}

// ── 7. 折叠 + 分组保存 ─────────────────────────────────────
/** 把渲染树里的所有文本/占位符收集出来 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  if (typeof node === 'object' && node.__el) {
    const p = node.props ?? {}
    for (const k of ['placeholder', 'value', 'label']) {
      if (typeof p[k] === 'string') out.push(p[k])
    }
    if (Array.isArray(node.children)) collectText(node.children, out)
    return out
  }
  return out
}

{
  const r = render(Entry, { view: 'page', form: fakeForm })
  const text = collectText(r.tree).join(' | ')

  check('默认显示「人格详细设定」折叠标题', () => {
    if (!text.includes('人格详细设定')) throw new Error('没有折叠标题')
  })
  check('默认【不】渲染人格详情字段（折叠）', () => {
    for (const marker of ['一句话自我定位', '核心性格特质', '说话风格', '禁忌 / 边界']) {
      if (text.includes(marker)) throw new Error(`折叠状态下仍然渲染了 ${marker}`)
    }
  })
  check('人格选择有独立保存按钮', () => {
    if (!text.includes('保存人格选择')) throw new Error('缺「保存人格选择」')
  })
  check('模型有独立保存按钮', () => {
    if (!text.includes('保存模型设置')) throw new Error('缺「保存模型设置」')
  })
  check('折叠时没有「保存人格设定」按钮', () => {
    if (text.includes('保存人格设定')) throw new Error('折叠状态下不该有该按钮')
  })
  check('有「新建人格」按钮', () => {
    if (!text.includes('新建人格')) throw new Error('缺「新建人格」')
  })
}

check('源码里三组各自 mutate（不是一次性全写）', () => {
  const src = readFileSync(CLIENT, 'utf8')
  for (const g of ["saveGroup('sel'", "saveGroup('persona'", "saveGroup('model'"]) {
    if (!src.includes(g)) throw new Error(`缺 ${g}`)
  }
})


// ── 8. 所有模型字段都是下拉（有目录时）──────────────────────
{
  const src = readFileSync(CLIENT, 'utf8')
  check('模型区用统一的 modelPicker（provider+model 成对）', () => {
    if (!/const modelPicker = \(/.test(src)) throw new Error('没有 modelPicker')
  })
  check('phase / 住相 / 主动搭讪 三处都用 modelPicker', () => {
    for (const k of ["modelPicker('phase'", "modelPicker('snap'", "modelPicker('pro'"]) {
      if (!src.includes(k)) throw new Error(`缺 ${k}`)
    }
  })
  check('modelPicker 里 provider 和 model 都渲染成 select', () => {
    const at = src.indexOf('const modelPicker = (')
    const block = src.slice(at, at + 2600)
    const selects = (block.match(/h\('select'/g) || []).length
    if (selects < 2) throw new Error(`只有 ${selects} 个 select`)
  })
  check('保存模型会写 snapshot / proactive 的 provider+model', () => {
    for (const p of ["['snapshot', 'model', 'provider']", "['snapshot', 'model', 'model']",
                     "['proactive', 'model', 'provider']", "['proactive', 'model', 'model']"]) {
      if (!src.includes(p)) throw new Error(`缺 ${p}`)
    }
  })
}


// ── 9. remote 服务注入（2026-11-14 回归）────────────────────
// 第一版只注入了 slots/configForms，却直接用 ctx.remote.session.*，
// cordis 抛错被 catch 吞掉 ⇒ 人格列表和模型目录双双读空。
{
  check('inject 包含 remote / remote.session / remote.workspaceFiles', () => {
    for (const s of ['remote', 'remote.session', 'remote.workspaceFiles']) {
      if (!mod.inject.includes(s)) throw new Error(`缺 ${s}`)
    }
  })
  check('读模型目录真的走 ctx.remote.session.modelCatalog', () => {
    const src = readFileSync(CLIENT, 'utf8')
    if (!src.includes('remote?.session?.modelCatalog')) throw new Error('没调 modelCatalog')
  })
  check('读人格清单真的走 ctx.remote.workspaceFiles.read', () => {
    const src = readFileSync(CLIENT, 'utf8')
    if (!src.includes('remote?.workspaceFiles?.read')) throw new Error('没调 workspaceFiles.read')
  })
}


// ── 10. session/list 必须带一个空对象（回归）────────────────
// 2026-11-14：`list()` 报 "expected 1 business argument(s) ... got 0"，
// 因为 SessionListRequest 虽是空对象也要显式传。
{
  const src = readFileSync(CLIENT, 'utf8')
  check('session.list 传了空对象参数', () => {
    if (!/session\?\.list\?\.\(\{\}\)/.test(src)) throw new Error('没传 {}')
  })
  check('读清单会遍历多个会话（工作区可能不匹配）', () => {
    if (!src.includes('const candidates = list')) throw new Error('没有候选循环')
  })
}


// ── 11. 读清单要解 {ok,value} 包装（回归）──────────────────
// 2026-11-14：read 成功但正文在 .value.text，直接取 .text ⇒ 一直报"清单为空"。
{
  const src = readFileSync(CLIENT, 'utf8')
  check('read 结果先解 value 包装', () => {
    if (!src.includes('const file = raw?.value ?? raw')) throw new Error('没解包装')
  })
  check('兼容 text / content 两种正文字段', () => {
    if (!src.includes("file?.text ?? file?.content")) throw new Error('没兼容 content')
  })
  check('网关 ok:false 当成错误而不是空内容', () => {
    if (!src.includes("raw.ok === false")) throw new Error('没处理 ok:false')
  })
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}  (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
