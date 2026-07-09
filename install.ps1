# Music Player — Windows installer.
#
#   irm https://raw.githubusercontent.com/Indernol/music-player/main/install.ps1 | iex
#
# Downloads the latest (or pinned) release from GitHub and runs the NSIS
# setup.exe, or extracts the portable zip if preferred.
# Env: $env:MP_VERSION = "vX.Y.Z" to pin a version.
#      $env:GITHUB_TOKEN = "ghp_..." for a private repo.
#      $env:MP_PORTABLE = "1" to download the portable zip instead of the installer.

$ErrorActionPreference = 'Stop'

$repo  = 'Indernol/music-player'
$app   = 'MusicPlayer'
$api   = "https://api.github.com/repos/$repo/releases"

$headers = @{ Accept = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

function Say($msg)  { Write-Host ":: $msg" -ForegroundColor Magenta }
function Die($msg)  { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- pick the release ---
if ($env:MP_VERSION) {
    $relUrl = "$api/tags/$env:MP_VERSION"
} else {
    $relUrl = "$api/latest"
}

Say "Fetching release info..."
try {
    $json = Invoke-RestMethod -Uri $relUrl -Headers $headers
} catch {
    Die "Cannot reach GitHub (private repo? set `$env:GITHUB_TOKEN)."
}

$assets = $json.assets | Where-Object { $_.browser_download_url } | ForEach-Object { $_.browser_download_url }
if (-not $assets) { Die "No downloadable assets in this release — build one first (push a v* tag)." }

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "mp-install-$(Get-Random)") -Force

try {
    if ($env:MP_PORTABLE -eq '1') {
        # --- Portable zip mode ---
        $zipUrl = $assets | Where-Object { $_ -match '\.zip$' -and $_ -match 'windows' } | Select-Object -First 1
        if (-not $zipUrl) { Die "No portable Windows zip found in this release." }
        $zipFile = Join-Path $tmp.FullName "music-player.zip"
        Say "Downloading portable zip..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -Headers $headers

        $installDir = Join-Path $env:LOCALAPPDATA $app
        Say "Extracting to $installDir..."
        if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
        Expand-Archive -Path $zipFile -DestinationPath $installDir -Force

        # Add to PATH if not already there
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if ($userPath -notlike "*$installDir*") {
            [Environment]::SetEnvironmentVariable('PATH', "$userPath;$installDir", 'User')
            Say "Added $installDir to your PATH (restart your terminal to use it)."
        }

        Say "Done — portable install at $installDir"
    } else {
        # --- NSIS installer mode (default) ---
        $exeUrl = $assets | Where-Object { $_ -match '-setup\.exe$' -or ($_ -match '\.exe$' -and $_ -match 'setup') } | Select-Object -First 1
        if (-not $exeUrl) {
            # Fallback: try any .exe
            $exeUrl = $assets | Where-Object { $_ -match '\.exe$' } | Select-Object -First 1
        }
        if (-not $exeUrl) { Die "No Windows installer (.exe) found in this release." }

        $exeFile = Join-Path $tmp.FullName "music-player-setup.exe"
        Say "Downloading installer..."
        Invoke-WebRequest -Uri $exeUrl -OutFile $exeFile -Headers $headers

        Say "Running installer..."
        Start-Process -FilePath $exeFile -Wait

        Say "Done — find Music Player in your Start menu."
    }
} finally {
    Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
}
