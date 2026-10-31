//! A small local control API for companion tools such as the Stream Deck plugin.
//!
//! The app's state (sensors, fans, lighting) lives in its window, which keeps running while hidden in the
//! tray. The window publishes a snapshot here about once a second, and commands that arrive are handed
//! back to it as an event, so this module only moves JSON around.
//!
//! The app can run with administrator rights, so the API is deliberately narrow and guarded:
//! - it listens on loopback only, and rejects requests whose Host header is not the loopback address
//!   (which stops a web page from reaching it through DNS rebinding);
//! - every request needs the token written to `control.json` in the user's local app data folder;
//! - commands are a short list handled by the window (effects, brightness, fan mode), and the body is
//!   size-limited. Nothing can set an arbitrary fan speed.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

const MAX_BODY: usize = 4096;

/// Latest snapshot published by the window, as a JSON string.
#[derive(Default, Clone)]
pub struct Snapshot(pub Arc<Mutex<String>>);

pub fn info_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(base.join("Lights Fan Action").join("control.json"))
}

#[cfg(windows)]
fn random_bytes(buf: &mut [u8]) -> bool {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(algorithm: *mut core::ffi::c_void, buffer: *mut u8, count: u32, flags: u32) -> i32;
    }
    const USE_SYSTEM_PREFERRED_RNG: u32 = 2;
    // SAFETY: `buf` is valid for `count` bytes, and a null algorithm handle is allowed with the flag above.
    unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, USE_SYSTEM_PREFERRED_RNG) >= 0 }
}

#[cfg(not(windows))]
fn random_bytes(_buf: &mut [u8]) -> bool {
    false
}

fn new_token() -> Option<String> {
    let mut b = [0u8; 24];
    if !random_bytes(&mut b) {
        return None;
    }
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Starts the server on a free loopback port and records where it is. Failure only disables the API.
pub fn start(app: AppHandle, snapshot: Snapshot) {
    let Some(token) = new_token() else { return };
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let port = addr.port();

    let Some(path) = info_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let info = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() });
    if std::fs::write(&path, info.to_string()).is_err() {
        return;
    }

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let snapshot = snapshot.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, port, &token, &|v| { let _ = app.emit("control-command", v); }, &snapshot);
            });
        }
    });
}

/// Removes the discovery file so a client does not try a port that is gone.
pub fn stop() {
    if let Some(p) = info_path() {
        let _ = std::fs::remove_file(p);
    }
}

fn reply(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn handle(mut stream: TcpStream, port: u16, token: &str, emit: &dyn Fn(serde_json::Value), snapshot: &Snapshot) -> std::io::Result<()> {
    let result = respond(&mut stream, port, token, emit, snapshot);
    // closing with request data still unread makes Windows reset the connection and the client can lose the
    // reply, so finish our side and let the client's remaining bytes drain first
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let mut sink = [0u8; 1024];
    for _ in 0..16 {
        if !matches!(stream.read(&mut sink), Ok(n) if n > 0) {
            break;
        }
    }
    result
}

fn respond(stream: &mut TcpStream, port: u16, token: &str, emit: &dyn Fn(serde_json::Value), snapshot: &Snapshot) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    reader.by_ref().take(1024).read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));

    let (mut host, mut auth, mut length) = (String::new(), String::new(), 0usize);
    for _ in 0..32 {
        let mut line = String::new();
        reader.by_ref().take(2048).read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "host" => host = value.to_string(),
                "authorization" => auth = value.to_string(),
                "content-length" => length = value.parse().unwrap_or(usize::MAX),
                _ => {}
            }
        }
    }

    let loopback = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
    if !loopback {
        return reply(stream, "421 Misdirected Request", r#"{"error":"bad host"}"#);
    }
    let given = auth.strip_prefix("Bearer ").unwrap_or("");
    if !same(given, token) {
        return reply(stream, "401 Unauthorized", r#"{"error":"bad token"}"#);
    }

    match (method, path) {
        ("GET", "/state") => {
            let body = snapshot.0.lock().map(|s| s.clone()).unwrap_or_default();
            reply(stream, "200 OK", if body.is_empty() { "{}" } else { &body })
        }
        ("POST", "/command") => {
            if length > MAX_BODY {
                return reply(stream, "413 Payload Too Large", r#"{"error":"too large"}"#);
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body)?;
            match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(v) if v.is_object() => {
                    emit(v);
                    reply(stream, "202 Accepted", r#"{"ok":true}"#)
                }
                _ => reply(stream, "400 Bad Request", r#"{"error":"expected a JSON object"}"#),
            }
        }
        _ => reply(stream, "404 Not Found", r#"{"error":"not found"}"#),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
        assert!(!same("", "x"));
    }

    /// Runs the real request handler on a loopback port with a fake window behind it.
    fn serve(snapshot: &str) -> (u16, Arc<Mutex<Vec<serde_json::Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let got = Arc::new(Mutex::new(Vec::new()));
        let snap = Snapshot(Arc::new(Mutex::new(snapshot.to_string())));
        let sink = got.clone();
        std::thread::spawn(move || {
            for s in listener.incoming().flatten() {
                let sink = sink.clone();
                let _ = handle(s, port, "secret", &move |v| sink.lock().unwrap().push(v), &snap);
            }
        });
        (port, got)
    }

    fn request(port: u16, method: &str, path: &str, host: &str, auth: Option<&str>, body: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let auth = auth.map(|a| format!("Authorization: Bearer {a}\r\n")).unwrap_or_default();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{auth}Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn serves_state_and_accepts_commands_with_the_token() {
        let (port, got) = serve(r#"{"v":1}"#);
        let host = format!("127.0.0.1:{port}");

        let state = request(port, "GET", "/state", &host, Some("secret"), "");
        assert!(state.starts_with("HTTP/1.1 200"), "{state}");
        assert!(state.ends_with(r#"{"v":1}"#));

        let cmd = request(port, "POST", "/command", &host, Some("secret"), r#"{"cmd":"effect","effect":"solid"}"#);
        assert!(cmd.starts_with("HTTP/1.1 202"), "{cmd}");
        assert_eq!(got.lock().unwrap()[0]["effect"], "solid");
    }

    #[test]
    fn refuses_a_missing_or_wrong_token_and_foreign_hosts() {
        let (port, got) = serve("{}");
        let host = format!("127.0.0.1:{port}");
        assert!(request(port, "GET", "/state", &host, None, "").starts_with("HTTP/1.1 401"));
        assert!(request(port, "GET", "/state", &host, Some("nope"), "").starts_with("HTTP/1.1 401"));
        // a web page reaching the port through a rebinding name
        assert!(request(port, "GET", "/state", &format!("evil.example:{port}"), Some("secret"), "").starts_with("HTTP/1.1 421"));
        assert!(request(port, "POST", "/command", &host, Some("nope"), r#"{"cmd":"x"}"#).starts_with("HTTP/1.1 401"));
        assert!(got.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_commands() {
        let (port, got) = serve("{}");
        let host = format!("127.0.0.1:{port}");
        assert!(request(port, "POST", "/command", &host, Some("secret"), "[1]").starts_with("HTTP/1.1 400"));
        assert!(request(port, "POST", "/command", &host, Some("secret"), "not json").starts_with("HTTP/1.1 400"));
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BODY));
        assert!(request(port, "POST", "/command", &host, Some("secret"), &big).starts_with("HTTP/1.1 413"));
        assert!(request(port, "GET", "/nothing", &host, Some("secret"), "").starts_with("HTTP/1.1 404"));
        assert!(got.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
