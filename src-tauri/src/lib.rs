mod audio;
mod control;
mod elevate;
mod hw;
pub mod kraken;
pub mod openrgb;
pub mod via;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use openrgb::{Client, DeviceInfo};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WindowEvent};

const DEFAULT_ADDR: &str = "127.0.0.1:6742";

/// Whether closing the window hides it to the tray instead of quitting. The frontend sets this.
struct CloseToTray(AtomicBool);

/// Lighting frames sent, for the LFA_TRACE diagnostic (shows whether a hidden window keeps running).
static FRAMES: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn set_close_to_tray(state: State<'_, CloseToTray>, on: bool) {
    state.0.store(on, Ordering::Relaxed);
}

/// Diagnostics: with LFA_TRACE set, the frontend reports each rendered frame here so a log shows
/// whether a hidden window keeps running at full speed.
#[tauri::command]
fn trace_enabled() -> bool {
    std::env::var_os("LFA_TRACE").is_some()
}

#[tauri::command]
fn trace_ping() {
    FRAMES.fetch_add(1, Ordering::Relaxed);
}

fn trace_line(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("lfa-trace.log")) {
        let _ = writeln!(f, "{msg}");
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[derive(Default)]
struct Rgb(Mutex<Option<Client>>);

/// Connects to a running OpenRGB server (SDK server must be started in OpenRGB) and lists its devices.
#[tauri::command]
async fn openrgb_connect(state: State<'_, Rgb>, addr: Option<String>) -> Result<Vec<DeviceInfo>, String> {
    let mut client = Client::connect(addr.as_deref().unwrap_or(DEFAULT_ADDR))?;
    let devices = client.devices()?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(client);
    Ok(devices)
}

/// Pushes one frame. Each entry is (device index, flat RGB bytes). A failure drops the
/// connection so the frontend can notice and reconnect.
#[tauri::command]
async fn openrgb_update(state: State<'_, Rgb>, frames: Vec<(u32, Vec<u8>)>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("OpenRGB is not connected")?;
    FRAMES.fetch_add(1, Ordering::Relaxed);
    let trace = std::env::var_os("LFA_TRACE").is_some();
    for (idx, rgb) in frames {
        let started = std::time::Instant::now();
        let result = client.set_leds(idx, &rgb);
        if trace {
            trace_line(&format!("openrgb device {idx}: {} bytes, {} ms, {}", rgb.len(), started.elapsed().as_millis(), if result.is_ok() { "ok" } else { "ERROR" }));
        }
        if let Err(e) = result {
            if trace {
                trace_line(&format!("openrgb error on device {idx}: {e}"));
            }
            *guard = None;
            return Err(e);
        }
    }
    Ok(())
}

/// Starts a device's own built-in effect (see `Client::set_mode`).
#[tauri::command]
async fn openrgb_set_mode(
    state: State<'_, Rgb>,
    device: u32,
    mode: String,
    speed: Option<f32>,
    brightness: Option<f32>,
    colors: Vec<[u8; 3]>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("OpenRGB is not connected")?;
    client.set_mode(device, &mode, speed, brightness, &colors)
}

#[tauri::command]
async fn openrgb_disconnect(state: State<'_, Rgb>) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
async fn openrgb_resize_zone(state: State<'_, Rgb>, device: u32, zone: u32, count: u32) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("OpenRGB is not connected")?;
    client.resize_zone(device, zone, count)
}

/// The screen stream, kept open between frames. Image uploads and "back to liquid" take it down first,
/// because both need the same USB interface.
#[derive(Default)]
struct LcdStreamState(Mutex<Option<kraken::LcdStream>>);

/// Shows one 640x640 frame (raw body, 4 bytes per pixel, alpha ignored) through the fast streaming path.
#[tauri::command]
async fn kraken_stream_frame(state: State<'_, LcdStreamState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw image body".into());
    };
    let pixels = kraken::to_rgb565(bytes);
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(kraken::LcdStream::open()?);
    }
    let result = guard.as_mut().ok_or("the screen stream is not open")?.frame(&pixels);
    if result.is_err() {
        *guard = None;
    }
    result
}

