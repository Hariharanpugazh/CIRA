<#
    start-ollama.ps1

    Starts the local Ollama server with the CORS origin that browser
    extensions (like CIRA) require. Chrome sends requests with an
    `Origin: chrome-extension://<id>` header, which Ollama rejects with
    HTTP 403 unless that origin is allow-listed via OLLAMA_ORIGINS.

    This script is self-contained and needs NO admin rights:
      - It sets OLLAMA_ORIGINS for this process (always effective).
      - It also persists it to the user environment (best-effort) so other
        launches of Ollama pick it up too.
      - It refuses to start a second server if one is already listening.

    Usage:
      Right-click -> Run with PowerShell, or:
      powershell -ExecutionPolicy Bypass -File scripts\start-ollama.ps1
#>

$ErrorActionPreference = 'Stop'

$Origins = 'chrome-extension://*'
$OllamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$ApiBase = 'http://127.0.0.1:11434'

Write-Host 'CIRA / Ollama launcher' -ForegroundColor Cyan

if (-not (Test-Path $OllamaExe)) {
    Write-Host "Could not find ollama.exe at: $OllamaExe" -ForegroundColor Red
    Write-Host 'Install Ollama from https://ollama.com/download or edit $OllamaExe in this script.' -ForegroundColor Yellow
    exit 1
}

# Make the origin effective for the server we launch, and remember it for next time.
$env:OLLAMA_ORIGINS = $Origins
try {
    [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', $Origins, 'User')
    Write-Host "Persisted OLLAMA_ORIGINS=$Origins for your user account." -ForegroundColor DarkGray
} catch {
    Write-Host 'Could not persist the user variable (not fatal); it is still set for this run.' -ForegroundColor DarkGray
}

# If something is already serving on the port, don't try to bind it again.
$alreadyUp = $false
try {
    $v = Invoke-WebRequest "$ApiBase/api/version" -UseBasicParsing -TimeoutSec 3
    if ($v.StatusCode -eq 200) { $alreadyUp = $true }
} catch { $alreadyUp = $false }

if ($alreadyUp) {
    Write-Host 'An Ollama server is already running on 127.0.0.1:11434.' -ForegroundColor Yellow
    Write-Host 'If it was started WITHOUT the extension origin, quit it first (tray -> Quit),' -ForegroundColor Yellow
    Write-Host 'then run this script again so the origin takes effect.' -ForegroundColor Yellow
    exit 0
}

Write-Host "Starting Ollama with OLLAMA_ORIGINS=$Origins ..." -ForegroundColor Green
& $OllamaExe serve
