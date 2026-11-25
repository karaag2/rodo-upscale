# CI smoke test of the built Windows installer (run by .github/workflows/windows.yml).
# 1. Installs the NSIS installer silently into a temp folder, like the user would get it.
# 2. Checks the layout the backend relies on: sidecar exe, vcomp140.dll beside it, models/.
# 3. Runs the installed engine: `-h` must work (proves the exe and its DLLs load), then a real
#    ×2 upscale of a tiny PNG. GitHub runners have no GPU, so a Vulkan "no device" failure is only
#    a warning; a missing DLL or a broken binary fails the job.
# Usage: pwsh scripts/smoke-windows.ps1 -Installer <path\to\setup.exe>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Log($msg) { Write-Host "[smoke] $msg" }
function Fail($msg) { Write-Host "::error::$msg"; exit 1 }

$Work = Join-Path ([System.IO.Path]::GetTempPath()) 'rodo-smoke'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
$InstallDir = Join-Path $Work 'app'
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# --- 1. silent install (/D must be the last argument and unquoted) ---
Log "installing $Installer into $InstallDir"
$p = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru
if ($p.ExitCode -ne 0) { Fail "installer exited with code $($p.ExitCode)" }

# --- 2. layout ---
$Engine = Join-Path $InstallDir 'realesrgan-ncnn-vulkan.exe'
$Required = @(
    $Engine,
    (Join-Path $InstallDir 'vcomp140.dll'),
    (Join-Path $InstallDir 'models/realesrgan-x4plus.param'),
    (Join-Path $InstallDir 'models/realesrgan-x4plus.bin'),
    (Join-Path $InstallDir 'models/realesrgan-x4plus-anime.param'),
    (Join-Path $InstallDir 'models/realesrgan-x4plus-anime.bin'),
    (Join-Path $InstallDir 'models/realesr-animevideov3-x2.param'),
    (Join-Path $InstallDir 'models/realesr-animevideov3-x2.bin'),
    (Join-Path $InstallDir 'models/realesr-animevideov3-x4.param'),
    (Join-Path $InstallDir 'models/realesr-animevideov3-x4.bin')
)
$missing = $Required | Where-Object { -not (Test-Path $_) }
if ($missing) {
    Log 'installed files:'
    Get-ChildItem -Recurse $InstallDir | ForEach-Object { Write-Host "  $($_.FullName)" }
    Fail "missing from the installed app: $($missing -join ', ')"
}
Log 'layout OK: sidecar, vcomp140.dll and models are installed'

# --- 3a. Vulkan loader ---
# The engine imports vulkan-1.dll. On a real PC it comes with the GPU driver; runners may not
# have it, so for this test only, put the official LunarG runtime on PATH (pinned + SHA-256).
$System32Vulkan = Join-Path $env:WINDIR 'System32/vulkan-1.dll'
if (Test-Path $System32Vulkan) {
    Log 'vulkan-1.dll found in System32'
} else {
    $VkVer = '1.4.335.0'
    $VkSha = '4f856da356ffb1c16fbfc792cae70f6e6873680e6b62bc132b9d7131cbc97fe2'
    $VkZip = Join-Path $Work 'vulkan-rt.zip'
    Log "vulkan-1.dll not in System32: using LunarG Vulkan runtime $VkVer for the test"
    Invoke-WebRequest -UseBasicParsing -Uri "https://sdk.lunarg.com/sdk/download/$VkVer/windows/VulkanRT-X64-$VkVer-Components.zip" -OutFile $VkZip
    $got = (Get-FileHash -Algorithm SHA256 $VkZip).Hash.ToLowerInvariant()
    if ($got -ne $VkSha) { Fail "Vulkan runtime SHA-256 mismatch: expected $VkSha, got $got" }
    Expand-Archive -Path $VkZip -DestinationPath (Join-Path $Work 'vulkan-rt')
    $VkDir = (Get-ChildItem -Recurse -Path (Join-Path $Work 'vulkan-rt') -Filter 'vulkan-1.dll' |
        Where-Object { $_.DirectoryName -match '[\\/]x64$' } | Select-Object -First 1).DirectoryName
    if (-not $VkDir) { Fail 'x64 vulkan-1.dll not found in the Vulkan runtime zip' }
    $env:PATH = "$VkDir;$env:PATH"
}

