//! A timestamped record of what the app does to the PC's hardware: starts and stops, OpenRGB connections and how
//! often each device is written to. It is there so that something odd (a monitor blanking, say) can be matched
//! against what the app was doing at that moment. Kept at `%LOCALAPPDATA%\Lights Fan Action\activity.log`.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

/// Starts over (keeping the previous log as activity.old.log) once the file gets this large.
const MAX_BYTES: u64 = 512 * 1024;
const SUMMARY_SECS: u64 = 60;

static WRITES: Mutex<BTreeMap<String, u32>> = Mutex::new(BTreeMap::new());

#[repr(C)]
#[derive(Default)]
struct SystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    millis: u16,
}

#[cfg(windows)]
extern "system" {
    fn GetLocalTime(out: *mut SystemTime);
}

/// The PC's local time, which is what someone looking at a blanked screen will have noticed.
fn timestamp() -> String {
    let mut t = SystemTime::default();
    #[cfg(windows)]
    unsafe {
        GetLocalTime(&mut t);
    }
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", t.year, t.month, t.day, t.hour, t.minute, t.second)
}

fn log_path() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?.join("Lights Fan Action");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("activity.log"))
}

pub fn log(line: &str) {
    let Some(path) = log_path() else { return };
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_file_name("activity.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}  {line}", timestamp());
    }
}

/// Counts one write to a device (named however the caller likes); the totals are logged once a minute.
pub fn count(device: &str) {
    if let Ok(mut m) = WRITES.lock() {
        *m.entry(device.to_string()).or_insert(0) += 1;
    }
}

/// Logs the app starting, then a summary of writes per minute for as long as it runs.
pub fn start() {
    log(&format!("app started (version {})", env!("CARGO_PKG_VERSION")));
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(SUMMARY_SECS));
        let taken = WRITES.lock().map(|mut m| std::mem::take(&mut *m)).unwrap_or_default();
        if taken.is_empty() {
            continue;
        }
        let parts: Vec<String> = taken.iter().map(|(k, v)| format!("{k}={v}")).collect();
        log(&format!("writes in the last minute: {}", parts.join(", ")));
    });
}

/// Lets the frontend add a line (device lists, effect changes, settings that affect what is written).
#[tauri::command]
pub fn activity_log(line: String) {
    log(&line.chars().take(400).collect::<String>());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_accumulate_per_device() {
        count("test-device-a");
        count("test-device-a");
        count("test-device-b");
        let m = WRITES.lock().unwrap();
        assert_eq!(m.get("test-device-a"), Some(&2));
        assert_eq!(m.get("test-device-b"), Some(&1));
    }

    #[test]
    fn timestamp_has_the_expected_shape() {
        let t = timestamp();
        assert_eq!(t.len(), 19);
    }
}
