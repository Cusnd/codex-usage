$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$taskArtifact = Join-Path $taskRoot 'artifacts/cloud-online-20260913'
$taskConfig = Join-Path $PSScriptRoot 'wrangler.jsonc'
$taskPersist = Join-Path $taskArtifact 'wrangler'
$taskNode = (Get-Command node).Source
$taskWrangler = Join-Path $taskRoot 'cloud/node_modules/wrangler/bin/wrangler.js'
if (!(Test-Path -LiteralPath (Join-Path $taskArtifact 'build/index.html'))) { throw 'Build the candidate into artifacts/cloud-online-20260913/build first.' }
if (Get-NetTCPConnection -LocalPort 18790 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 18790 already has a listener; no process was stopped.' }
New-Item -ItemType Directory -Force -Path $taskArtifact | Out-Null
Push-Location -LiteralPath $taskRoot
try {
  & $taskNode $taskWrangler d1 migrations apply DB --local --config $taskConfig --persist-to $taskPersist
  if ($LASTEXITCODE -ne 0) { throw 'Local fixture migration failed.' }
  $taskArgs = @($taskWrangler, 'dev', '--config', $taskConfig, '--ip', '127.0.0.1', '--port', '18790', '--persist-to', $taskPersist, '--show-interactive-dev-session=false')
  $taskQuoted = $taskArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
  $taskServer = Start-Process -FilePath $taskNode -ArgumentList $taskQuoted -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskArtifact 'server.stdout.log') -RedirectStandardError (Join-Path $taskArtifact 'server.stderr.log')
  $taskRootInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskServer.Id)
  $taskRecord = [ordered]@{ rootPid = $taskServer.Id; rootStartTimeUtc = $taskRootInfo.CreationDate.ToUniversalTime().ToString('o'); config = $taskConfig; port = 18790; artifact = $taskArtifact; createdAt = [DateTime]::UtcNow.ToString('o') }
  $taskRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskArtifact 'processes.json') -Encoding utf8
  $taskReady = $false
  for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
    try { $taskHealth = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18790/api/health' -TimeoutSec 1; if ($taskHealth.StatusCode -eq 200) { $taskReady = $true; break } } catch {}
    if ($taskServer.HasExited) { throw 'Wrangler exited; inspect server logs.' }
    Start-Sleep -Milliseconds 250
  }
  if (!$taskReady) { throw 'Fixture did not become ready; owned PID is recorded in processes.json for cleanup.' }
  $taskAll = @(Get-CimInstance Win32_Process)
  $taskIds = [System.Collections.Generic.HashSet[int]]::new(); [void]$taskIds.Add($taskServer.Id)
  do { $taskAdded = $false; foreach ($taskProcess in $taskAll) { if ($taskIds.Contains([int]$taskProcess.ParentProcessId) -and $taskIds.Add([int]$taskProcess.ProcessId)) { $taskAdded = $true } } } while ($taskAdded)
  $taskRecord.processes = @($taskAll | Where-Object { $taskIds.Contains([int]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, CreationDate, Name, CommandLine)
  $taskRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskArtifact 'processes.json') -Encoding utf8
  Write-Output ('Ready: http://127.0.0.1:18790/__online ; owned root PID ' + $taskServer.Id)
} finally { Pop-Location }