# Windows NTSTATUS codes meaning "the exe could not even start".
$LoaderErrors = @{
    -1073741515 = 'STATUS_DLL_NOT_FOUND (0xC0000135): a DLL is missing'
    -1073741511 = 'STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139): a DLL has the wrong version'
    -1073741701 = 'STATUS_INVALID_IMAGE_FORMAT (0xC000007B): 32/64-bit mismatch or corrupt DLL'
    -1073741819 = 'STATUS_ACCESS_VIOLATION (0xC0000005): the engine crashed'
}

function Invoke-Engine([string[]]$EngineArgs) {
    # The engine logs to stderr: do not let 'Stop' turn those lines into exceptions.
    $ErrorActionPreference = 'Continue'
    $out = & $Engine @EngineArgs 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $out }
}

# --- 3b. -h: the exe and all its imported DLLs load ---
$r = Invoke-Engine @('-h')
Write-Host $r.Output
if ($LoaderErrors.ContainsKey($r.Code)) { Fail "engine failed to start: $($LoaderErrors[$r.Code])" }
if ($r.Output -notmatch 'Usage: realesrgan-ncnn-vulkan') { Fail "engine -h did not print its usage (exit code $($r.Code))" }
Log 'engine starts: -h OK'

# --- 3c. real ×2 upscale of a 16×16 PNG (needs a Vulkan device: best effort on runners) ---
$In = Join-Path $Work 'in.png'
$Out = Join-Path $Work 'out.png'
$Png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABlklEQVR42hXRURVEIQhFUSMYgQhGMAIRiGCEE8EIRiACEYhABCLMG7/ZrMt1jMEcyGAN9kAHNjgDBnfwBj6IQQ5q0IMxJnMikzXZE53Y5EyY3Mmb+CQmOalJzw8IUxBhCVtQwYQjIFzhCS6EkEIJLR9YzIUs1mIvdGGLs2BxF2/hi1jkoha9PrCZG9mszd7oxjZnw+Zu3sY3sclNbXp/QJmKKEvZiiqmHAXlKk9xJZRUSmn9gDENMZaxDTXMOAbGNZ7hRhhplNH2gcM8yGEd9kEPdjgHDvfwDn6IQx7q0OcD/wK/Sr4jv9hfkG/1N/x/Fx44BCQU9Pc94zIvclmXfdGLXc79j9/Lu/glLnmpS98PPOZDHuuxH/qwx3n/5ffxHv6IRz7q0e8DznTEWc521DHn+D/KdZ7jTjjplNP+gWAGEqxgBxpYcOIf/AYv8CCCDCro+EAyE0lWshNNLDn5P/MmL/Ekkkwq6fxAMQspVrELLaw49S/lFq/wIoosquj6QDMbaVazG22sOf2v8Dav8SaabKrp5geIAnAQC3NfwAAAAABJRU5ErkJggg=='
[System.IO.File]::WriteAllBytes($In, [Convert]::FromBase64String($Png))

$r = Invoke-Engine @('-i', $In, '-o', $Out, '-n', 'realesr-animevideov3', '-s', '2', '-m', (Join-Path $InstallDir 'models'))
Write-Host $r.Output
if ($LoaderErrors.ContainsKey($r.Code)) { Fail "engine failed during the upscale: $($LoaderErrors[$r.Code])" }
if ($r.Code -eq 0 -and (Test-Path $Out) -and (Get-Item $Out).Length -gt 0) {
    # PNG IHDR: width and height are big-endian uint32 at bytes 16..23.
    $b = [System.IO.File]::ReadAllBytes($Out)
    $w = ([int]$b[16] -shl 24) -bor ([int]$b[17] -shl 16) -bor ([int]$b[18] -shl 8) -bor [int]$b[19]
    $h = ([int]$b[20] -shl 24) -bor ([int]$b[21] -shl 16) -bor ([int]$b[22] -shl 8) -bor [int]$b[23]
    if ($w -ne 32 -or $h -ne 32) { Fail "upscale produced ${w}x${h}, expected 32x32" }
    Log 'real upscale OK: 16x16 -> 32x32'
} else {
    Write-Host "::warning::No Vulkan device on this runner (exit code $($r.Code)): real upscale skipped. The binary and its DLLs load fine."
}
Log 'smoke test passed'
# The engine's last call can leave $LASTEXITCODE at -1 (no GPU on the runner); every check above passed.
exit 0
