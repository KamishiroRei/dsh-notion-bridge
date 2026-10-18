param(
    [ValidateSet('start', 'status', 'stop')][string]$Action = 'status',
    [string]$Cloudflared = 'cloudflared.exe',
    [string]$StateDirectory = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'dsh-notion-bridge')
)
$ErrorActionPreference = 'Stop'
$taskOrigin = 'http://127.0.0.1:18748'
$taskMetrics = '127.0.0.1:18749'
$taskRecordPath = Join-Path $StateDirectory 'gateway.json'
$taskStdout = Join-Path $StateDirectory 'gateway.stdout.log'
$taskStderr = Join-Path $StateDirectory 'gateway.stderr.log'
$taskExecutable = (Get-Command $Cloudflared -CommandType Application -ErrorAction Stop).Source
$taskRecord = if (Test-Path -LiteralPath $taskRecordPath) { Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json } else { $null }

function Get-OwnedGateway {
    if ($null -eq $taskRecord) { return $null }
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskRecord.pid)"
    if ($null -eq $taskProcess) { return $null }
    if ($taskProcess.ExecutablePath -ine $taskExecutable -or $taskProcess.CommandLine -notlike "*$taskOrigin*" -or $taskProcess.CommandLine -notlike "*$taskMetrics*") {
        throw "Recorded PID $($taskRecord.pid) belongs to another process; it will not be stopped."
    }
    return $taskProcess
}

function Save-GatewayRecord {
    $taskRecord | ConvertTo-Json | Set-Content -LiteralPath $taskRecordPath -Encoding utf8
}

$taskOwned = Get-OwnedGateway
if ($Action -eq 'status') {
    [pscustomobject]@{ running=($null -ne $taskOwned); origin=$(if($null -ne $taskOwned){$taskRecord.origin}else{$null}); temporary=$true; metrics=$taskMetrics } | ConvertTo-Json -Compress
    exit
}
if ($Action -eq 'stop') {
    if ($null -ne $taskOwned) {
        $taskManagedProcess = Get-Process -Id $taskOwned.ProcessId
        $taskGraceful = $taskManagedProcess.CloseMainWindow()
        if ($taskGraceful) { $null = $taskManagedProcess.WaitForExit(3000) }
        if (-not $taskManagedProcess.HasExited) { Stop-Process -Id $taskOwned.ProcessId; $null = $taskManagedProcess.WaitForExit(5000) }
        if (-not $taskManagedProcess.HasExited) { throw 'The owned gateway did not stop.' }
        $taskPort = [int]($taskMetrics.Split(':')[-1])
        $taskListener = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue
        if ($taskListener) { throw "Metrics port $taskPort remains occupied by PID $($taskListener.OwningProcess)." }
    }
    if (Test-Path -LiteralPath $taskRecordPath) { Remove-Item -LiteralPath $taskRecordPath }
    [pscustomobject]@{ stopped=$true; scope='only the recorded executable and origin' } | ConvertTo-Json -Compress
    exit
}
if ($null -ne $taskOwned -and $taskRecord.origin) {
    [pscustomobject]@{ running=$true; origin=$taskRecord.origin; mcp="$($taskRecord.origin)/mcp"; temporary=$true; alreadyRunning=$true } | ConvertTo-Json -Compress
    exit
}
if ($null -eq $taskOwned) {
    $null = Invoke-RestMethod -Uri "$taskOrigin/local/status" -TimeoutSec 5
    $null = New-Item -ItemType Directory -Path $StateDirectory -Force
    $taskChild = Start-Process -FilePath $taskExecutable -ArgumentList @('tunnel','--url',$taskOrigin,'--protocol','http2','--no-autoupdate','--metrics',$taskMetrics) -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
    $taskRecord = [pscustomobject]@{ pid=$taskChild.Id; executable=$taskExecutable; localOrigin=$taskOrigin; metrics=$taskMetrics; origin=$null }
    Save-GatewayRecord
}
for ($taskAttempt = 0; $taskAttempt -lt 120; $taskAttempt++) {
    $taskLog = Get-Content -LiteralPath $taskStderr -Raw -ErrorAction SilentlyContinue
    $taskMatch = [regex]::Match("`n$taskLog", 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($taskMatch.Success) {
        $taskRecord.origin = $taskMatch.Value
        Save-GatewayRecord
        [pscustomobject]@{ running=$true; origin=$taskRecord.origin; mcp="$($taskRecord.origin)/mcp"; temporary=$true; accountRequired=$false } | ConvertTo-Json -Compress
        exit
    }
    if ($null -eq (Get-OwnedGateway)) { throw "The gateway exited; inspect $taskStderr." }
    Start-Sleep -Milliseconds 250
}
throw "Gateway hostname is not ready. The owned process record is preserved at $taskRecordPath; inspect $taskStderr before restarting."
