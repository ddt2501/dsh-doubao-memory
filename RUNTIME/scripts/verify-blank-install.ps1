# ============================================================================
# verify-blank-install.ps1 —— 「空白安装」验收脚本
#
# 回答一个问题：**一个从没见过这个插件的人，装上它之后，DSH 能不能自己跑起来？**
#
# 它做一次**完全隔离**的实测（独立 DSH_HOME + 独立 profile + 独立端口）：
#   1. 装插件到隔离 profile
#   2. 写 patch 行（dataRoot 指向一个空目录）
#   3. 起一个隔离的 web server
#   4. 验收：
#      ① 人格实例自己长出来（SOUL/IDENTITY/USER/VAULT/RAW/state）
#      ② 人格入口 AGENTS.md 写到工作区根，路径展开、.md 完整
#      ③ 四个 phase 就绪（没有会话 ⇒ defer，等第一个会话出现再补注册）
#      ④ **插件包本身没被污染**（人格没写进包里）
#      ⑤ stderr 干净
#   6. 收工（杀掉测试 server，删掉临时目录）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File verify-blank-install.ps1
#   powershell -ExecutionPolicy Bypass -File verify-blank-install.ps1 -Keep   # 保留现场
# ============================================================================
param(
  [string]$Dsh = 'D:\tools\nodejs\node_cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js',
  [string]$Node = 'D:\nvm4w\nodejs\node.exe',
  [int]$Port = 3099,
  [switch]$Keep,
  [ValidateSet('top', 'memory')]
  [string]$NamesUnder = 'top'      # 称呼写在顶层还是 memory.* 下（两种都得认）
)

$ErrorActionPreference = 'Continue'
$PackageRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # RUNTIME\scripts → 包根
$TestHome = Join-Path $env:TEMP "dsh-blank-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$Workspace = Join-Path $TestHome 'workspace'
$DataRoot = Join-Path $TestHome 'persona\tester'
$ProfileDir = Join-Path $TestHome 'profiles\web'

$failed = 0
function Check($name, $cond, $extra = '') {
  if (-not $cond) { $script:failed++ }
  Write-Host ("{0}  {1}{2}" -f $(if ($cond) { 'PASS' } else { 'FAIL' }), $name, $(if ($extra) { "  $extra" } else { '' }))
}
function Say($m) { Write-Host "[verify] $m" }

Say "隔离 home: $TestHome"
New-Item -ItemType Directory -Force -Path $TestHome, $Workspace | Out-Null
$env:DSH_HOME = $TestHome

# 1) 装插件
Push-Location $TestHome
& $Node $Dsh plugin --profile web add $PackageRoot 2>&1 | Select-Object -Last 3 | ForEach-Object { Say $_ }
Pop-Location

# 2) 写 patch 行（注意：profile 默认的 cordis.patch.yml 内容是 `[]`，
#    **必须替换**而不是追加 —— 追加会得到非法 YAML）
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
# 称呼写在哪一层，是个真实的坑：profile 里两种都见过，
# 而插件早期只认顶层 ⇒ 线上跑成默认的「用户/助手」。
# 所以两种写法都要能装。
$cfgLines = @(
  '# blank-install verification',
  '- id: doubao-memory',
  '  name: dsh-doubao-memory',
  '  disabled: false',
  '  config:',
  "    dataRoot: '$($DataRoot -replace '\\','/')'"
)
if ($NamesUnder -eq 'top') {
  $cfgLines += "    userName: '小王'"
  $cfgLines += "    assistantName: '小助手'"
}
$cfgLines += '    memory:'
$cfgLines += '      enabled: true'
$cfgLines += "      targetCwd: '$($Workspace -replace '\\','/')'"
if ($NamesUnder -eq 'memory') {
  $cfgLines += "      userName: '小王'"
  $cfgLines += "      assistantName: '小助手'"
}
$content = ($cfgLines -join "`n") + "`n"
[System.IO.File]::WriteAllText($patch, $content, (New-Object System.Text.UTF8Encoding($false)))
Say "配置形状：称呼写在 $NamesUnder 层"

