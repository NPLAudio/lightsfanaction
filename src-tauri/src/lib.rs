mod hw;
mod openrgb;

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
        .invoke_handler(tauri::generate_handler![
            openrgb_connect,
            openrgb_update,
            openrgb_disconnect,
            hw_start,
            hw_apply,
            hw_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lights Fan Action")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // fans go back to firmware control before we leave
                if let Ok(mut g) = app.state::<Hw>().0.lock() {
                    if let Some(mut c) = g.take() {
                        c.shutdown();
                    }
                }
            }
        });
}
