$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$taskArtifact = Join-Path $taskRoot 'artifacts/cloud-online-20260913'
$taskRecord = Get-Content -LiteralPath (Join-Path $taskArtifact 'processes.json') -Raw | ConvertFrom-Json
$taskAll = @(Get-CimInstance Win32_Process)
$taskRootProcess = $taskAll | Where-Object ProcessId -eq $taskRecord.rootPid
$taskIds = [System.Collections.Generic.HashSet[int]]::new()
if ($taskRootProcess) {
  if ($taskRootProcess.CreationDate.ToUniversalTime().ToString('o') -ne ([DateTime]$taskRecord.rootStartTimeUtc).ToUniversalTime().ToString('o') -or !$taskRootProcess.CommandLine.Contains('cloud-online-20260913')) { throw 'Root PID ownership changed; no process was stopped.' }
  [void]$taskIds.Add([int]$taskRecord.rootPid)
  do { $taskAdded = $false; foreach ($taskProcess in $taskAll) { if ($taskIds.Contains([int]$taskProcess.ParentProcessId) -and $taskIds.Add([int]$taskProcess.ProcessId)) { $taskAdded = $true } } } while ($taskAdded)
} else {
  foreach ($taskSaved in $taskRecord.processes) {
    $taskLive = $taskAll | Where-Object ProcessId -eq $taskSaved.ProcessId
    if ($taskLive -and $taskLive.CreationDate.ToUniversalTime().ToString('o') -eq ([DateTime]$taskSaved.CreationDate).ToUniversalTime().ToString('o')) { [void]$taskIds.Add([int]$taskLive.ProcessId) }
  }
}
$taskStopped = @($taskAll | Where-Object { $taskIds.Contains([int]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, Name)
# Stop only the verified task process tree; do not touch any other Workerd instance.
foreach ($taskId in @($taskIds | Where-Object { $_ -ne [int]$taskRecord.rootPid })) { Stop-Process -Id $taskId -Force -ErrorAction SilentlyContinue }
if ($taskIds.Contains([int]$taskRecord.rootPid)) { Stop-Process -Id ([int]$taskRecord.rootPid) -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
$taskListeners = @(Get-NetTCPConnection -LocalPort 18790 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess)
$taskCleanup = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); stopped = $taskStopped; remainingListeners = $taskListeners; portClosed = $taskListeners.Count -eq 0 }
$taskCleanup | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskArtifact 'cleanup.json') -Encoding utf8
$taskCleanup | ConvertTo-Json -Depth 6
