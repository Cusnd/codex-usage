param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexUsage\tools'),
  [switch]$NoUserPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64','x86')) { throw 'This release supports Windows x64.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$runtimeRoot = Join-Path $InstallRoot 'runtime'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$compatible = $false
if ($nodePath) {
  $probe = & $nodePath -p 'JSON.stringify({version:process.versions.node,arch:process.arch})' | ConvertFrom-Json
  $compatible = ([version]$probe.version -ge [version]'26.7.0' -and $probe.arch -eq 'x64')
  if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $nodePath) 'node_modules/npm/bin/npm-cli.js'))) { $compatible = $false }
}
if (-not $compatible) {
  $runtimeVersion = '26.7.0'
  $archive = "node-v$runtimeVersion-win-x64.zip"
  $runtimeUrl = "https://nodejs.org/dist/v$runtimeVersion"
  $zip = Join-Path $InstallRoot $archive
  $sums = (Invoke-WebRequest -UseBasicParsing "$runtimeUrl/SHASUMS256.txt").Content
  $line = ($sums -split "`n" | Where-Object { $_ -match ('\s+' + [regex]::Escape($archive) + '\s*$') })
  if (@($line).Count -ne 1) { throw 'Official Node checksum missing or ambiguous.' }
  Invoke-WebRequest -UseBasicParsing "$runtimeUrl/$archive" -OutFile $zip
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ine ($line.Trim() -split '\s+')[0]) { throw 'Node checksum mismatch.' }
  Expand-Archive -LiteralPath $zip -DestinationPath $runtimeRoot -Force
  $nodePath = Join-Path $runtimeRoot "node-v$runtimeVersion-win-x64/node.exe"
}
$npmCli = Join-Path (Split-Path $nodePath) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'The selected Node installation does not include npm. Install the official Node Windows distribution and retry.' }
$oldCli = Join-Path $InstallRoot 'node_modules/codex-detailed-usage/bin/codex-usage.mjs'
$wasEnabled = $false
if (Test-Path -LiteralPath $oldCli) {
  $startup = & $nodePath $oldCli autostart status --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the previous installation.' }
  $wasEnabled = $startup.enabled
  & $nodePath $oldCli stop --json
  if ($LASTEXITCODE -ne 0) { throw 'Stop the previous service before upgrading.' }
}
$release = Invoke-RestMethod -Headers @{ 'User-Agent'='CodexUsageInstaller'; Accept='application/vnd.github+json' } 'https://api.github.com/repos/Cusnd/codex-usage/releases/latest'
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v\d+\.\d+\.\d+$') { throw 'No supported stable release found.' }
$package = @($release.assets | Where-Object { $_.name -match '^codex-detailed-usage-\d+\.\d+\.\d+\.tgz$' })
$checksums = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS' })
if ($package.Count -ne 1 -or $checksums.Count -ne 1) { throw 'Release package/checksum assets are missing or ambiguous.' }
foreach ($asset in @($package[0], $checksums[0])) {
  if (-not $asset.browser_download_url.StartsWith('https://github.com/Cusnd/codex-usage/releases/download/')) { throw 'Unexpected release asset host or repository.' }
}
$packageFile = Join-Path $InstallRoot $package[0].name
Invoke-WebRequest -UseBasicParsing $package[0].browser_download_url -OutFile $packageFile
$sums = (Invoke-WebRequest -UseBasicParsing $checksums[0].browser_download_url).Content
$line = @($sums -split "`n" | Where-Object { $_ -match ('\s+' + [regex]::Escape($package[0].name) + '\s*$') })
if ($line.Count -ne 1 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $packageFile).Hash -ine ($line[0].Trim() -split '\s+')[0]) { throw 'Release package checksum mismatch.' }
& $nodePath $npmCli install --global --prefix $InstallRoot --ignore-scripts $packageFile
if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
# npm shims prefer node.exe beside themselves. Pin the verified executable so
# an older system Node earlier in PATH cannot break a successful installation.
$shimNode = Join-Path $InstallRoot 'node.exe'
if ([IO.Path]::GetFullPath($nodePath) -ine [IO.Path]::GetFullPath($shimNode)) {
  Copy-Item -LiteralPath $nodePath -Destination $shimNode -Force
}
$nodePath = $shimNode
$newPaths = @($InstallRoot)
$env:Path = ($newPaths + @($env:Path -split ';' | Where-Object { $_ -and $_ -notin $newPaths })) -join ';'
if (-not $NoUserPath) {
  $oldUserPath = [Environment]::GetEnvironmentVariable('Path','User')
  $userPaths = @($oldUserPath -split ';' | Where-Object { $_ })
  foreach ($entry in $newPaths) { if ($entry -notin $userPaths) { $userPaths += $entry } }
  [Environment]::SetEnvironmentVariable('Path', ($userPaths -join ';'), 'User')
}
& $nodePath $oldCli --version
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI failed.' }
if ($wasEnabled) { & $nodePath $oldCli autostart enable --json; if ($LASTEXITCODE -ne 0) { throw 'Could not update the startup launcher.' } }
& $nodePath $oldCli doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed.' }
Write-Output "Installed $($release.tag_name). Open a new terminal and run codex-usage. Autostart is unchanged; use the Web settings to opt in."
