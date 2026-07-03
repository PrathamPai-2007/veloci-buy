# Builds the rust-ml-core napi-rs native addon on Windows (MSVC toolchain).
#
# napi-rs invokes `cargo`, which needs the MSVC linker (link.exe) on PATH. That
# environment is normally only present inside a "Developer Command Prompt". This
# script loads it via the Visual Studio DevShell module, then runs `napi build`.
#
# Usage:  pwsh -File scripts/build-rust.ps1            (release build)
#         pwsh -File scripts/build-rust.ps1 -Debug     (debug build)
param(
  [switch]$Debug
)

$ErrorActionPreference = 'Stop'

# Ensure cargo/rustc are reachable even in a fresh shell.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }

# Locate the Visual Studio (Build Tools) install that ships the C++ toolset.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  throw "vswhere.exe not found. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
}
$vsPath = & $vswhere -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
if (-not $vsPath) {
  throw "No VS install with the VC++ x64 toolset found. Install the 'Desktop development with C++' workload."
}

# Load the MSVC build environment (puts link.exe + headers on PATH).
$devShell = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation `
  -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $repoRoot 'rust-ml-core')
try {
  $napi = Join-Path $repoRoot 'node_modules\.bin\napi.cmd'
  $buildArgs = @('build', '--platform')
  if (-not $Debug) { $buildArgs += '--release' }
  Write-Host "Running: napi $($buildArgs -join ' ')  (cwd: rust-ml-core)" -ForegroundColor Cyan
  & $napi @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "napi build failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
Write-Host 'Rust addon build complete.' -ForegroundColor Green
