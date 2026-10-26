# Windows 11 x64, Windows PowerShell 5.1 or PowerShell 7. No source build is needed.
& {
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Use scripts/install.sh on macOS or Linux.'
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'The Windows release currently supports x64 only.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Load the matching built-in module, even when called from a different
# PowerShell edition whose PSModulePath was inherited by Windows PowerShell.
foreach ($moduleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$moduleName/$moduleName.psd1") -ErrorAction Stop
}
Add-Type -AssemblyName System.IO.Compression.FileSystem

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 22+ is required. Install it with: winget install --id OpenJS.NodeJS.LTS -e. Then reopen PowerShell.' }
$nodeExecutable = $nodeCommand.Source
$nodeVersion = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'Cannot determine the Node.js version.' }
if ([int]$Matches[1] -lt 22) { throw 'Node.js 22 or later is required.' }
$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCommand) { throw 'Git 2.39+ is required. Install it with: winget install --id Git.Git -e. Then reopen PowerShell.' }
$gitVersion = & $gitCommand.Source --version
if ($LASTEXITCODE -ne 0 -or $gitVersion -notmatch 'git version (\d+)\.(\d+)') { throw 'Cannot determine the Git version.' }
if ([int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 39)) { throw 'Git 2.39 or later is required.' }

$repository = if ($env:CODE_WORKSPACE_RELEASE_REPOSITORY) { $env:CODE_WORKSPACE_RELEASE_REPOSITORY } else { 'foxhello-ai/code-workspace' }
$downloadBase = if ($env:CODE_WORKSPACE_RELEASE_DOWNLOAD_BASE) { $env:CODE_WORKSPACE_RELEASE_DOWNLOAD_BASE.TrimEnd('/') } else { 'https://github.com' }
$appHome = if ($env:CODE_WORKSPACE_HOME) { [IO.Path]::GetFullPath($env:CODE_WORKSPACE_HOME) } else { Join-Path $env:LOCALAPPDATA 'CodeWorkspace' }
$binDirectory = if ($env:CODE_WORKSPACE_BIN_DIR) { [IO.Path]::GetFullPath($env:CODE_WORKSPACE_BIN_DIR) } else { Join-Path $appHome 'bin' }
$configDirectory = Join-Path $appHome 'config'
$configFile = Join-Path $configDirectory 'config.json'
$versionRequest = if ($env:CODE_WORKSPACE_VERSION) { $env:CODE_WORKSPACE_VERSION.TrimStart('v') } else { 'latest' }
if ($versionRequest -ne 'latest' -and $versionRequest -notmatch '^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$') { throw 'Invalid CODE_WORKSPACE_VERSION.' }
$archiveName = "code-workspace-$versionRequest-windows-x64.zip"
$releaseBase = if ($versionRequest -eq 'latest') { "$downloadBase/$repository/releases/latest/download" } else { "$downloadBase/$repository/releases/download/v$versionRequest" }
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('code-workspace-install-' + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)

function Download-ReleaseFile([string]$Uri, [string]$Destination) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination; return }
        catch { if ($attempt -eq 2) { throw }; Start-Sleep -Seconds 1 }
    }
}

