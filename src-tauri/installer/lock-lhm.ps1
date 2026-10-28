# Makes LibreHardwareMonitor's folder under Program Files changeable by administrators only. Run by the
# installer, which is already elevated, when the user leaves "Make it admin-only" ticked.
#
# Fan control runs with administrator rights and loads LibreHardwareMonitor's libraries, so the service
# refuses a folder that ordinary programs can change. A folder copied in by a regular user is owned by that user
# and gives them full control. This hands ownership to Administrators and removes every other account's write
# access. Files already inside are not inspected.
$ErrorActionPreference = 'Stop'

$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$write = [System.Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'

foreach ($root in @((Join-Path $env:ProgramFiles 'LibreHardwareMonitor'), (Join-Path ${env:ProgramFiles(x86)} 'LibreHardwareMonitor'))) {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'LibreHardwareMonitorLib.dll'))) { continue }

    # inherited entries cannot be removed one by one, so make them explicit first
    & icacls.exe $root /inheritance:d /T /C /Q | Out-Null
    & icacls.exe $root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null

    $sids = Get-Acl -LiteralPath $root | ForEach-Object { $_.Access } |
        Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $write) } |
        ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } |
        Where-Object { $trusted -notcontains $_ } | Sort-Object -Unique
    foreach ($sid in $sids) { & icacls.exe $root /remove:g "*$sid" /T /C /Q | Out-Null }
}
