//! Launches the elevated LibreHardwareMonitor sidecar and talks to it over loopback TCP.
//! Protocol: newline-delimited JSON, first line carries a one-time token.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub struct Client {
    reader: BufReader<TcpStream>,
    pub elevated: bool,
}

fn token() -> String {
    let s = RandomState::new();
    (0..2)
        .map(|i| {
            let mut h = s.build_hasher();
            h.write_u32(i);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// Dev builds use the freshly published sidecar in the repo; releases ship it next to the exe.
pub fn sidecar_path() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok()?.parent()?.join("sidecar").join("lfa-hw.exe");
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar-publish").join("lfa-hw.exe");
    [beside, dev].into_iter().find(|p| p.exists())
}

impl Client {
    /// Starts the sidecar (Windows shows a UAC prompt) and connects. Set LFA_NO_ELEVATE=1 to skip
    /// elevation; many sensors and all SuperIO fan controls then won't be available.
    ///
    /// `lhm_dir` is the folder LibreHardwareMonitor is installed in; when empty the service looks in the
    /// usual places itself.
    pub fn start(lhm_dir: Option<&str>) -> Result<Self, String> {
        let exe = sidecar_path().ok_or("hardware service not found (run `dotnet build -c Release -o sidecar-publish` in sidecar/)")?;
        let lhm_dir = lhm_dir.map(str::trim).filter(|d| !d.is_empty());
        let tok = token();
        let port_file = std::env::temp_dir().join(format!("lfa-hw-{}.port", std::process::id()));
        let _ = std::fs::remove_file(&port_file);
        let pid = std::process::id().to_string();

        // already elevated (started through the installer's task): the service inherits it, no prompt
        if std::env::var_os("LFA_NO_ELEVATE").is_some() || crate::elevate::is_elevated() {
            Command::new(&exe)
                .args(["--token", &tok, "--port-file"])
                .arg(&port_file)
                .args(["--parent", &pid])
                .args(lhm_dir.map(|d| ["--lhm-dir", d]).into_iter().flatten())
                .spawn()
                .map_err(|e| format!("cannot start sidecar: {e}"))?;
        } else {
            let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
            let mut list = vec![
                q("--token"), q(&tok), q("--port-file"), q(&port_file.to_string_lossy()), q("--parent"), q(&pid),
            ];
            if let Some(d) = lhm_dir {
                list.push(q("--lhm-dir"));
                list.push(q(d));
            }
            let script = format!(
                "Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -WindowStyle Hidden",
                q(&exe.to_string_lossy()),
                list.join(","),
            );
            let out = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
                .output()
                .map_err(|e| format!("cannot launch PowerShell: {e}"))?;
            if !out.status.success() {
                return Err("administrator permission was declined, so hardware control is off".into());
            }
        }

        let deadline = Instant::now() + Duration::from_secs(30);
        let port: u16 = loop {
            if let Ok(s) = std::fs::read_to_string(&port_file) {
                if let Ok(p) = s.trim().parse() {
                    break p;
                }
            }
            if Instant::now() > deadline {
                return Err("hardware sidecar did not start".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        };
        let _ = std::fs::remove_file(&port_file);

        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("sidecar connect: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
        stream.set_nodelay(true).ok();
        let mut c = Client { reader: BufReader::new(stream), elevated: false };
        let hello = c.request(&json!({ "token": tok }))?;
        if hello["ok"] != true {
            // the service explains itself, e.g. when LibreHardwareMonitor is not installed
            return Err(hello["error"].as_str().unwrap_or("the hardware service rejected the handshake").to_string());
        }
        c.elevated = hello["elevated"].as_bool().unwrap_or(false);
        Ok(c)
    }

    fn request(&mut self, v: &Value) -> Result<Value, String> {
        let mut line = v.to_string();
        line.push('\n');
        self.reader.get_mut().write_all(line.as_bytes()).map_err(|e| format!("sidecar write: {e}"))?;
        let mut resp = String::new();
        let n = self.reader.read_line(&mut resp).map_err(|e| format!("sidecar read: {e}"))?;
        if n == 0 {
            return Err("sidecar closed the connection".into());
        }
        serde_json::from_str(&resp).map_err(|e| format!("bad sidecar reply: {e}"))
    }

    /// Applies fan duties (id, percent), then returns fresh sensor and fan readings.
    pub fn apply(&mut self, set: &[(String, f64)], release: &[String]) -> Result<Value, String> {
        let set: Vec<Value> = set.iter().map(|(id, pct)| json!({ "id": id, "pct": pct })).collect();
        self.request(&json!({ "cmd": "apply", "set": set, "release": release }))
    }

    /// Hands every fan back to firmware control and stops the sidecar.
    pub fn shutdown(&mut self) {
        let _ = self.request(&json!({ "cmd": "shutdown" }));
    }
}
