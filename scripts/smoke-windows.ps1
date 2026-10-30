param(
    [Parameter(Mandatory)][string]$BundleDirectory,
    [Parameter(Mandatory)][string]$Version
)

$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem (Join-Path $BundleDirectory 'nsis/*.exe'))
if ($installers.Count -ne 1) { throw "Expected one NSIS installer, found $($installers.Count)" }
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "l1git-smoke-$([guid]::NewGuid())"
$install = Join-Path $scratch 'L1 Git'
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$app = $null
try {
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    $setup = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$install" -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "NSIS installation failed with $($setup.ExitCode)" }
    $executable = Join-Path $install 'l1-git.exe'
    if (!(Test-Path $executable)) { throw "Installed executable is missing at $executable" }
    $productVersion = (Get-Item $executable).VersionInfo.ProductVersion
    if ($productVersion -ne $Version) { throw "Installed version $productVersion differs from $Version" }
    $bytes = [System.IO.File]::ReadAllBytes($executable)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) { throw 'Installed executable is not x64' }
    if ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -ne 2) { throw 'Release executable opens a console' }
    $env:APPDATA = Join-Path $scratch 'roaming'
    $env:LOCALAPPDATA = Join-Path $scratch 'local'
    $app = Start-Process -FilePath $executable -WorkingDirectory $install -PassThru
    if ($app.WaitForExit(15000)) { throw "Installed app exited during startup with $($app.ExitCode)" }
    $app.Refresh()
    if ($app.MainWindowHandle -eq 0 -or $app.MainWindowTitle -ne 'L1 Git') {
        throw 'Installed app did not open the L1 Git window'
    }
    Write-Output "Installed Windows x64 $Version and observed the L1 Git window for 15 seconds."
} finally {
    if ($null -ne $app -and !$app.HasExited) { Stop-Process -Id $app.Id -Force }
    $env:APPDATA = $previousAppData
    $env:LOCALAPPDATA = $previousLocalAppData
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$install" -Wait | Out-Null
    }
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
