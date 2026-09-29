# Register the native messaging host so Chrome can reach the desktop server.
#
# The Windows counterpart to install.sh. The server registers itself
# (`munim-computer-use install-native-host`): it writes a small .cmd that Chrome
# runs in host mode, a host manifest per host name, and the registry keys
# Chrome reads. This script only finds a checkout's build.
#
# The extension id is pinned by the "key" in manifest.json, which is why this
# can be registered before the extension is ever loaded.

$ErrorActionPreference = 'Stop'

$ExtensionId = 'kgdolgnijopbghhomnblabjkmjhnoage'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$binary = $env:COMPUTER_USE_PATH
if (-not $binary) {
  $binary = Join-Path $here '..\windows-linux\target\release\munim-computer-use.exe'
}
if (-not (Test-Path $binary)) {
  Write-Error "desktop server binary not found at: $binary`nbuild it first:  cargo build --release --manifest-path windows-linux/Cargo.toml"
}
$binary = (Resolve-Path $binary).Path

& $binary install-native-host --binary $binary
if ($LASTEXITCODE -ne 0) {
  Write-Error 'install-native-host failed'
}

Write-Host ''
Write-Host 'Next, load the extension once:'
Write-Host '  1. open  chrome://extensions'
Write-Host '  2. turn on Developer mode'
Write-Host "  3. Load unpacked  ->  $here"
Write-Host ''
Write-Host "It should appear with id $ExtensionId."