New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
try {
    $archivePath = Join-Path $temporaryDirectory $archiveName
    Write-Host 'Downloading the compiled release...'
    Download-ReleaseFile "$releaseBase/$archiveName" $archivePath
    Download-ReleaseFile "$releaseBase/$archiveName.sha256" "$archivePath.sha256"
    $checksumText = [IO.File]::ReadAllText("$archivePath.sha256").Trim()
    if ($checksumText -notmatch '^([0-9a-fA-F]{64})(\s|$)') { throw 'Invalid SHA-256 checksum file.' }
    $expectedChecksum = $Matches[1]
    # Use .NET directly: Get-FileHash is a module function that may be missing
    # when Windows PowerShell inherits PowerShell 7's module search path.
    $archiveStream = [IO.File]::OpenRead($archivePath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actualChecksum = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '') }
    finally { $archiveStream.Dispose(); $hasher.Dispose() }
    if ($actualChecksum -ne $expectedChecksum) { throw 'Release archive SHA-256 verification failed.' }

    Write-Host 'SHA-256 verified. Extracting the release...'
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $temporaryDirectory)
    $packageDirectory = Join-Path $temporaryDirectory 'code-workspace'
    foreach ($requiredFile in @('dist/server/server/index.js', 'package.json', 'bin/code-workspace.mjs', 'bin/code-workspace.cmd')) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory $requiredFile) -PathType Leaf)) { throw "Incomplete release: $requiredFile" }
    }
    $package = [IO.File]::ReadAllText((Join-Path $packageDirectory 'package.json')) | ConvertFrom-Json
    $version = [string]$package.version
    if ($version -notmatch '^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$') { throw 'The release has an invalid version.' }
    if ($versionRequest -ne 'latest' -and $versionRequest -ne $version) { throw 'The release version does not match the requested version.' }

    $targetDirectory = Join-Path $appHome "versions/$version"
    Write-Host 'Installing files and preserving configuration...'
    $managerDirectory = Join-Path $appHome 'bin'
    foreach ($directory in @((Join-Path $appHome 'versions'), $managerDirectory, $binDirectory, $configDirectory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    # Only the current Windows account can read the generated password.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $configDirectory -AclObject $acl
    if (-not (Test-Path -LiteralPath $configFile)) {
        $randomBytes = New-Object byte[] 24
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
        $password = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $initialConfig = [ordered]@{
            HOST = $(if ($env:HOST) { $env:HOST } else { '127.0.0.1' })
            PORT = $(if ($env:PORT) { [int]$env:PORT } else { 43110 })
            APP_PASSWORD = $password
        }
        [IO.File]::WriteAllText($configFile, ($initialConfig | ConvertTo-Json), $utf8)
    }
    if (-not (Test-Path -LiteralPath $targetDirectory)) { Move-Item -LiteralPath $packageDirectory -Destination $targetDirectory }

    $manager = Join-Path $managerDirectory 'code-workspace.mjs'
    if ((Test-Path -LiteralPath $manager) -and (Test-Path -LiteralPath (Join-Path $appHome 'current.json'))) {
        & $nodeExecutable $manager stop
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the existing Code Workspace installation.' }
    }
    Copy-Item -LiteralPath (Join-Path $targetDirectory 'bin/code-workspace.mjs') -Destination $manager -Force
    if ($binDirectory -ne $managerDirectory) { Copy-Item -LiteralPath $manager -Destination (Join-Path $binDirectory 'code-workspace.mjs') -Force }
    Copy-Item -LiteralPath (Join-Path $targetDirectory 'bin/code-workspace.cmd') -Destination (Join-Path $binDirectory 'code-workspace.cmd') -Force
    [IO.File]::WriteAllText((Join-Path $binDirectory 'installation.json'), (@{ appHome = $appHome } | ConvertTo-Json), $utf8)
    $currentFile = Join-Path $appHome 'current.json'
    [IO.File]::WriteAllText("$currentFile.tmp", (@{ version = $version; path = $targetDirectory } | ConvertTo-Json), $utf8)
    Move-Item -LiteralPath "$currentFile.tmp" -Destination $currentFile -Force

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($env:CODE_WORKSPACE_SKIP_PATH_UPDATE -ne '1' -and @($userPath -split ';') -notcontains $binDirectory) {
        [Environment]::SetEnvironmentVariable('Path', ((([string]$userPath).TrimEnd(';') + ';' + $binDirectory).TrimStart(';')), 'User')
    }
    if (@($env:Path -split ';') -notcontains $binDirectory) { $env:Path = "$env:Path;$binDirectory" }
    Write-Host 'Starting the background service...'
    & $nodeExecutable $manager start
    if ($LASTEXITCODE -ne 0) { throw "Service startup failed. Check $(Join-Path $appHome 'state/server.log')." }
    $savedConfig = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
    $displayPort = if ($env:PORT) { $env:PORT } else { $savedConfig.PORT }
    $displayPassword = if ($env:APP_PASSWORD) { $env:APP_PASSWORD } else { $savedConfig.APP_PASSWORD }
    Write-Host "Installed Code Workspace $version`: http://127.0.0.1:$displayPort"
    Write-Host "Configuration: $configFile"
    Write-Host "Access password: $displayPassword"
    Write-Host 'Manage the service with: code-workspace start | status | logs | restart | stop'
}
finally { Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
