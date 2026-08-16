# setup.ps1 — install & register the dsh-quant-data-mcp bundle into dsh.
#
# No hardcoded paths beyond the default dsh home layout. What it does:
#   1. Copies this bundle into  <DshHome>\profiles\node_modules\dsh-quant-data-mcp\
#   2. Adds "dsh-quant-data-mcp" to the web profile's dsh.profile.bundles
#      (backup of package.json first).
#   3. Prints the env vars you must set before launching dsh.
#
# Usage:
#   pwsh -File setup.ps1
#   pwsh -File setup.ps1 -DshHome X:\path\to\.dsh -Node X:\path\to\node.exe
#
# After running, set the 3 env vars (see output) in your dsh launch script,
# then restart dsh. No pnpm, no build step.

param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Node = (Join-Path $env:USERPROFILE '.workbuddy/binaries/node/versions/22.22.2/node.exe')
)

$ErrorActionPreference = 'Stop'
$bundleName = 'dsh-quant-data-mcp'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $DshHome "profiles/node_modules/$bundleName"
$webPkg = Join-Path $DshHome 'profiles/web/package.json'

if (-not (Test-Path $webPkg)) {
  Write-Error "Cannot find dsh web profile at: $webPkg`nPass -DshHome to your .dsh directory."
  exit 1
}
if (-not (Test-Path $Node)) {
  Write-Warning "Node not found at default path: $Node`nPass -Node to your Node executable."
  $Node = 'node'
}

# 1) copy bundle (lib + meta), no overwrite of user-edited files beyond our own
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
Copy-Item (Join-Path $src 'package.json') $dest -Force
Copy-Item (Join-Path $src 'cordis.patch.yml') $dest -Force
Copy-Item (Join-Path $src 'lib') (Join-Path $dest 'lib') -Recurse -Force
Write-Host "[ok] bundle copied to $dest"

# 2) register in web profile bundles (backup first)
$backup = $webPkg + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
Copy-Item $webPkg $backup
$edit = @'
const fs = require('fs');
const p = process.argv[1], name = 'dsh-quant-data-mcp';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.dsh = j.dsh || {}; j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = j.dsh.profile.bundles || [];
if (!j.dsh.profile.bundles.includes(name)) j.dsh.profile.bundles.push(name);
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('[ok] registered ' + name);
'@
$editFile = Join-Path $env:TEMP 'register-quant-bundle.js'
Set-Content -Path $editFile -Value $edit -Encoding UTF8
& $Node $editFile $webPkg

# 3) print env vars to set before launching dsh
$server = Join-Path $dest 'lib/quant-mcp-server.mjs'
$cwd = Join-Path $env:USERPROFILE 'quant-workspace'
Write-Host ""
Write-Host "Set these BEFORE launching dsh (in your dsh-web-dual.cmd or shell):"
Write-Host ('  set "QUANT_MCP_NODE=' + $Node + '"')
Write-Host ('  set "QUANT_MCP_SERVER=' + $server + '"')
Write-Host ('  set "QUANT_MCP_CWD=' + $cwd + '"')
Write-Host '  REM optional: set "QUANT_MCP_LOG=C:\path\to\quant-mcp.log"'
Write-Host ""
Write-Host "Then (re)start dsh and check the log for 'sent tools/list with 6 tools'."
