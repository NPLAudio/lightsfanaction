mod hw;
pub mod kraken;
pub mod openrgb;
pub mod via;

use std::sync::Mutex;

use openrgb::{Client, DeviceInfo};
use tauri::{Manager, State};

const DEFAULT_ADDR: &str = "127.0.0.1:6742";

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
    for (idx, rgb) in frames {
        if let Err(e) = client.set_leds(idx, &rgb) {
            *guard = None;
            return Err(e);
        }
    }
    Ok(())
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
async fn kraken_liquid() -> Result<(), String> {
    kraken::Kraken::open()?.show_liquid()
}

/// Body is the raw 640x640 image, 4 bytes per pixel (alpha ignored).
#[tauri::command]
async fn kraken_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => kraken::Kraken::open()?.show_image(bytes),
        _ => Err("expected a raw image body".into()),
    }
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

#[derive(Default)]
struct Hw(Mutex<Option<hw::Client>>);

/// Starts the elevated hardware sidecar. Blocks while Windows shows the UAC prompt.
#[tauri::command]
async fn hw_start(state: State<'_, Hw>) -> Result<bool, String> {
    if let Some(mut old) = state.0.lock().map_err(|e| e.to_string())?.take() {
        old.shutdown();
    }
    let client = hw::Client::start()?;
    let elevated = client.elevated;
    *state.0.lock().map_err(|e| e.to_string())? = Some(client);
    Ok(elevated)
}

/// Sets fan duties and returns the latest sensors and fans. Any failure drops the connection;
/// the sidecar then returns fans to firmware control on its own.
#[tauri::command]
async fn hw_apply(state: State<'_, Hw>, set: Vec<(String, f64)>) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("hardware control is not running")?;
    match client.apply(&set) {
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
    tauri::Builder::default()
        .manage(Rgb::default())
        .manage(Hw::default())
        .manage(Keyboards::default())
        .invoke_handler(tauri::generate_handler![
            openrgb_connect,
            openrgb_update,
            openrgb_disconnect,
            openrgb_resize_zone,
            kraken_info,
            kraken_display,
            kraken_liquid,
            kraken_image,
            via_list,
            via_color,
            via_leds,
            via_restore,
            hw_start,
            hw_apply,
            hw_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lights Fan Action")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
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
