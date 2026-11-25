<#
.SYNOPSIS
    重新 vendor 插件的运行时依赖（并裁掉用不上的部分）。

.DESCRIPTION
    为什么要有这个脚本：
    这个插件是以 `link:` 方式装进 DSH profile 的（正规的开发期装法）。
    ⓘ **`link:` 装的包，pnpm 不会接管它自己的依赖**——
       profile 的 pnpm-lock.yaml 里只有一行 `link:` 记录，
       不会替插件装 `zod` / `@deepseek-ai/schemastery`。
    ⇒ 依赖必须**跟着包走**，否则换个机器 clone 下来就是坏的。

    ⓘ Node 解析裸包名时会先把 junction 解析成**真实路径**
       （`D:\dsh\packages\dsh-doubao-memory\...`），
       再往上找 `node_modules` ⇒ 依赖必须放在**包自己的** node_modules 里。

    所以：vendor 到 `node_modules/`，并用 `.gitignore` 的反规则**纳入 git**。

    裁剪说明（zod 5.86 MB → 约 2.5 MB）：
      - `src/`  —— 只在 `@zod/source` 这个 export 条件下可达（那是给源码映射用的
                   开发期条件，Node 运行时不会命中）⇒ 可删
      - `v3/`   —— zod v3 兼容层，只在 `import 'zod/v3'` 子路径下可达 ⇒ 我们不用 ⇒ 可删
      保留：`v4/`（classic + core + locales，运行时真正要用的）、`mini/`、`index.js`

.PARAMETER Source
    依赖的来源根目录（默认从 DSH 安装目录找）。

.EXAMPLE
    pwsh -File RUNTIME\scripts\vendor-deps.ps1
#>
[CmdletBinding()]
param(
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot = <包根>\RUNTIME\scripts ⇒ 上两级才是包根
$pkgRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$target = Join-Path $pkgRoot 'node_modules'

function Say($msg) { Write-Host $msg }

# ── 1. 找来源 ──────────────────────────────────────────────────
if (-not $Source) {
  $candidates = @(
    'D:\tools\nodejs\node_cache\_npx\1e7f6d9597241db0\node_modules',
    'C:\Users\ddt\.dsh\profiles\node_modules'
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'zod')) { $Source = $c; break }
  }
}
if (-not $Source -or -not (Test-Path (Join-Path $Source 'zod'))) {
  throw "找不到依赖来源（需要含 zod/ 的 node_modules 根目录）。用 -Source 指定。"
}
Say "来源: $Source"

# ── 2. 复制 ────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $target -Force | Out-Null

function Copy-Dep($name, $from, $to) {
  if (-not (Test-Path $from)) { Say "  跳过 $name（来源没有）"; return }
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
  Say "  ✓ $name"
}

Say "复制依赖…"
Copy-Dep 'zod'      (Join-Path $Source 'zod')                     (Join-Path $target 'zod')
Copy-Dep 'schemastery' (Join-Path $Source '@deepseek-ai\schemastery') (Join-Path $target '@deepseek-ai\schemastery')
Copy-Dep 'cosmokit' (Join-Path $Source '@deepseek-ai\cosmokit')    (Join-Path $target '@deepseek-ai\cosmokit')
Copy-Dep 'standard-schema' (Join-Path $Source '@standard-schema\spec') (Join-Path $target '@standard-schema\spec')

# ── 3. 裁剪 ────────────────────────────────────────────────────
Say "裁剪 zod…"
$zod = Join-Path $target 'zod'
foreach ($cut in @('src', 'v3')) {
  $p = Join-Path $zod $cut
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Say "  - $cut" }
}

# ── 4. 报告 ────────────────────────────────────────────────────
$mb = [math]::Round(((Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
Say "vendor 完成：$target  ($mb MB)"

# ── 5. 自检：能不能 import ─────────────────────────────────────
# ⚠️ 检查脚本必须**放在包里**跑（或把 cwd 设成包根）——
#    Node 是按**文件所在目录**往上找 node_modules 的，
#    放在 TEMP 里跑必然 ERR_MODULE_NOT_FOUND（跟 vendor 有没有没关系）。
Say "自检…"
$check = @'
(async () => {
  for (const n of ['@deepseek-ai/schemastery', 'zod']) {
    try { await import(n); console.log('  OK  ' + n) }
    catch (e) { console.log('  FAIL ' + n + ' ' + (e.code || e.message)); process.exitCode = 1 }
  }
})()
'@
$tmp = Join-Path $pkgRoot ('.vendor-check-' + [guid]::NewGuid().ToString('N') + '.mjs')
Set-Content -Path $tmp -Value $check -Encoding UTF8
try { & node $tmp } finally { Remove-Item $tmp -Force }
