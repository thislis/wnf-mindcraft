[CmdletBinding(DefaultParameterSetName = "Deploy")]
param(
    [Parameter(ParameterSetName = "Deploy")]
    [switch]$SkipTests,

    [Parameter(Mandatory, ParameterSetName = "Rollback")]
    [switch]$Rollback,

    [Parameter(ParameterSetName = "Rollback")]
    [string]$BackupId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkspaceRoot = (Resolve-Path (Join-Path $RepoRoot "..")).Path
$ProjectRoot = (Resolve-Path (Join-Path $RepoRoot "server-plugin\firewater-game")).Path
$ServerRoot = (Resolve-Path (Join-Path $WorkspaceRoot "minecraft-server")).Path
$PluginsRoot = (Resolve-Path (Join-Path $ServerRoot "plugins")).Path
$BackupsRoot = Join-Path $ServerRoot "plugin-backups\firewater"
$Gradle = Join-Path $ProjectRoot "gradlew.bat"
$GameTarget = Join-Path $PluginsRoot "FirewaterGame.jar"
$LegacyTarget = Join-Path $PluginsRoot "AutoOpAll.jar"

function Assert-ServerStopped {
    $serverRootWithSlash = $ServerRoot.TrimEnd('\') + '\'
    $runningServer = Get-CimInstance Win32_Process | Where-Object {
        if (-not $_.CommandLine -or $_.Name -notmatch '^(?i)java(?:\.exe)?$') {
            return $false
        }

        $commandLooksLikePaper =
            $_.CommandLine -match '(?i)-jar\s+(?:"[^"]*"|\S*server\.jar)(?:\s|$)' -or
            $_.CommandLine -match '(?i)paper-[^\s"]+\.jar'
        $executableIsInsideServer =
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($serverRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)

        return $commandLooksLikePaper -and $executableIsInsideServer
    }

    if ($runningServer) {
        $ids = ($runningServer.ProcessId -join ", ")
        throw "Minecraft server is running (PID: $ids). Stop it normally before deploying or rolling back plugin JARs."
    }
}

function Assert-PluginJar {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$ExpectedName
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Plugin JAR not found: $Path"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $archive.GetEntry("plugin.yml")
        if (-not $entry) {
            throw "$Path does not contain plugin.yml"
        }
        $reader = [System.IO.StreamReader]::new($entry.Open())
        try {
            $descriptor = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $archive.Dispose()
    }

    if ($descriptor -notmatch '(?m)^name:\s*([^\r\n]+)') {
        throw "$Path has no plugin name in plugin.yml"
    }
    $actualName = $Matches[1].Trim().Trim("'", '"')
    if (-not $actualName.Equals($ExpectedName, [System.StringComparison]::Ordinal)) {
        throw "Expected plugin '$ExpectedName' but found '$actualName' in $Path"
    }
}

function Copy-FileAtomically {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Destination
    )

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path
    $destinationParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $Destination))
    if (-not $destinationParent.Equals($PluginsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to install outside the server plugins directory: $Destination"
    }

    $incoming = Join-Path $PluginsRoot ("." + [System.IO.Path]::GetFileName($Destination) + ".incoming-" + [guid]::NewGuid().ToString("N"))
    try {
        Copy-Item -LiteralPath $resolvedSource -Destination $incoming
        Assert-PluginJar -Path $incoming -ExpectedName "FirewaterGame"

        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            $replaceBackup = "$Destination.replace-backup"
            try {
                [System.IO.File]::Replace($incoming, $Destination, $replaceBackup, $true)
            } finally {
                if (Test-Path -LiteralPath $replaceBackup -PathType Leaf) {
                    Remove-Item -LiteralPath $replaceBackup -Force
                }
            }
        } else {
            [System.IO.File]::Move($incoming, $Destination)
        }
    } finally {
        if (Test-Path -LiteralPath $incoming -PathType Leaf) {
            Remove-Item -LiteralPath $incoming -Force
        }
    }
}

function New-PluginBackup {
    param([Parameter(Mandatory)] [string]$Reason)

    New-Item -ItemType Directory -Path $BackupsRoot -Force | Out-Null
    $id = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
    $directory = Join-Path $BackupsRoot $id
    New-Item -ItemType Directory -Path $directory | Out-Null

    $manifest = [ordered]@{
        schema = 1
        id = $id
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        reason = $Reason
        firewaterGameExisted = (Test-Path -LiteralPath $GameTarget -PathType Leaf)
        autoOpAllExisted = (Test-Path -LiteralPath $LegacyTarget -PathType Leaf)
        files = @{}
    }

    foreach ($item in @(
        @{ Name = "FirewaterGame.jar"; Path = $GameTarget },
        @{ Name = "AutoOpAll.jar"; Path = $LegacyTarget }
    )) {
        if (Test-Path -LiteralPath $item.Path -PathType Leaf) {
            $backupPath = Join-Path $directory $item.Name
            Copy-Item -LiteralPath $item.Path -Destination $backupPath
            $manifest.files[$item.Name] = [ordered]@{
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash
                length = (Get-Item -LiteralPath $backupPath).Length
            }
        }
    }

    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $directory "manifest.json") -Encoding utf8
    return $directory
}