/// Ends the stream and goes back to the cooler's own liquid temperature screen.
#[tauri::command]
async fn kraken_stream_stop(state: State<'_, LcdStreamState>) -> Result<(), String> {
    let stream = state.0.lock().map_err(|e| e.to_string())?.take();
    match stream {
        Some(s) => s.finish(),
        None => kraken::Kraken::open()?.show_liquid(),
    }
}

#[tauri::command]
async fn kraken_info() -> Result<kraken::LcdInfo, String> {
    kraken::Kraken::open()?.info()
}

#[tauri::command]
async fn kraken_display(brightness: u8, orientation: u8) -> Result<(), String> {
    kraken::Kraken::open()?.set_display(brightness, orientation)
}

/// Back to the cooler's built-in liquid temperature screen.
#[tauri::command]
async fn kraken_liquid(stream: State<'_, LcdStreamState>) -> Result<(), String> {
    drop(stream.0.lock().map_err(|e| e.to_string())?.take());
    kraken::Kraken::open()?.show_liquid()
}

/// Body is the raw 640x640 image, 4 bytes per pixel (alpha ignored).
#[tauri::command]
async fn kraken_image(stream: State<'_, LcdStreamState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    // the stream holds the image interface; let go of it first
    drop(stream.0.lock().map_err(|e| e.to_string())?.take());
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => kraken::Kraken::open()?.show_image(bytes),
        _ => Err("expected a raw image body".into()),
    }
}

/// A Kraken kept open for streamed lighting, so each frame is one cheap write.
#[derive(Default)]
struct KrakenLights(Mutex<Option<kraken::Kraken>>);

/// Streams one frame straight to the cooler: the first `ring` LEDs go to the pump ring, the rest to the fan
/// channel. `rgb` is 3 bytes per LED. A failure closes the handle so the next call reopens it.
#[tauri::command]
async fn kraken_lights(state: State<'_, KrakenLights>, rgb: Vec<u8>, ring: usize) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(kraken::Kraken::open()?);
    }
    let colors: Vec<[u8; 3]> = rgb.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    let (ring_colors, fan_colors) = colors.split_at(ring.min(colors.len()));
    let result = guard
        .as_ref()
        .ok_or("the Kraken is not open")?
        .set_lights(ring_colors, if fan_colors.is_empty() { None } else { Some(fan_colors) });
    if result.is_err() {
        *guard = None;
    }
    result
}

#[derive(Default)]
struct Keyboards(Mutex<std::collections::HashMap<String, via::Via>>);

#[tauri::command]
async fn via_list() -> Result<Vec<via::ViaDevice>, String> {
    via::find()
}

/// Sets one solid colour on a VIA keyboard (opens it, and remembers its own lighting, on first use).
#[tauri::command]
async fn via_color(state: State<'_, Keyboards>, path: String, r: u8, g: u8, b: u8) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if !map.contains_key(&path) {
        map.insert(path.clone(), via::Via::open(&path)?);
    }
    let result = map.get_mut(&path).unwrap().set_color(r, g, b);
    if result.is_err() {
        map.remove(&path);
    }
    result
}

/// Sets every key on a keyboard with per-key firmware. `rgb` is 3 bytes per LED.
#[tauri::command]
async fn via_leds(state: State<'_, Keyboards>, path: String, rgb: Vec<u8>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if !map.contains_key(&path) {
        map.insert(path.clone(), via::Via::open(&path)?);
    }
    let result = map.get_mut(&path).unwrap().set_leds(&rgb);
    if result.is_err() {
        map.remove(&path);
    }
    result
}

#[tauri::command]
async fn via_restore(state: State<'_, Keyboards>, path: String) -> Result<(), String> {
    if let Some(mut k) = state.0.lock().map_err(|e| e.to_string())?.remove(&path) {
        k.restore();
    }
    Ok(())
}

/// The window hands over its current state for the local control API (see `control`).
#[tauri::command]
fn control_publish(state: State<'_, control::Snapshot>, json: String) {
    if let Ok(mut s) = state.0.lock() {
        *s = json;
    }
}

