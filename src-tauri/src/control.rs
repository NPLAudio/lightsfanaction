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

/// Clients listening on `/frames` (the Stream Deck plugin), which are sent lighting frames as they are rendered.
#[derive(Default, Clone)]
pub struct Subscribers(pub Arc<Mutex<Vec<TcpStream>>>);

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { BASE64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { BASE64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn broadcast(subs: &Subscribers, text: &str) {
    if let Ok(mut list) = subs.0.lock() {
        list.retain_mut(|s| s.set_write_timeout(Some(Duration::from_millis(150))).is_ok() && s.write_all(text.as_bytes()).is_ok());
    }
}

/// Sends one lighting frame to every listener, as a server-sent event: `meta` (what the pixels are) and the pixels.
pub fn publish_frame(subs: &Subscribers, meta: serde_json::Value, bytes: &[u8]) {
    if subs.0.lock().map(|l| l.is_empty()).unwrap_or(true) {
        return; // nobody is listening: do not even encode
    }
    broadcast(subs, &format!("data: {{\"meta\":{meta},\"b64\":\"{}\"}}\n\n", base64(bytes)));
}

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
pub fn start(app: AppHandle, snapshot: Snapshot, subs: Subscribers) {
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

    // keeps idle listeners alive, and drops the ones that have gone away
    let beat = subs.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        broadcast(&beat, ": ping\n\n");
    });

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let snapshot = snapshot.clone();
            let subs = subs.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, port, &token, &|event, v| { let _ = app.emit(event, v); }, &snapshot, &subs);
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

type Emit<'a> = &'a dyn Fn(&str, serde_json::Value);

fn handle(mut stream: TcpStream, port: u16, token: &str, emit: Emit, snapshot: &Snapshot, subs: &Subscribers) -> std::io::Result<()> {
    let result = respond(&mut stream, port, token, emit, snapshot, subs);
    // a listener's connection stays open; it now belongs to the subscriber list
    if matches!(result, Ok(true)) {
        return Ok(());
    }
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
    result.map(|_| ())
}

/// Answers one request. True means the connection was kept open as a listener.
fn respond(stream: &mut TcpStream, port: u16, token: &str, emit: Emit, snapshot: &Snapshot, subs: &Subscribers) -> std::io::Result<bool> {
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
    let done = |r: std::io::Result<()>| r.map(|_| false);
    if !loopback {
        return done(reply(stream, "421 Misdirected Request", r#"{"error":"bad host"}"#));
    }
    let given = auth.strip_prefix("Bearer ").unwrap_or("");
    if !same(given, token) {
        return done(reply(stream, "401 Unauthorized", r#"{"error":"bad token"}"#));
    }

    match (method, path) {
        ("GET", "/state") => {
            let body = snapshot.0.lock().map(|s| s.clone()).unwrap_or_default();
            done(reply(stream, "200 OK", if body.is_empty() { "{}" } else { &body }))
        }
        ("GET", "/frames") => {
            let keep = stream.try_clone()?;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: connected\n\n")?;
            subs.0.lock().map_err(|_| std::io::Error::other("listeners unavailable"))?.push(keep);
            Ok(true)
        }
        ("POST", "/command" | "/decks") => {
            // commands are small; a deck report lists the keys placed on each deck
            let limit = if path == "/decks" { 16 * 1024 } else { MAX_BODY };
            if length > limit {
                return done(reply(stream, "413 Payload Too Large", r#"{"error":"too large"}"#));
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body)?;
            let event = if path == "/decks" { "decks-report" } else { "control-command" };
            match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(v) if v.is_object() => {
                    emit(event, v);
                    done(reply(stream, "202 Accepted", r#"{"ok":true}"#))
                }
                _ => done(reply(stream, "400 Bad Request", r#"{"error":"expected a JSON object"}"#)),
            }
        }
        _ => done(reply(stream, "404 Not Found", r#"{"error":"not found"}"#)),
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
    fn serve(snapshot: &str) -> (u16, Arc<Mutex<Vec<serde_json::Value>>>, Subscribers) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let got = Arc::new(Mutex::new(Vec::new()));
        let snap = Snapshot(Arc::new(Mutex::new(snapshot.to_string())));
        let subs = Subscribers::default();
        let listeners = subs.clone();
        let sink = got.clone();
        std::thread::spawn(move || {
            for s in listener.incoming().flatten() {
                let sink = sink.clone();
                let _ = handle(
                    s,
                    port,
                    "secret",
                    &move |event, v| {
                        let v = if event == "control-command" { v } else { serde_json::json!({ "event": event, "body": v }) };
                        sink.lock().unwrap().push(v)
                    },
                    &snap,
                    &listeners,
                );
            }
        });
        (port, got, subs)
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
        let (port, got, _) = serve(r#"{"v":1}"#);
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
        let (port, got, _) = serve("{}");
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
        let (port, got, _) = serve("{}");
        let host = format!("127.0.0.1:{port}");
        assert!(request(port, "POST", "/command", &host, Some("secret"), "[1]").starts_with("HTTP/1.1 400"));
        assert!(request(port, "POST", "/command", &host, Some("secret"), "not json").starts_with("HTTP/1.1 400"));
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BODY));
        assert!(request(port, "POST", "/command", &host, Some("secret"), &big).starts_with("HTTP/1.1 413"));
        assert!(request(port, "GET", "/nothing", &host, Some("secret"), "").starts_with("HTTP/1.1 404"));
        assert!(got.lock().unwrap().is_empty());
    }

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0xfc]), "//79/A==");
    }

    #[test]
    fn a_deck_report_becomes_its_own_event() {
        let (port, got, _) = serve("{}");
        let host = format!("127.0.0.1:{port}");
        let r = request(port, "POST", "/decks", &host, Some("secret"), r#"{"decks":[{"id":"d1"}]}"#);
        assert!(r.starts_with("HTTP/1.1 202"), "{r}");
        let events = got.lock().unwrap();
        assert_eq!(events[0]["event"], "decks-report");
        assert_eq!(events[0]["body"]["decks"][0]["id"], "d1");
    }

    #[test]
    fn listeners_get_frames_and_are_dropped_when_they_leave() {
        let (port, _, subs) = serve("{}");
        let host = format!("127.0.0.1:{port}");
        // without the token there is no stream
        assert!(request(port, "GET", "/frames", &host, None, "").starts_with("HTTP/1.1 401"));

        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "GET /frames HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer secret\r\n\r\n").unwrap();
        c.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut head = [0u8; 256];
        let n = c.read(&mut head).unwrap();
        let head = String::from_utf8_lossy(&head[..n]).to_string();
        assert!(head.contains("text/event-stream"), "{head}");
        // the server registers the listener just after answering
        for _ in 0..50 {
            if !subs.0.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        publish_frame(&subs, serde_json::json!({ "deck": "d1", "g": 1 }), &[1, 2, 3]);
        let mut buf = [0u8; 256];
        let n = c.read(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.contains(r#""deck":"d1""#) && text.contains(r#""b64":"AQID""#), "{text}");

        drop(c);
        for _ in 0..5 {
            publish_frame(&subs, serde_json::json!({}), &[0; 4096]);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(subs.0.lock().unwrap().is_empty(), "a listener that left was kept");
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