function Get-BackupDirectory {
    if (-not (Test-Path -LiteralPath $BackupsRoot -PathType Container)) {
        throw "No Firewater plugin backups exist at $BackupsRoot"
    }

    if ($BackupId) {
        if ($BackupId -notmatch '^\d{8}T\d{9}Z$') {
            throw "BackupId must use the generated timestamp form, for example 20260721T123456789Z."
        }
        $candidate = Join-Path $BackupsRoot $BackupId
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
            throw "Backup not found: $BackupId"
        }
        return $candidate
    }

    $latest = Get-ChildItem -LiteralPath $BackupsRoot -Directory |
        Where-Object { $_.Name -match '^\d{8}T\d{9}Z$' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw "No valid Firewater plugin backup was found at $BackupsRoot"
    }
    return $latest.FullName
}

function Restore-FirewaterPlugin {
    param(
        [Parameter(Mandatory)] [bool]$Existed,
        [Parameter(Mandatory)] [string]$BackupPath
    )

    if ($Existed) {
        Assert-PluginJar -Path $BackupPath -ExpectedName "FirewaterGame"
        Copy-FileAtomically -Source $BackupPath -Destination $GameTarget
    } elseif (Test-Path -LiteralPath $GameTarget -PathType Leaf) {
        Remove-Item -LiteralPath $GameTarget -Force
    }
}

function Remove-LegacyAutoOp {
    if (Test-Path -LiteralPath $LegacyTarget -PathType Leaf) {
        Remove-Item -LiteralPath $LegacyTarget -Force
    }
}

Assert-ServerStopped

if ($Rollback) {
    $backupDirectory = Get-BackupDirectory
    $manifestPath = Join-Path $backupDirectory "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Backup manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schema -ne 1) {
        throw "Unsupported backup manifest schema: $($manifest.schema)"
    }

    $preRollbackBackup = New-PluginBackup -Reason "before rollback to $($manifest.id)"
    try {
        try {
            Restore-FirewaterPlugin -Existed ([bool]$manifest.firewaterGameExisted) `
                -BackupPath (Join-Path $backupDirectory "FirewaterGame.jar")
        } finally {
            # AutoOpAll is retained in backup manifests for forensics/manual recovery,
            # but this script never reactivates a plugin that grants every joiner OP.
            Remove-LegacyAutoOp
        }
    } catch {
        throw "Rollback failed. The pre-rollback state is preserved at $preRollbackBackup. $($_.Exception.Message)"
    }

    Write-Host "Rolled back FirewaterGame from $backupDirectory"
    Write-Host "AutoOpAll.jar remains quarantined in backups and was not reactivated."
    Write-Host "Pre-rollback state was preserved at $preRollbackBackup"
    exit 0
}

$backupDirectory = New-PluginBackup -Reason "before FirewaterGame deployment"
# Quarantine the universal-OP helper as soon as its backup is durable. A build
# failure may leave the previous FirewaterGame in place, but must never make it
# reasonable to restart Paper with AutoOpAll active again.
Remove-LegacyAutoOp

if (-not (Test-Path -LiteralPath $Gradle -PathType Leaf)) {
    throw "Gradle wrapper not found: $Gradle. AutoOpAll remains quarantined; backup: $backupDirectory"
}

$tasks = if ($SkipTests) { @("clean", "build", "-x", "test") } else { @("clean", "test", "build") }
& $Gradle --no-daemon -p $ProjectRoot @tasks
if ($LASTEXITCODE -ne 0) {
    throw "Gradle failed with exit code $LASTEXITCODE. The previous FirewaterGame JAR was not changed; AutoOpAll remains quarantined. Backup: $backupDirectory"
}

$gameJar = Get-ChildItem (Join-Path $ProjectRoot "build\libs") -Filter "firewater-game-*.jar" |
    Where-Object { $_.Name -notmatch '-(sources|javadoc|plain)\.jar$' } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $gameJar) {
    throw "FirewaterGame build completed but no plugin JAR was found."
}
Assert-PluginJar -Path $gameJar.FullName -ExpectedName "FirewaterGame"

try {
    Copy-FileAtomically -Source $gameJar.FullName -Destination $GameTarget

    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $gameJar.FullName).Hash
    $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $GameTarget).Hash
    if (-not $sourceHash.Equals($installedHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Installed FirewaterGame.jar hash does not match the build artifact."
    }

    # The FirewaterGame plugin owns dedicated bot permissions. The historical
    # helper granted every joining player OP, so it must never remain active.
    Remove-LegacyAutoOp
} catch {
    Write-Warning "Deployment failed; restoring the previous FirewaterGame JAR while keeping AutoOpAll quarantined."
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $backupDirectory "manifest.json") | ConvertFrom-Json
    try {
        Restore-FirewaterPlugin -Existed ([bool]$manifest.firewaterGameExisted) `
            -BackupPath (Join-Path $backupDirectory "FirewaterGame.jar")
    } finally {
        Remove-LegacyAutoOp
    }
    throw
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $GameTarget).Hash
$size = (Get-Item -LiteralPath $GameTarget).Length
Write-Host "Installed FirewaterGame.jar ($size bytes, SHA-256 $hash)."
Write-Host "Removed the active AutoOpAll.jar after backing it up."
Write-Host "Backup: $backupDirectory"
Write-Host "Start Paper normally, then verify /plugins and /fw status. Do not use /reload."
