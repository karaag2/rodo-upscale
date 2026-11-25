# Downloads the official Real-ESRGAN ncnn-vulkan engine (v0.2.5.0) for Windows,
# verifies its SHA-256 and installs it where Tauri expects it:
#   src-tauri/binaries/realesrgan-ncnn-vulkan-<rust host triple>.exe  (Tauri sidecar naming)
#   src-tauri/binaries/windows/vcomp140.dll                          (OpenMP runtime the engine imports;
#                                                                     tauri.windows.conf.json puts it next to the exe)
#   src-tauri/resources/models/*.param, *.bin                         (bundled as <resource_dir>/models)
# Idempotent: does nothing when the engine is already installed from the same archive.
# Usage: pwsh scripts/fetch-engine.ps1 [-Force]      ($env:TARGET_TRIPLE overrides the detected triple)
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar

$Version = 'v0.2.5.0'
$Build = '20220424'
$ZipName = "realesrgan-ncnn-vulkan-$Build-windows.zip"
$Url = "https://github.com/xinntao/Real-ESRGAN/releases/download/$Version/$ZipName"
# SHA-256 of the official release zip, recorded from the first download (2026-11-25).
$Sha = 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d'

$Root = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $Root 'src-tauri/binaries'
$DllDir = Join-Path $BinDir 'windows'
$ModelsDir = Join-Path $Root 'src-tauri/resources/models'
$Models = @('realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3-x2', 'realesr-animevideov3-x3', 'realesr-animevideov3-x4')

function Log($msg) { Write-Host "[fetch-engine] $msg" }

# Rust host triple (Tauri looks for binaries/<name>-<triple>.exe).
$Triple = $env:TARGET_TRIPLE
if (-not $Triple) {
    $rustc = Get-Command rustc -ErrorAction SilentlyContinue
    if (-not $rustc) { throw 'rustc not found (install Rust via rustup, or set TARGET_TRIPLE)' }
    $Triple = (& $rustc.Source -vV | Select-String '^host: (.+)$').Matches[0].Groups[1].Value.Trim()
}
if (-not $Triple) { throw 'could not detect the Rust host triple' }

$BinPath = Join-Path $BinDir "realesrgan-ncnn-vulkan-$Triple.exe"
$DllPath = Join-Path $DllDir 'vcomp140.dll'
$Stamp = Join-Path $BinDir ".engine-$Triple.stamp"
$StampValue = "$ZipName $Sha"

function Test-Installed {
    if (-not (Test-Path $BinPath) -or -not (Test-Path $DllPath) -or -not (Test-Path $Stamp)) { return $false }
    if ((Get-Content -Raw $Stamp).Trim() -ne $StampValue) { return $false }
    foreach ($m in $Models) {
        foreach ($ext in 'param', 'bin') {
            $f = Join-Path $ModelsDir "$m.$ext"
            if (-not (Test-Path $f) -or (Get-Item $f).Length -eq 0) { return $false }
        }
    }
    return $true
}

if (-not $Force -and (Test-Installed)) {
    Log "already installed: $(Split-Path -Leaf $BinPath) + vcomp140.dll + $($Models.Count) models (use -Force to reinstall)"
    exit 0
}

# The zip is cached so a reinstall does not download 45 MB again.
$CacheDir = Join-Path ([System.IO.Path]::GetTempPath()) 'rodo-upscale'
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
$Zip = Join-Path $CacheDir $ZipName
function Get-Sha($path) { (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant() }

if (-not (Test-Path $Zip) -or (Get-Sha $Zip) -ne $Sha) {
    Log "downloading $ZipName"
    # Manual retry loop: -MaximumRetryCount does not exist in Windows PowerShell 5.1.
    for ($i = 1; ; $i++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile "$Zip.part"; break }
        catch { if ($i -ge 3) { throw }; Log "download failed ($($_.Exception.Message)), retrying"; Start-Sleep 5 }
    }
    Move-Item -Force "$Zip.part" $Zip
}
$Actual = Get-Sha $Zip
if ($Actual -ne $Sha) {
    Remove-Item -Force $Zip
    throw "SHA-256 mismatch for ${ZipName}: expected $Sha, got $Actual"
}
Log "SHA-256 OK ($Sha)"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rodo-engine-" + [guid]::NewGuid())
try {
    Expand-Archive -Path $Zip -DestinationPath $Tmp
    # Releases put files at the zip root; tolerate a single top-level folder too.
    $Exe = Get-ChildItem -Path $Tmp -Recurse -Filter 'realesrgan-ncnn-vulkan.exe' | Select-Object -First 1
    if (-not $Exe) { throw "engine binary not found in $ZipName" }
    $Src = $Exe.DirectoryName

    New-Item -ItemType Directory -Force -Path $BinDir, $DllDir, $ModelsDir | Out-Null
    Copy-Item -Force $Exe.FullName $BinPath
    # The engine imports VCOMP140.DLL (OpenMP). vcomp140d.dll is the debug build and is not imported.
    Copy-Item -Force (Join-Path $Src 'vcomp140.dll') $DllPath

    Get-ChildItem -Path $ModelsDir -File | Where-Object { $_.Extension -in '.param', '.bin' } | Remove-Item -Force
    Get-ChildItem -Path (Join-Path $Src 'models') -File | Where-Object { $_.Extension -in '.param', '.bin' } |
        Copy-Item -Destination $ModelsDir -Force
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
}

Set-Content -NoNewline -Path $Stamp -Value $StampValue
if (-not (Test-Installed)) { throw 'installation incomplete (missing binary, vcomp140.dll or models)' }

Log "engine: $BinPath"
Log "dll:    $DllPath"
Log "models: $((Get-ChildItem $ModelsDir -Filter *.param | ForEach-Object BaseName) -join ' ')"
# No run check here: the engine also imports vulkan-1.dll, which only exists where a GPU driver
# (or the Vulkan runtime) is installed. CI checks the installed app in its own smoke step.
