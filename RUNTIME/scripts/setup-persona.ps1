# ============================================================================
# setup-persona.ps1 —— 创建一个人格实例（另一个用户的"助手"）
#
# 从 templates/ 复制出骨架，并生成**人格入口** AGENTS.md。
# DSH 的 dsh-agent-instructions 只自动加载**工作区根**的 AGENTS.md，
# 所以那一份要按本机路径展开（源文件在 templates/ 里用相对路径）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File setup-persona.ps1 `
#     -DataRoot "D:\dsh\persona\alice" -Workspace "D:\dsh"
# ============================================================================
param(
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [string]$Workspace = '',
  [string]$Name = '你的人格助手',
  [string]$UserName = '对方',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # RUNTIME\scripts → 包根
$Templates = Join-Path $PackageRoot 'templates'

function Say($msg) { Write-Host "[setup] $msg" }

if (-not (Test-Path $Templates)) { Say "找不到 templates/: $Templates"; exit 1 }

# ── 1. 目录骨架 ─────────────────────────────────────────────────────────
$dirs = @(
  'IDENTITY', 'IDENTITY\PROPOSALS', 'IDENTITY\SNAPSHOTS',
  'VAULT', 'VAULT\01-IDENTITY', 'VAULT\02-USER', 'VAULT\03-RELATIONSHIP',
  'VAULT\04-INSIGHTS', 'VAULT\05-PROJECTS',
  'RAW\conversations', 'RAW\moments',
  'RUNTIME\state', 'RUNTIME\manas-system\data\manas', 'RUNTIME\manas-system\data\snapshots\metrics',
  'RUNTIME\_errors', 'DESIGN'
)
foreach ($d in $dirs) {
  $p = Join-Path $DataRoot $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
}
Say "目录骨架就绪: $DataRoot"

# ── 2. 复制模板文件（不覆盖已存在的）───────────────────────────────
$copied = 0
Get-ChildItem $Templates -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($Templates.Length + 1)
  $target = Join-Path $DataRoot $rel
  if ((Test-Path $target) -and -not $Force) { return }
  $parent = Split-Path -Parent $target
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item $_.FullName $target -Force
  $copied++
}
Say "模板文件复制 $copied 个"

# ── 3. 生成人格入口 AGENTS.md（工作区根，路径展开）────────────────────
if ($Workspace) {
  $source = Join-Path $DataRoot 'IDENTITY\AGENTS.md'
  $target = Join-Path $Workspace 'AGENTS.md'
  if ((Test-Path $source) -and (-not (Test-Path $target) -or $Force)) {
    $text = [System.IO.File]::ReadAllText($source)
    # `相对路径.md` → `绝对路径.md`
    $expanded = [regex]::Replace($text, '`([A-Za-z0-9_\-./\\一-鿿（）]+)\.md`', {
      param($m)
      $rel = $m.Groups[1].Value -replace '\\', '/'
      $abs = Join-Path $DataRoot $rel
      '`' + ($abs -replace '/', '\') + '.md`'
    })
    $expanded = $expanded.Replace('{DATA}', ($DataRoot -replace '/', '\'))
    $expanded = $expanded.Replace('{USER}', $UserName)
    $expanded = $expanded.Replace('{ASSISTANT}', $Name)
    [System.IO.File]::WriteAllText($target, $expanded, (New-Object System.Text.UTF8Encoding($false)))
    Say "人格入口已生成: $target"
  } elseif (Test-Path $target) {
    Say "人格入口已存在，未覆盖: $target"
  } else {
    Say "⚠️ 找不到模板 IDENTITY\AGENTS.md，跳过人格入口生成"
  }
}

# ── 4. 提示 ───────────────────────────────────────────────────────────
Say ''
Say '接下来三件事：'
Say "  1. 填人格：$DataRoot\IDENTITY\SOUL.md（你是谁）、USER.md（对方是谁）"
Say "  2. 在 profile 的 cordis.patch.yml 里加一行 id: doubao-memory，并把 dataRoot 指到 $DataRoot"
Say "  3. 重启 DSH web；之后第一次 wiki phase 会开始积累你的 VAULT"
Say ''
Say "诊断日志：$DataRoot\RUNTIME\state\*.log"
