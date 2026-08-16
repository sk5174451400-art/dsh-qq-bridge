# dsh-qq-bridge 一键接入脚本（Windows）
#
# 作用：把本仓库的三个插件包接入本机 DSH：
#   1. 复制包源码到 DSH checkout 的 packages/
#   2. 应用 3 处 DSH 修改（settings 白名单 / web-app 挂载行 / tsconfig references）
#   3. 在 $DSH_HOME/profiles/node_modules 建 junction（patch name 可解析）
#   4. 构建（pnpm install + build:lib + build:web）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshPath "D:\Programs\deepseek-harness"
#   （不带 -DshPath 时自动探测：当前目录或仓库相邻的 deepseek-harness）
#
# 幂等：重复运行安全（已有修改/链接会跳过）。脚本不包含任何密钥。

param(
  [string]$DshPath = ""
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[dsh-qq-bridge] $msg" -ForegroundColor Cyan }

# ── 定位 DSH checkout ──────────────────────────────────────────────────────
if ($DshPath -eq "") {
  if (Test-Path ".\deepseek-harness\package.json") { $DshPath = (Resolve-Path ".\deepseek-harness").Path }
  elseif (Test-Path "..\deepseek-harness\package.json") { $DshPath = (Resolve-Path "..\deepseek-harness").Path }
  else {
    Write-Host "未找到 DSH checkout。请用 -DshPath 指定，例如：install.ps1 -DshPath D:\Programs\deepseek-harness" -ForegroundColor Yellow
    exit 1
  }
}
$DshPath = $DshPath.TrimEnd('\')
if (-not (Test-Path "$DshPath\package.json")) { Write-Host "路径无效：$DshPath 不是 DSH checkout（无 package.json）" -ForegroundColor Red; exit 1 }
Write-Step "DSH checkout: $DshPath"

$repo = $PSScriptRoot
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

# ── 1. 复制包源码 ───────────────────────────────────────────────────────────
$packages = @(
  @{ from = "$repo\packages\extensions\qq-bridge";        to = "$DshPath\packages\extensions\qq-bridge" },
  @{ from = "$repo\packages\client\ui-qq-bridge";         to = "$DshPath\packages\client\ui-qq-bridge" },
  @{ from = "$repo\packages\web\web-search-tavily";       to = "$DshPath\packages\web\web-search-tavily" }
)
foreach ($pkg in $packages) {
  if (Test-Path $pkg.to) { Remove-Item $pkg.to -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $pkg.to | Out-Null
  Get-ChildItem $pkg.from -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\.git\\' } | ForEach-Object {
    $rel = $_.FullName.Substring($pkg.from.Length)
    $target = Join-Path $pkg.to $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item $_.FullName $target -Force
  }
  Write-Step "包已复制：$(Split-Path $pkg.to -Leaf)"
}

# ── 2. 应用 DSH 修改（全部幂等）────────────────────────────────────────────

# 2a. apiproxy settings 白名单：qq-bridge 对浏览器可见
$apiproxy = "$DshPath\packages\host\apiproxy\src\api-proxy.ts"
if ((Test-Path $apiproxy) -and -not (Get-Content $apiproxy -Raw).Contains("'qq-bridge',")) {
  $content = Get-Content $apiproxy -Raw
  $content = $content -replace "(const PRODUCT_SETTINGS_NAMESPACES = new Set\(\[)", "`$1`r`n  'qq-bridge',"
  Set-Content -Path $apiproxy -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 settings 白名单（qq-bridge）"
} else { Write-Step "跳过 settings 白名单（已存在或文件缺失）" }

# 2b. web-app patch：挂载 web-search-tavily + pin 软路由
$webAppPatch = "$DshPath\packages\bundle\web-app\cordis.patch.yml"
if ((Test-Path $webAppPatch) -and -not (Get-Content $webAppPatch -Raw).Contains('web-search-tavily')) {
  $content = Get-Content $webAppPatch -Raw
  $block = @'

    # Tavily search provider + soft router (installed by dsh-qq-bridge).
    - id: web-search-tavily
      name: '@deepseek-ai/dsh-web-search-tavily'
      config:
        apiKeyEnv: TAVILY_API_KEY

    - id: web
      config:
        searchProvider: tavily-fallback
'@
  $content = $content.Replace("    - id: workspace`r`n", $block + "`r`n    - id: workspace`r`n")
  Set-Content -Path $webAppPatch -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 web-app patch（web-search-tavily + 软路由）"
} else { Write-Step "跳过 web-app patch（已存在）" }

# 2c. web-app package.json：ui-qq-bridge 依赖
$webAppPkg = "$DshPath\packages\bundle\web-app\package.json"
if ((Test-Path $webAppPkg) -and -not (Get-Content $webAppPkg -Raw).Contains('ui-qq-bridge')) {
  $content = Get-Content $webAppPkg -Raw
  $content = $content.Replace('"@deepseek-ai/dsh-client-ui-plan": "workspace:^",', '"@deepseek-ai/dsh-client-ui-plan": "workspace:^",`r`n    "@deepseek-ai/dsh-client-ui-qq-bridge": "workspace:^",')
  Set-Content -Path $webAppPkg -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 web-app 依赖（ui-qq-bridge）"
} else { Write-Step "跳过 web-app 依赖（已存在）" }

# 2d. tsconfig.host.json references
$tsHost = "$DshPath\tsconfig.host.json"
if ((Test-Path $tsHost) -and -not (Get-Content $tsHost -Raw).Contains('web-search-tavily')) {
  $content = Get-Content $tsHost -Raw
  $content = $content.Replace('{ "path": "./packages/web/web-search-deepseek" },', '{ "path": "./packages/web/web-search-deepseek" },`r`n    { "path": "./packages/web/web-search-tavily" },')
  Set-Content -Path $tsHost -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 tsconfig.host.json（web-search-tavily）"
} else { Write-Step "跳过 tsconfig.host.json（web-search-tavily 已存在）" }
if ((Test-Path $tsHost) -and -not (Get-Content $tsHost -Raw).Contains('extensions/qq-bridge')) {
  $content = Get-Content $tsHost -Raw
  $content = $content.Replace('{ "path": "./packages/extensions/tool-cordis" },', '{ "path": "./packages/extensions/tool-cordis" },`r`n    { "path": "./packages/extensions/qq-bridge" },')
  Set-Content -Path $tsHost -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 tsconfig.host.json（qq-bridge）"
} else { Write-Step "跳过 tsconfig.host.json（qq-bridge 已存在）" }

# 2e. tsconfig.client.json references
$tsClient = "$DshPath\tsconfig.client.json"
if ((Test-Path $tsClient) -and -not (Get-Content $tsClient -Raw).Contains('ui-qq-bridge')) {
  $content = Get-Content $tsClient -Raw
  $content = $content.Replace('{ "path": "./packages/client/ui-settings-plugins" },', '{ "path": "./packages/client/ui-settings-plugins" },`r`n    { "path": "./packages/client/ui-qq-bridge" },')
  Set-Content -Path $tsClient -Value $content -Encoding UTF8 -NoNewline
  Write-Step "已应用 tsconfig.client.json（ui-qq-bridge）"
} else { Write-Step "跳过 tsconfig.client.json（已存在）" }

# 2f. profile 挂载行（qq-bridge + ui-qq-bridge）
$profilePatch = "$home\profiles\web\cordis.patch.yml"
if (Test-Path $profilePatch) {
  if (-not (Get-Content $profilePatch -Raw).Contains("name: '@deepseek-ai/dsh-qq-bridge'")) {
    $block = @'

# QQ bridge (installed by dsh-qq-bridge): phone QQ drives DSH sessions.
- insert:
    - id: qq-bridge
      name: '@deepseek-ai/dsh-qq-bridge'
      config:
        appId: ''
        appSecret: ''
        allowedUsers: []
        workspaceDir: ''
    - id: ui-qq-bridge
      name: '@deepseek-ai/dsh-client-ui-qq-bridge'
'@
    Add-Content -Path $profilePatch -Value $block -Encoding UTF8
    Write-Step "已应用 profile 挂载行（qq-bridge + ui-qq-bridge）"
  } else { Write-Step "跳过 profile 挂载行（已存在）" }
} else { Write-Step "跳过 profile 挂载行（无 $profilePatch）——请按 README 手动挂载" }

# ── 3. junction（patch name 解析）──────────────────────────────────────────
$fallback = "$home\profiles\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path $fallback | Out-Null
foreach ($name in @('dsh-qq-bridge', 'dsh-client-ui-qq-bridge', 'dsh-web-search-tavily')) {
  $link = Join-Path $fallback $name
  if (-not (Test-Path $link)) {
    $src = switch ($name) {
      'dsh-qq-bridge'           { "$DshPath\packages\extensions\qq-bridge" }
      'dsh-client-ui-qq-bridge' { "$DshPath\packages\client\ui-qq-bridge" }
      'dsh-web-search-tavily'   { "$DshPath\packages\web\web-search-tavily" }
    }
    New-Item -ItemType Junction -Path $link -Target $src | Out-Null
    Write-Step "已建 junction：$name"
  } else { Write-Step "跳过 junction（已存在）：$name" }
}

# ── 4. 构建 ─────────────────────────────────────────────────────────────────
Write-Step "安装依赖 + 构建（可能需要几分钟）……"
Push-Location $DshPath
try {
  $env:HTTP_PROXY = $env:HTTP_PROXY; $env:HTTPS_PROXY = $env:HTTPS_PROXY
  pnpm install
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
  npm run build:lib
  if ($LASTEXITCODE -ne 0) { throw 'build:lib failed' }
  npm run build:web
  if ($LASTEXITCODE -ne 0) { throw 'build:web failed' }
} finally {
  Pop-Location
}

Write-Host ""
Write-Step "✅ 接入完成！下一步："
Write-Host "  1. 重启 DSH（dsh web / 你的启动器）"
Write-Host "  2. 设置 → 插件配置 → QQ 连接：填 AppID/AppSecret → 测试连接 → 保存"
Write-Host "  3. 手机 QQ 发消息即可使用（/mulu 看菜单，/huihua N 选会话）"
Write-Host "  4. 搜索已切换为 Tavily（软路由：Tavily 失败自动回 DeepSeek）"
