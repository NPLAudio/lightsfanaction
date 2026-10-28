# Removes the scheduled tasks created by register-tasks.ps1. Run by the uninstaller.
foreach ($name in 'Lights Fan Action', 'Lights Fan Action (tray)') {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
