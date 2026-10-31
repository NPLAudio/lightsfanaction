# Registers two on-demand scheduled tasks that start Lights Fan Action with administrator rights, so Windows
# does not ask for permission every time the app runs. Run by the installer, which is already elevated.
#
# The tasks have no schedule: nothing runs until the app itself (or you, with `schtasks /run`) starts one.
# They belong to the Administrators group, so a standard account cannot use them.
$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot 'lightsfanaction.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Lights Fan Action was not found at $exe" }

$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-544' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances Parallel   # a second start must run, so it can bring the open window to the front

$tasks = @(
    @{ Name = 'Lights Fan Action';        Arguments = $null;         Description = 'Opens Lights Fan Action with the rights it needs for fan control.' },
    @{ Name = 'Lights Fan Action (tray)'; Arguments = '--minimized'; Description = 'Starts Lights Fan Action in the tray with the rights it needs for fan control.' }
)

# The installer runs as SYSTEM, so by default only SYSTEM and the Administrators group may start these tasks.
# A person signed in as an administrator runs with a filtered token on which Administrators is deny-only, so
# starting a task would be refused and the app would fall back to a permission prompt. Allow the signed-in
# user to read and start them (nothing more): the task still runs with their own administrator rights, so a
# standard account that starts it gets nothing.
function Grant-Start($name) {
    $user = (Get-CimInstance Win32_ComputerSystem).UserName
    if (-not $user) { return }
    $sid = ([System.Security.Principal.NTAccount]$user).Translate([System.Security.Principal.SecurityIdentifier]).Value
    $folder = (New-Object -ComObject Schedule.Service)
    $folder.Connect()
    $task = $folder.GetFolder('\').GetTask($name)
    $sddl = $task.GetSecurityDescriptor(4)  # DACL
    $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;$sid)", 0)
}

foreach ($t in $tasks) {
    $params = @{ Execute = $exe; WorkingDirectory = $PSScriptRoot }
    if ($t.Arguments) { $params.Argument = $t.Arguments }
    $action = New-ScheduledTaskAction @params
    Register-ScheduledTask -TaskName $t.Name -Action $action -Principal $principal -Settings $settings `
        -Description $t.Description -Force | Out-Null
    try { Grant-Start $t.Name } catch { Write-Warning "Could not allow the signed-in user to start '$($t.Name)': $_" }
}
