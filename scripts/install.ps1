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
  $version = $null
  $compatible = ([version]::TryParse($probe.version, [ref]$version) -and ($version.Major -eq 22 -and $version.Minor -ge 13 -or $version.Major -in @(24, 26)) -and $probe.arch -eq 'x64')
  if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $nodePath) 'node_modules/npm/bin/npm-cli.js'))) { $compatible = $false }
}
if (-not $compatible) {
  $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $selected = $releases | Where-Object { $_.version -match '^v24\.\d+\.\d+$' -and $_.lts -and 'win-x64-zip' -in $_.files } | Sort-Object { [version]$_.version.Substring(1) } -Descending | Select-Object -First 1
  if (-not $selected) { throw 'No official Node 24 LTS Windows x64 release found.' }
  $runtimeVersion = $selected.version.Substring(1)
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
$supportedPackages = @('@esoren/codex-usage', 'codex-detailed-usage')
$installedPackages = @($supportedPackages | Where-Object { Test-Path -LiteralPath (Join-Path $InstallRoot "node_modules/$_/bin/codex-usage.mjs") })
if ($installedPackages.Count -gt 1) { throw 'Both legacy and scoped packages exist. Resolve the duplicate installation before upgrading.' }
# GitHub's public release redirect avoids shared-IP anonymous API rate limits.
$latest = Invoke-WebRequest -UseBasicParsing 'https://github.com/Cusnd/codex-usage/releases/latest'
$releaseUri = if ($latest.BaseResponse.ResponseUri) { $latest.BaseResponse.ResponseUri.AbsoluteUri } else { $latest.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
if ($releaseUri -notmatch '^https://github\.com/Cusnd/codex-usage/releases/tag/(v\d+\.\d+\.\d+)$') { throw 'No supported stable release found.' }
$releaseTag = $Matches[1]
$assetBase = "https://github.com/Cusnd/codex-usage/releases/download/$releaseTag"
$checksumFile = Join-Path $InstallRoot 'SHA256SUMS'
Invoke-WebRequest -UseBasicParsing "$assetBase/SHA256SUMS" -OutFile $checksumFile
$sums = Get-Content -LiteralPath $checksumFile -Raw
$scopedArchive = 'esoren-codex-usage-' + $releaseTag.Substring(1) + '.tgz'
$legacyArchive = 'codex-detailed-usage-' + $releaseTag.Substring(1) + '.tgz'
$archivePattern = '^(?<hash>[0-9a-fA-F]{64})\s+\*?(?<file>' + [regex]::Escape($scopedArchive) + '|' + [regex]::Escape($legacyArchive) + ')\s*$'
$assets = @($sums -split "`n" | ForEach-Object {
  if ($_ -match $archivePattern) { [pscustomobject]@{ File = $Matches['file']; Hash = $Matches['hash'] } }
})
if ($assets.Count -ne 1) { throw 'Expected exactly one supported release package checksum.' }
$packageName = $assets[0].File
$installedName = if ($packageName -eq $scopedArchive) { '@esoren/codex-usage' } else { 'codex-detailed-usage' }
if ($installedPackages.Count -eq 1 -and $installedPackages[0] -ne $installedName) {
  throw 'The release uses a different npm package name. Follow docs/INSTALL_FOR_AGENTS.md#migrate-a-legacy-package-to-npm before switching; the existing service and data are unchanged.'
}
$packageFile = Join-Path $InstallRoot $packageName
Invoke-WebRequest -UseBasicParsing "$assetBase/$packageName" -OutFile $packageFile
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $packageFile).Hash -ine $assets[0].Hash) { throw 'Release package checksum mismatch.' }
$installedCli = Join-Path $InstallRoot "node_modules/$installedName/bin/codex-usage.mjs"
$wasEnabled = $false
if (Test-Path -LiteralPath $installedCli) {
  $startup = & $nodePath $installedCli autostart status --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the previous installation.' }
  $wasEnabled = $startup.enabled
  & $nodePath $installedCli stop --json
  if ($LASTEXITCODE -ne 0) { throw 'Stop the previous service before upgrading.' }
}
& $nodePath $npmCli install --global --prefix $InstallRoot --no-audit --no-fund $packageFile
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
& $nodePath $installedCli --version
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI failed.' }
if ($wasEnabled) { & $nodePath $installedCli autostart enable --json; if ($LASTEXITCODE -ne 0) { throw 'Could not update the startup launcher.' } }
& $nodePath $installedCli doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed.' }
Write-Output "Installed $releaseTag. Open a new terminal and run codex-usage. Autostart is unchanged; use the Web settings to opt in."
