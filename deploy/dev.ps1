param(
    [Parameter(Position = 0)]
    [ValidateSet("up", "down", "status")]
    [string]$Command = "status",
    [ValidateSet("postgres", "temporal", "api", "worker", "laya")]
    [string[]]$Components = @("postgres", "temporal", "api", "worker"),
    [switch]$Hidden,
    [switch]$StopPostgres,
    [int]$StartupTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

$deployDirectory = $PSScriptRoot
$repositoryRoot = Split-Path $deployDirectory -Parent
$dataDirectory = Join-Path $deployDirectory "data"
$localTemporal = Join-Path $deployDirectory "bin\temporal.exe"
$layaScript = Join-Path $deployDirectory "laya\start.ps1"
$composeFile = Join-Path $deployDirectory "docker-compose.yml"
$deployEnvironmentFile = Join-Path $deployDirectory ".env"

function Read-DeployValue([string]$Key, [string]$Fallback) {
    $source = $deployEnvironmentFile
    if (-not (Test-Path $source)) {
        $source = Join-Path $deployDirectory ".env.example"
    }
    $line = Get-Content $source | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
    if ($null -eq $line) {
        return $Fallback
    }
    return ($line -split "=", 2)[1].Trim()
}

$postgresPort = [int](Read-DeployValue "POSTGRES_PORT" "5440")
$temporalPort = [int](Read-DeployValue "TEMPORAL_PORT" "7233")
$temporalUiPort = [int](Read-DeployValue "TEMPORAL_UI_PORT" "8233")
$apiPort = 8000

function Test-PortListening([int]$Port) {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-HttpOk([string]$Url) {
    try {
        return (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Get-TrackingFile([string]$Name) {
    return Join-Path $dataDirectory "$Name.process.json"
}

function Get-TrackedProcess([string]$Name) {
    $file = Get-TrackingFile $Name
    if (-not (Test-Path $file)) {
        return $null
    }
    $tracked = Get-Content $file -Raw | ConvertFrom-Json
    $process = Get-Process -Id $tracked.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    if ($process.StartTime.ToUniversalTime().ToString("o") -ne $tracked.StartTimeUtc) {
        return $null
    }
    return $process
}

function Save-TrackedProcess([string]$Name, $Process) {
    @{
        ProcessId    = $Process.Id
        StartTimeUtc = $Process.StartTime.ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -Path (Get-TrackingFile $Name) -Encoding ascii
}

function Stop-TrackedProcess([string]$Name) {
    $process = Get-TrackedProcess $Name
    if ($null -eq $process) {
        Write-Host ("{0,-9} not running (no tracked process)" -f $Name)
    }
    else {
        taskkill /PID $process.Id /T /F | Out-Null
        Write-Host ("{0,-9} stopped (process tree {1})" -f $Name, $process.Id)
    }
    Remove-Item (Get-TrackingFile $Name) -ErrorAction SilentlyContinue
}

function Wait-Until([scriptblock]$Condition, [string]$Description, $Process) {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
        if (& $Condition) {
            return
        }
        if ($null -ne $Process -and $Process.HasExited) {
            throw "$Description failed: the process exited with code $($Process.ExitCode). See deploy/data/*.log or run with windows visible."
        }
        Start-Sleep -Seconds 1
    }
    throw "$Description did not become ready within $StartupTimeoutSeconds s."
}

function Invoke-WithCleanEnvironment([scriptblock]$Action) {
    $saved = @{}
    foreach ($name in @(Get-ChildItem Env: | Where-Object { $_.Name -like "TESSA_*" -or $_.Name -eq "VIRTUAL_ENV" } | ForEach-Object { $_.Name })) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    try {
        & $Action
    }
    finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
        }
    }
}

function Start-Component([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
    $logOut = Join-Path $dataDirectory "$Name.out.log"
    $logErr = Join-Path $dataDirectory "$Name.err.log"
    $script:started = $null
    Invoke-WithCleanEnvironment {
        if ($Hidden) {
            $script:started = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
                -WindowStyle Hidden -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr
        }
        else {
            $inner = 'title tessa {0} && "{1}" {2}' -f $Name, $Executable, ($Arguments -join " ")
            $script:started = Start-Process -FilePath "cmd.exe" -ArgumentList ('/k "{0}"' -f $inner) `
                -WorkingDirectory $WorkingDirectory -PassThru
        }
    }
    Save-TrackedProcess $Name $script:started
    return $script:started
}

function Initialize-EnvironmentFile([string]$Directory) {
    $target = Join-Path $Directory ".env"
    $example = Join-Path $Directory ".env.example"
    if ((-not (Test-Path $target)) -and (Test-Path $example)) {
        Copy-Item $example $target
        Write-Host "created $target from .env.example"
    }
}

function Find-Executable([string]$Name, [string]$Hint) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$Name was not found on PATH. $Hint"
    }
    return $command.Source
}

function Start-PostgresComponent {
    Initialize-DeployEnvironment
    Push-Location $deployDirectory
    try {
        docker compose up -d --wait postgres
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose up postgres failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
    Write-Host "postgres  healthy on 127.0.0.1:$postgresPort"
}

function Initialize-DeployEnvironment {
    if (-not (Test-Path $deployEnvironmentFile)) {
        Copy-Item (Join-Path $deployDirectory ".env.example") $deployEnvironmentFile
        Write-Host "created $deployEnvironmentFile from .env.example"
    }
}

function Get-TemporalExecutable {
    if (Test-Path $localTemporal) {
        return $localTemporal
    }
    return Find-Executable "temporal" "Download temporal.exe into deploy/bin or add it to PATH (see deploy/README.md)."
}

function Start-TemporalComponent {
    if (Test-PortListening $temporalPort) {
        Write-Host "temporal  port $temporalPort already in use; assuming a Temporal server is running"
        return
    }
    New-Item -ItemType Directory -Force $dataDirectory | Out-Null
    $executable = Get-TemporalExecutable
    $arguments = @("server", "start-dev", "--port", "$temporalPort", "--ui-port", "$temporalUiPort", "--db-filename", "deploy/data/temporal.db")
    $process = Start-Component "temporal" $executable $arguments $repositoryRoot
    Wait-Until { Test-PortListening $temporalPort } "temporal" $process
    Write-Host "temporal  serving on 127.0.0.1:$temporalPort, UI http://localhost:$temporalUiPort"
}

function Start-ApiComponent {
    if (Test-PortListening $apiPort) {
        Write-Host "api       port $apiPort already in use; not starting a second API"
        return
    }
    $apiDirectory = Join-Path $repositoryRoot "api"
    Initialize-EnvironmentFile $apiDirectory
    New-Item -ItemType Directory -Force $dataDirectory | Out-Null
    $uv = Find-Executable "uv" "Install uv (https://docs.astral.sh/uv/)."
    $arguments = @(
        "run", "uvicorn", "tessa_api.main:app", "--reload", "--reload-dir", "tessa_api",
        "--timeout-graceful-shutdown", "5", "--port", "$apiPort"
    )
    $process = Start-Component "api" $uv $arguments $apiDirectory
    Wait-Until { Test-HttpOk "http://127.0.0.1:$apiPort/health" } "api" $process
    Write-Host "api       serving on http://127.0.0.1:$apiPort"
}

function Start-WorkerComponent {
    if ($null -ne (Get-TrackedProcess "worker")) {
        Write-Host "worker    already running (tracked process)"
        return
    }
    $workerDirectory = Join-Path $repositoryRoot "worker"
    Initialize-EnvironmentFile $workerDirectory
    New-Item -ItemType Directory -Force $dataDirectory | Out-Null
    $uv = Find-Executable "uv" "Install uv (https://docs.astral.sh/uv/)."
    $arguments = @("run", "python", "-m", "tessa_worker.main")
    $process = Start-Component "worker" $uv $arguments $workerDirectory
    Start-Sleep -Seconds 8
    if ($process.HasExited) {
        throw "worker exited with code $($process.ExitCode). Run it in a visible window to see the error."
    }
    Write-Host "worker    running (process $($process.Id))"
}

function Get-PostgresState {
    Push-Location $deployDirectory
    try {
        $containerId = docker compose ps -q postgres 2>$null
        if ([string]::IsNullOrWhiteSpace($containerId)) {
            return "stopped"
        }
        return (docker inspect --format "{{.State.Status}}/{{.State.Health.Status}}" $containerId)
    }
    finally {
        Pop-Location
    }
}

function Show-Status {
    $tracked = @{}
    foreach ($name in @("temporal", "api", "worker", "laya")) {
        $process = Get-TrackedProcess $name
        if ($null -ne $process) {
            $tracked[$name] = "pid $($process.Id)"
        }
        else {
            $tracked[$name] = "not tracked"
        }
    }
    $rows = @(
        [pscustomobject]@{ Component = "postgres"; State = (Get-PostgresState); Detail = "127.0.0.1:$postgresPort" }
        [pscustomobject]@{ Component = "temporal"; State = $(if (Test-PortListening $temporalPort) { "listening" } else { "down" }); Detail = "127.0.0.1:$temporalPort, UI $temporalUiPort, $($tracked['temporal'])" }
        [pscustomobject]@{ Component = "api"; State = $(if (Test-HttpOk "http://127.0.0.1:$apiPort/health") { "healthy" } else { "down" }); Detail = "http://127.0.0.1:$apiPort/health, $($tracked['api'])" }
        [pscustomobject]@{ Component = "worker"; State = $(if ($null -ne (Get-TrackedProcess "worker")) { "running" } else { "not tracked" }); Detail = $tracked["worker"] }
        [pscustomobject]@{ Component = "laya"; State = $(if (Test-HttpOk "http://127.0.0.1:7006/health") { "healthy" } else { "down" }); Detail = "http://127.0.0.1:7006/health, $($tracked['laya'])" }
    )
    $rows | Format-Table -AutoSize
}

function Invoke-Up {
    foreach ($component in $Components) {
        switch ($component) {
            "postgres" { Start-PostgresComponent }
            "temporal" { Start-TemporalComponent }
            "api" { Start-ApiComponent }
            "worker" { Start-WorkerComponent }
            "laya" { & $layaScript -Action start }
        }
    }
}

function Invoke-Down {
    foreach ($component in @("worker", "api", "temporal")) {
        if ($Components -contains $component) {
            Stop-TrackedProcess $component
        }
    }
    if ($Components -contains "laya") {
        & $layaScript -Action stop
    }
    if ($StopPostgres -and ($Components -contains "postgres")) {
        Push-Location $deployDirectory
        try {
            docker compose stop postgres
        }
        finally {
            Pop-Location
        }
    }
}

switch ($Command) {
    "up" { Invoke-Up }
    "down" { Invoke-Down }
    "status" { Show-Status }
}
