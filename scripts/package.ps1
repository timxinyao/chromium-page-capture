$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $projectRoot 'extension'
$manifestPath = Join-Path $extensionDir 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+(\.\d+){0,3}$') {
    throw 'Manifest version is missing or invalid.'
}

$distDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$zipName = 'chromium-page-capture-' + $version + '.zip'
$zipPath = Join-Path $distDir $zipName
$temporaryZip = Join-Path $distDir ([guid]::NewGuid().ToString() + '.zip')
$hashPath = $zipPath + '.sha256'

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($extensionDir, $temporaryZip)
    Copy-Item -LiteralPath $temporaryZip -Destination $zipPath -Force
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($zipPath)
    try {
        $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
    $hashLine = $hash + '  ' + $zipName + "`n"
    [System.IO.File]::WriteAllText($hashPath, $hashLine, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Created $zipPath"
    Write-Output "Created $hashPath"
} finally {
    if (Test-Path -LiteralPath $temporaryZip) {
        Remove-Item -LiteralPath $temporaryZip -Force
    }
}
