param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'start', 'stop', 'restart', 'status')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$token = $env:IDLAB_MANAGER_TOKEN
if (-not $token -and (Test-Path -LiteralPath '.env')) {
    $entries = @(Get-Content -LiteralPath '.env' | Select-String '^\s*IDLAB_MANAGER_TOKEN\s*=')
    if ($entries.Count -eq 1 -and $entries[0].Line -match '^\s*IDLAB_MANAGER_TOKEN\s*=\s*([A-Za-z0-9_-]+)\s*(?:#.*)?$') {
        $token = $Matches[1]
    }
}

if (-not $token -and $Action -eq 'prepare' -and -not (Test-Path -LiteralPath '.env')) {
    $token = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    New-Item -Path '.env' -ItemType File -Value "IDLAB_MANAGER_TOKEN=$token`r`n" | Out-Null
}

if (-not $token) {
    throw 'Set IDLAB_MANAGER_TOKEN in the VS Code environment or add IDLAB_MANAGER_TOKEN=<token> without quotes to the local .env file.'
}

if ($Action -eq 'prepare') {
    $env:IDLAB_MANAGER_TOKEN = $token
    & docker compose up -d --build core
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$base = 'http://127.0.0.1:8080/api/v1/httpd'
$headers = @{ Authorization = "Bearer $token" }

try {
    if ($Action -in @('start', 'stop', 'restart')) {
        Invoke-RestMethod -UseBasicParsing -MaximumRedirection 0 -Method Post -Uri "$base/$Action" -Headers $headers -TimeoutSec 15 | Out-Null
    }

    # Docker publishing and child readiness can lag behind a successful start.
    if ($Action -in @('start', 'restart', 'prepare')) {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            try {
                $status = Invoke-RestMethod -UseBasicParsing -MaximumRedirection 0 -Method Get -Uri "$base/status" -Headers $headers -TimeoutSec 3
            } catch [System.Net.WebException] {
                if ($Action -ne 'prepare' -or $_.Exception.Status -ne [System.Net.WebExceptionStatus]::ConnectFailure) { throw }
                if ([DateTime]::UtcNow -ge $deadline) { throw }
                Start-Sleep -Milliseconds 300
                continue
            }
            if ($Action -eq 'prepare' -or $status.ready -or $status.state -eq 'exited') { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
    } else {
        $status = Invoke-RestMethod -UseBasicParsing -MaximumRedirection 0 -Method Get -Uri "$base/status" -Headers $headers -TimeoutSec 3
    }
    $status | ConvertTo-Json -Compress
    if ($Action -in @('start', 'restart') -and -not $status.ready) {
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
