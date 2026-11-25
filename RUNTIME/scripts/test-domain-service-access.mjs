/**
 * 验证 `ctx.get('storageDomain', false)` 的取法是对的。
 *
 * 背景（2026-11-17）：第一次接 domain 时直接写 `ctx.storageDomain`，
 * DSH 真实环境抛 "cannot get property \"storageDomain\" without inject"
 * ——Cordis 的 scope 是 Proxy，没 inject 进来的服务**直接取属性会抛**，不是返回 undefined。
 *
 * 正确姿势：`ctx.get(name, false)`（第二个参数 false = 没有也不报错）。
 * 这个用法本仓库已有先例（lib/phase-detect.js 取 sessionTitle）。
 */
import { openProactiveDomain } from '../../lib/proactive/storage.js'

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ── 1. 正常 scope：get(name,false) 拿到服务 ────────────────
{
  const scope = {
    get: (n) => (n === 'storageDomain' ? { open: async () => ({ marker: 'domain-ok' }) } : undefined),
  }
  const d = await openProactiveDomain(scope, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('scope.get 方式能拿到 domain', d?.marker === 'domain-ok')
}

// ── 2. Cordis Proxy：直接取属性会抛 ⇒ 必须用 get ──────────
{
  const bad = new Proxy({}, {
    get(target, prop) {
      if (prop === 'storageDomain') {
        throw new Error('cannot get property "storageDomain" without inject')
      }
      return target[prop]
    },
  })
  const d = await openProactiveDomain(bad, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('Proxy scope ⇒ 安全回落 null 而不是崩', d === null)
}

// ── 3. 服务真的缺席（get 返回 undefined）──────────────────
{
  const scope = { get: () => undefined }
  const d = await openProactiveDomain(scope, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('服务缺席 ⇒ 返回 null', d === null)
}

// ── 4. open 抛错（同名域已开 / 路由缺失）⇒ 回落不崩 ──────
{
  const scope = {
    get: (n) => (n === 'storageDomain' ? {
      open: async () => { throw new Error('already-open') },
    } : undefined),
  }
  const d = await openProactiveDomain(scope, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('open 抛错 ⇒ 返回 null 不崩', d === null)
}

// ── 5. **接管泄漏的 domain**（2026-11-17 的真 bug）──────────
//
// 热重载时旧实例泄漏了 domain 句柄（它的代码里没有 close），
// 于是每次 open() 都撞 'already open'。
// facility 有 get(name)（dsh-storage-domain/lib/index.js:431）⇒
// 正解是**接管那个句柄**：关掉它、等名字释放、再开新的。
{
  let closed = false
  const leaked = {
    close: async () => { closed = true },
  }
  let openCalls = 0
  const fresh = { marker: 'fresh-domain' }
  const scope = {
    get: (n) => (n === 'storageDomain' ? {
      // 第一次撞 already-open，第二次（名字释放后）成功
      open: async () => {
        openCalls++
        if (openCalls === 1) throw new Error("domain 'doubao_proactive' is already open")
        return fresh
      },
      get: (name) => (name === 'doubao_proactive' ? leaked : undefined),
    } : undefined),
  }
  const d = await openProactiveDomain(scope, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('接管泄漏句柄后能拿到新 domain', d?.marker === 'fresh-domain', d?.marker)
  check('泄漏的旧句柄被关掉了', closed === true)
  check('重试期间确实重试过 open', openCalls >= 2, `open 调了 ${openCalls} 次`)
}

// ── 6. facility 没有 get() ⇒ 仍能回落（不崩）────────────────
{
  const scope = {
    get: (n) => (n === 'storageDomain' ? {
      open: async () => { throw new Error("domain 'doubao_proactive' is already open") },
    } : undefined),
  }
  const d = await openProactiveDomain(scope, 'C:/Users/ddt/AppData/Local/Temp/probe-domain.log')
  check('facility 无 get() ⇒ 安全回落 null', d === null)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
