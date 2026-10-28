# Lights Fan Action

Open-source RGB lighting and fan control, in the spirit of SignalRGB: a clean UI, live effects, and proper temperature-driven fan curves.

## Status

- **Lighting**: per-device effects with live previews, brightness, colours, "sync all". 10 built-in effects (`src/lib/effects.ts`). In the desktop app, frames are sent to real devices through a running **OpenRGB** server (enable *SDK Server* in OpenRGB, port 6742). If OpenRGB isn't reachable the app falls back to simulated devices; click the status chip (top right) to rescan.
- **Fans**: draggable temperature→speed curves, presets, manual and full-speed modes. The controller (`src/lib/curve.ts`, unit-tested) smooths temperatures, applies hysteresis, a quiet cap, separate speed-up and slow-down rates with a hold time, can follow the hottest or average of several sensors, kick-starts stopped fans, and keeps zero-RPM fans from chattering. Fail-safes: 100% at the emergency temperature (per sensor type, adjustable) or when any source cannot be read; stalled fans are kicked, then given a higher floor and flagged; fans that do not follow commands are flagged. **Calibration** (Fans page) sweeps a fan to measure top speed, stall point and restart point (pumps are never calibrated; it refuses to start when warm and aborts if the temperature climbs). A **listen test** helps set a quiet cap. In the desktop app, *Enable hardware control* on the Fans page starts an elevated sidecar (`sidecar/`, built on LibreHardwareMonitor) that reads temperatures and drives real fan/pump controls. Pumps never go below 50%. Fans return to firmware control when the app closes, crashes, loses its connection, or stops sending updates for 8 s. Until enabled, fans are simulated.

## Layout

- `src/` React UI, effect engine (`engine.ts`), fan controller (`lib/curve.ts`).
- `src/lib/hybrid.ts` routes lighting to OpenRGB (via Tauri) and fans to the simulator, behind the `Backend` interface in `src/lib/types.ts`.
- `sidecar/` C# hardware service (LibreHardwareMonitor); `src-tauri/src/hw.rs` launches it via UAC and talks to it over loopback.
- `src-tauri/` desktop shell and the OpenRGB SDK client (`src/openrgb.rs`, unit-tested against a fake server).

## Roadmap

1. Bundle the sidecar with releases, self-contained, and start it without a UAC prompt on every launch (scheduled task or service).
2. Tray, autostart, run in background. This needs the effect engine moved into Rust, because a hidden webview is throttled.
3. Profiles, scheduling, audio-reactive and screen-ambient effects, JS effect plugins.

## Develop

```
npm install
npm run dev         # browser, simulated hardware
npm run tauri dev   # desktop app, real OpenRGB lighting
```

Requires Node, Rust (MSVC toolchain on Windows), WebView2 and the .NET 9 SDK. Build the hardware sidecar once:

```
cd sidecar
dotnet publish -c Release -r win-x64 --self-contained false -o ../sidecar-publish
```

Set `LFA_NO_ELEVATE=1` to run the sidecar without admin rights (limited sensors) while developing.