/// Shows the Stream Deck plugin installer in Explorer; double-clicking it installs the plugin.
#[tauri::command]
fn show_streamdeck_plugin() -> Result<(), String> {
    let dir = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("no folder")?.join("streamdeck");
    let file = dir.join("com.nplaudio.lightsfanaction.streamDeckPlugin");
    if !file.exists() {
        return Err("the Stream Deck plugin is not part of this build".into());
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Default)]
struct Hw(Mutex<Option<hw::Client>>);

/// Starts the elevated hardware sidecar. Blocks while Windows shows the UAC prompt.
#[tauri::command]
async fn hw_start(state: State<'_, Hw>, lhm_dir: Option<String>) -> Result<bool, String> {
    if let Some(mut old) = state.0.lock().map_err(|e| e.to_string())?.take() {
        old.shutdown();
    }
    let client = hw::Client::start(lhm_dir.as_deref())?;
    let elevated = client.elevated;
    *state.0.lock().map_err(|e| e.to_string())? = Some(client);
    Ok(elevated)
}

/// Sets fan duties and returns the latest sensors and fans. Any failure drops the connection;
/// the sidecar then returns fans to firmware control on its own.
#[tauri::command]
async fn hw_apply(
    state: State<'_, Hw>,
    set: Vec<(String, f64)>,
    release: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("hardware control is not running")?;
    match client.apply(&set, &release.unwrap_or_default()) {
        Ok(v) => Ok(v),
        Err(e) => {
            *guard = None;
            Err(e)
        }
    }
}

#[tauri::command]
async fn hw_stop(state: State<'_, Hw>) -> Result<(), String> {
    if let Some(mut c) = state.0.lock().map_err(|e| e.to_string())?.take() {
        c.shutdown();
    }
    Ok(())
}

pub fn run() {
    // hand over to the elevated copy so fan control needs no prompt (release builds with the installer's tasks)
    #[cfg(not(debug_assertions))]
    if std::env::var_os("LFA_NO_ELEVATE").is_none() && elevate::relaunch_via_task() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(CloseToTray(AtomicBool::new(true)))
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Lights Fan Action", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (fans return to firmware)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("Lights Fan Action")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => {
                        show_main(app);
                        let _ = app.emit("open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            control::start(app.handle().clone(), app.state::<control::Snapshot>().inner().clone());
            audio::start(app.handle().clone(), app.state::<std::sync::Arc<audio::Control>>().inner().clone());
            // launched at login with --minimized: stay in the tray until opened
            if !std::env::args().any(|a| a == "--minimized") {
                show_main(app.handle());
            }
            if std::env::var_os("LFA_TRACE").is_some() {
                std::thread::spawn(|| {
                    use std::io::Write;
                    let path = std::env::temp_dir().join("lfa-trace.log");
                    let mut last = 0;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let now = FRAMES.load(Ordering::Relaxed);
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                            let _ = writeln!(f, "{} lighting frames in the last 5 s", now - last);
                        }
                        last = now;
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<CloseToTray>().0.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(Rgb::default())
        .manage(Hw::default())
        .manage(Keyboards::default())
        .manage(KrakenLights::default())
        .manage(LcdStreamState::default())
        .manage(control::Snapshot::default())
        .manage(std::sync::Arc::new(audio::Control::default()))
        .invoke_handler(tauri::generate_handler![
            openrgb_connect,
            openrgb_update,
            openrgb_disconnect,
            openrgb_resize_zone,
            openrgb_set_mode,
            kraken_info,
            kraken_display,
            kraken_liquid,
            kraken_image,
            kraken_lights,
            kraken_stream_frame,
            kraken_stream_stop,
            via_list,
            via_color,
            via_leds,
            via_restore,
            hw_start,
            hw_apply,
            hw_stop,
            set_close_to_tray,
            control_publish,
            audio::audio_set_active,
            audio::audio_set_device,
            audio::audio_devices,
            show_streamdeck_plugin,
            trace_enabled,
            trace_ping
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lights Fan Action")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                control::stop();
                if let Ok(mut m) = app.state::<Keyboards>().0.lock() {
                    for (_, k) in m.iter_mut() {
                        k.restore();
                    }
                }
                // fans go back to firmware control before we leave
                if let Ok(mut g) = app.state::<Hw>().0.lock() {
                    if let Some(mut c) = g.take() {
                        c.shutdown();
                    }
                }
            }
        });
}
