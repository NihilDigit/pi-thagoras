#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$BundleRoot, [Parameter(Mandatory)][string]$ExpectedManifestHash, [Parameter(Mandatory)][string]$UserSid)
$ErrorActionPreference = 'Stop'
if ($UserSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'Expected a Windows user SID.' }
$bundle = [IO.Path]::GetFullPath($BundleRoot)
$manifestPath = Join-Path $bundle 'manifest.json'
function Hash-File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
if ((Hash-File $manifestPath) -ne $ExpectedManifestHash) { throw 'Frozen release manifest changed.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.format -ne 1 -or $manifest.platform -ne 'win32' -or $manifest.files.Count -lt 10) { throw 'Unexpected Windows release.' }
function Assert-NoLinks([string]$Path) {
    for ($part=[IO.Path]::GetFullPath($Path); $part; $part=Split-Path $part -Parent) {
        if ((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release path contains a link.' }
        if ((Split-Path $part -Parent) -eq $part) { break }
    }
}
$base = Join-Path $env:ProgramData ('PiThagoras/' + $UserSid + '/releases')
$target = Join-Path $base $ExpectedManifestHash.Substring(0,16)
Assert-NoLinks $bundle
Assert-NoLinks $target
foreach ($file in $manifest.files) {
    if ([IO.Path]::IsPathFullyQualified($file.path)) { throw 'Manifest path escapes release scope.' }
    $source = [IO.Path]::GetFullPath((Join-Path $bundle $file.path))
    if (-not $source.StartsWith($bundle.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes release scope.' }
    Assert-NoLinks $source
    if ((Hash-File $source) -ne $file.sha256) { throw "Frozen release changed: $($file.path)" }
}
if (Test-Path -LiteralPath $target) {
    if ((Hash-File (Join-Path $target 'manifest.json')) -ne $ExpectedManifestHash) { throw 'Existing release has different content.' }
    foreach ($file in $manifest.files) { if ((Hash-File (Join-Path $target $file.path)) -ne $file.sha256) { throw 'Existing release changed.' } }
    @{ phase='already-installed'; releaseRoot=$target } | ConvertTo-Json
    exit 0
}
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$acl.SetAccessRuleProtection($true,$false)
foreach ($identity in @('S-1-5-18','S-1-5-32-544',$UserSid)) {
    $rights = if ($identity -eq $UserSid) { 'ReadAndExecute' } else { 'FullControl' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),$rights,'ContainerInherit,ObjectInherit','None','Allow'))
}
foreach ($directory in @((Join-Path $env:ProgramData 'PiThagoras'),(Split-Path $base -Parent),$base)) {
    if (-not (Test-Path -LiteralPath $directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null; Set-Acl -LiteralPath $directory -AclObject $acl }
    $security = Get-Acl -LiteralPath $directory
    $writes = [Security.AccessControl.FileSystemRights]'Write,Delete,ChangePermissions,TakeOwnership,DeleteSubdirectoriesAndFiles'
    if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544') -or @($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and ($_.FileSystemRights -band $writes) }).Count) { throw 'Release parent is writable by a non-administrator. No existing ACL was changed.' }
}
[IO.Directory]::CreateDirectory($target) | Out-Null
Set-Acl -LiteralPath $target -AclObject $acl
try {
    foreach ($file in $manifest.files) {
        $destination = Join-Path $target $file.path
        [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
        [IO.File]::WriteAllBytes($destination,[IO.File]::ReadAllBytes((Join-Path $bundle $file.path)))
        if ((Hash-File $destination) -ne $file.sha256) { throw 'Installed release hash mismatch.' }
    }
    [IO.File]::WriteAllBytes((Join-Path $target 'manifest.json'),[IO.File]::ReadAllBytes($manifestPath))
    @{ phase='installed'; releaseRoot=$target; files=$manifest.files.Count; manifestHash=$ExpectedManifestHash } | ConvertTo-Json
} catch {
    $failed = Join-Path $base ($ExpectedManifestHash.Substring(0,16) + '.failed-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
    $checkedBase = [IO.Path]::GetFullPath($base).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not ([IO.Path]::GetFullPath($target).StartsWith($checkedBase,[StringComparison]::OrdinalIgnoreCase)) -or -not ([IO.Path]::GetFullPath($failed).StartsWith($checkedBase,[StringComparison]::OrdinalIgnoreCase))) { throw 'Failed release cannot be retained outside its installation root.' }
    Move-Item -LiteralPath $target -Destination $failed
    @{ phase='failed'; releaseRoot=$target; error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bundle 'install-failure.json')
    throw
}
