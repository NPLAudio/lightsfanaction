#![allow(dead_code)]
//! Running with administrator rights without a prompt each time.
//!
//! Fan control needs administrator rights. The installer registers two on-demand scheduled tasks that
//! start this program elevated; a task registered by an administrator can be started by an administrator
//! without a prompt. A normal launch (shortcut, startup, double-click) therefore hands over to the task
//! and exits, and the elevated copy does the work. If the tasks are missing (a build run from source, or
//! a standard account) nothing changes: the app starts as before and asks when it needs to.

use std::process::Command;
use std::time::{Duration, SystemTime};

/// Task that opens the app.
pub const TASK_OPEN: &str = "Lights Fan Action";
/// Task that starts the app minimized to the tray (used when starting with Windows).
pub const TASK_TRAY: &str = "Lights Fan Action (tray)";

#[cfg(windows)]
pub fn is_elevated() -> bool {
    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
    }
    // SAFETY: takes no arguments and only reads the calling process's token.
    unsafe { IsUserAnAdmin() != 0 }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// Starts this app through its elevated task. True when the task was started, so the caller should exit.
pub fn relaunch_via_task() -> bool {
    if is_elevated() {
        return false;
    }
    // never bounce more than once in quick succession, whatever goes wrong
    let marker = std::env::temp_dir().join("lfa-relaunch");
    if let Ok(modified) = std::fs::metadata(&marker).and_then(|m| m.modified()) {
        if SystemTime::now().duration_since(modified).unwrap_or(Duration::MAX) < Duration::from_secs(20) {
            return false;
        }
    }
    let task = if std::env::args().any(|a| a == "--minimized") { TASK_TRAY } else { TASK_OPEN };
    let mut cmd = Command::new("schtasks");
    cmd.args(["/run", "/tn", task]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let started = cmd.output().map(|o| o.status.success()).unwrap_or(false);
    if started {
        let _ = std::fs::write(&marker, b"");
    }
    started
}