# 3) 起 server
$out = Join-Path $TestHome 'web.out.log'
$err = Join-Path $TestHome 'web.err.log'
$proc = Start-Process -FilePath $Node -ArgumentList $Dsh, 'web', '--port', "$Port", '--no-open' `
  -WorkingDirectory $Workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Say "server pid=$($proc.Id) port=$Port"
Start-Sleep -Seconds 25

# 4) 验收
Check '① 人格实例自己长出来' (Test-Path (Join-Path $DataRoot 'IDENTITY\SOUL.md'))
Check '① vault 骨架在' (Test-Path (Join-Path $DataRoot 'VAULT\00-INDEX.md'))
Check '① raw 目录在' (Test-Path (Join-Path $DataRoot 'RAW\conversations'))
Check '② 人格入口写到工作区根' (Test-Path (Join-Path $Workspace 'AGENTS.md'))
if (Test-Path (Join-Path $Workspace 'AGENTS.md')) {
  $entry = Get-Content (Join-Path $Workspace 'AGENTS.md') -Raw
  Check '② 路径已展开成绝对路径' ($entry -match [regex]::Escape($DataRoot))
  Check '② .md 后缀没被吃掉' ($entry -notmatch 'IDENTITY\\SOUL`')
  Check '② 人格名字已替换' ($entry -match '小助手')
}
# 实例自己的 AGENTS.md（人格的"家"）也不能留字面占位符
$instEntry = Join-Path $DataRoot 'IDENTITY\AGENTS.md'
if (Test-Path $instEntry) {
  $ie = Get-Content $instEntry -Raw
  Check '② 实例 AGENTS.md 没有字面占位符' ($ie -notmatch '\{(USER|ASSISTANT|PKG|DATA)\}')
  Check '② 实例 AGENTS.md 用了真名' ($ie -match '小助手')
} else {
  Check '② 实例 AGENTS.md 存在' $false
}
$instAlaya = Join-Path $DataRoot 'RUNTIME\manas-system\ALAYA.md'
Check '② 阿赖耶识锚已就位' (Test-Path $instAlaya)
$msLog = Join-Path $DataRoot 'RUNTIME\state\memory-system.log'
if (Test-Path $msLog) {
  $ms = Get-Content $msLog -Raw
  Check '③ phase 已就绪（defer 或 created）' (($ms -match 'deferred') -or ($ms -match '"created"'))
  Check '③ phase 标题用真名不是占位符' (($ms -match '小助手') -and ($ms -notmatch '\{ASSISTANT\}'))
} else {
  Check '③ phase 接线有日志' $false '没有 memory-system.log'
}
$bad = @()
foreach ($f in @('AGENTS.md', 'MEMORY.md', 'SNAPSHOT_LATEST.md')) { if (Test-Path (Join-Path $PackageRoot $f)) { $bad += $f } }
foreach ($d in @('IDENTITY', 'VAULT', 'RAW', 'instance')) { if (Test-Path (Join-Path $PackageRoot $d)) { $bad += $d } }
if (Test-Path (Join-Path $PackageRoot 'RUNTIME\state')) { $bad += 'RUNTIME/state' }
Check '④ 插件包没被污染' ($bad.Count -eq 0) ($bad -join ', ')
$errSize = if (Test-Path $err) { (Get-Item $err).Length } else { 0 }
Check '⑤ stderr 干净' ($errSize -eq 0) "$errSize 字节"

# 5) 收工
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Seconds 2
if ($Keep) { Say "保留现场: $TestHome" } else { Remove-Item $TestHome -Recurse -Force -ErrorAction SilentlyContinue }

Say $(if ($failed -eq 0) { 'ALL PASS —— 空白安装可用' } else { "$failed 项不通过" })
exit $failed
