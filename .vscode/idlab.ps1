param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'reload', 'start', 'stop', 'restart', 'status')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$deploy = $Action -in @('prepare', 'reload')
$token = $env:IDLAB_MANAGER_TOKEN
if (-not $token -and (Test-Path -LiteralPath '.env')) {
    $entries = @(Get-Content -LiteralPath '.env' | Select-String '^\s*IDLAB_MANAGER_TOKEN\s*=')
    if ($entries.Count -eq 1 -and $entries[0].Line -match '^\s*IDLAB_MANAGER_TOKEN\s*=\s*([A-Za-z0-9_-]+)\s*(?:#.*)?$') {
        $token = $Matches[1]
    }
}

if (-not $token -and $deploy -and -not (Test-Path -LiteralPath '.env')) {
    $token = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    New-Item -Path '.env' -ItemType File -Value "IDLAB_MANAGER_TOKEN=$token`r`n" | Out-Null
}

if (-not $token) {
    throw 'Set IDLAB_MANAGER_TOKEN in the VS Code environment or add IDLAB_MANAGER_TOKEN=<token> without quotes to the local .env file.'
}

if ($deploy) {
    $env:IDLAB_MANAGER_TOKEN = $token
    $composeArgs = @('compose', 'up', '-d', '--build')
    if ($Action -eq 'reload') { $composeArgs += '--force-recreate' }
    $composeArgs += 'core'
    & docker @composeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$base = 'http://127.0.0.1:8080/api/v1/httpd'
$headers = @{ Authorization = "Bearer $token" }
$startupTransportErrors = @(
    'ConnectFailure', 'ReceiveFailure', 'SendFailure', 'ConnectionClosed', 'KeepAliveFailure', 'Timeout'
)

function Get-IdlabStatus {
    Invoke-RestMethod -UseBasicParsing -DisableKeepAlive -MaximumRedirection 0 -Method Get -Uri "$base/status" -Headers $headers -TimeoutSec 3
}

function Wait-IdlabStatus([bool]$RequireReady) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $status = $null
    $lastTransportError = $null
    do {
        try {
            $status = Get-IdlabStatus
            if (-not $RequireReady -or $status.ready -or $status.state -eq 'exited') {
                return $status
            }
        } catch [System.Net.WebException] {
            if ($_.Exception.Response -or $_.Exception.Status.ToString() -notin $startupTransportErrors) { throw }
            $lastTransportError = $_.Exception.Status
        }
        if ([DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 300
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $status) {
        throw "The IDLab manager did not respond on 127.0.0.1:8080 (last transport error: $lastTransportError). Check the port mapping and core logs in Docker Desktop."
    }
    return $status
}

try {
    if ($deploy) {
        $status = Wait-IdlabStatus $false
    }
    $command = $Action
    if ($Action -eq 'reload') { $command = 'start' }

    if ($command -in @('start', 'stop', 'restart')) {
        Invoke-RestMethod -UseBasicParsing -DisableKeepAlive -MaximumRedirection 0 -Method Post -Uri "$base/$command" -Headers $headers -TimeoutSec 15 | Out-Null
    }

    if ($command -in @('start', 'restart')) {
        $status = Wait-IdlabStatus $true
    } elseif (-not $deploy) {
        $status = Get-IdlabStatus
    }
    $status | ConvertTo-Json -Compress
    if ($command -in @('start', 'restart') -and -not $status.ready) {
        throw 'The HTTP service did not become ready. Check the core container logs in Docker Desktop.'
    }
} catch [System.Net.WebException] {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
        throw 'IDLab rejected the token. Use the same IDLAB_MANAGER_TOKEN as the running container, or run the preparation task to apply the local configuration.'
    }
    if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
        throw 'IDLab is not reachable on 127.0.0.1:8080. Run the preparation task in a local Windows VS Code window and check Docker Desktop.'
    }
    throw
}
