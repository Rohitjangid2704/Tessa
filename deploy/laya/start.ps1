param(
    [ValidateSet("start", "stop", "status")]
    [string]$Action = "start",
    [string]$Models = "english,multilingual,typed-decisions",
    [ValidateSet("cpu", "cuda")]
    [string]$Device = "cpu",
    [int]$Port = 7006,
    [int]$StartupTimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"

$layaDirectory = $PSScriptRoot
$dataDirectory = Join-Path (Split-Path $layaDirectory -Parent) "data"
$layaServe = Join-Path $layaDirectory ".venv\Scripts\laya-serve.exe"
$trackingFile = Join-Path $dataDirectory "laya.process.json"
$standardOutputLog = Join-Path $dataDirectory "laya.out.log"
$standardErrorLog = Join-Path $dataDirectory "laya.err.log"
$healthUrl = "http://127.0.0.1:$Port/health"

function Get-TrackedProcess {
    if (-not (Test-Path $trackingFile)) {
        return $null
    }
    $tracked = Get-Content $trackingFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id $tracked.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    if ($process.StartTime.ToUniversalTime().ToString("o") -ne $tracked.StartTimeUtc) {
        return $null
    }
    return $process
}

function Get-Health {
    try {
        return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    }
    catch {
        return $null
    }
}

function Test-PortListening {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-Laya {
    if (-not (Test-Path $layaServe)) {
        throw "laya-serve is not installed at $layaServe. Follow deploy/laya/README.md to create the venv."
    }
    if ($null -ne (Get-TrackedProcess)) {
        Write-Host "Laya is already running (tracked process)."
        return
    }
    if (Test-PortListening) {
        throw "Port $Port is already in use by a process this script did not start."
    }
    New-Item -ItemType Directory -Force $dataDirectory | Out-Null

    $previous = @{}
    $settings = @{
        LAYA_HOST    = "127.0.0.1"
        LAYA_PORT    = "$Port"
        LAYA_DEVICE  = $Device
        LAYA_PRELOAD = "1"
        LAYA_MODELS  = $Models
    }
    foreach ($name in $settings.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $settings[$name], "Process")
    }
    try {
        $process = Start-Process -FilePath $layaServe -WindowStyle Hidden -PassThru `
            -WorkingDirectory $layaDirectory `
            -RedirectStandardOutput $standardOutputLog -RedirectStandardError $standardErrorLog
    }
    finally {
        foreach ($name in $settings.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
        }
    }

    @{
        ProcessId    = $process.Id
        StartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -Path $trackingFile -Encoding ascii

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
        if ($process.HasExited) {
            throw "laya-serve exited with code $($process.ExitCode). See $standardErrorLog"
        }
        $health = Get-Health
        if ($null -ne $health -and $health.status -eq "ok") {
            Write-Host ("Laya is up on http://127.0.0.1:{0} after {1:N1}s (loaded: {2}, device: {3})" -f `
                $Port, $stopwatch.Elapsed.TotalSeconds, ($health.loaded -join ","), $health.device)
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "Laya did not become healthy within $StartupTimeoutSeconds s. See $standardErrorLog"
}

function Stop-Laya {
    $process = Get-TrackedProcess
    if ($null -eq $process) {
        Write-Host "No tracked Laya process."
        if (Test-PortListening) {
            Write-Host "Port $Port is in use by a process this script did not start; leaving it alone."
        }
    }
    else {
        taskkill /PID $process.Id /T /F | Out-Null
        Write-Host "Stopped Laya (process tree $($process.Id))."
    }
    Remove-Item $trackingFile -ErrorAction SilentlyContinue
}

function Show-Status {
    $process = Get-TrackedProcess
    $health = Get-Health
    if ($null -ne $process) {
        Write-Host "tracked process: $($process.Id)"
    }
    else {
        Write-Host "tracked process: none"
    }
    if ($null -ne $health) {
        $health | ConvertTo-Json -Depth 4
    }
    else {
        Write-Host "health: not reachable on $healthUrl"
    }
}

switch ($Action) {
    "start" { Start-Laya }
    "stop" { Stop-Laya }
    "status" { Show-Status }
}
