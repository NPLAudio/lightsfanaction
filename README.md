# Lights Fan Action

Open-source RGB lighting and fan control for Windows, in the spirit of SignalRGB: live effects, per-key keyboard lighting, a cooler screen, and temperature-driven fan curves with calibration. It lives in the system tray.

## What it does

- **Lighting.** Per-device effects with live previews, brightness and effect options. Lighting goes to real devices through a running **OpenRGB** server (turn on *SDK Server* in OpenRGB, port 6742). Keychron Q6 per-key lighting works with the patched firmware in `firmware/keychron-q6/`.
- **Fans.** Fans are controlled by default (administrator permission needed). Pumps and graphics card fans are hidden and left to their firmware unless switched on in Settings. Each fan has a temperature curve plus tunable smoothing, hysteresis, speed limits, a quiet cap and an emergency temperature. Stalled fans are kicked and flagged; fans that ignore commands are flagged. **Calibration** measures a fan's top speed, stall point and restart point (one fan or a batch, never pumps).
- **Cooler screen.** NZXT Kraken Elite (2024) display: live temperatures or a picture.
- **Tray.** Closing the window keeps the app running; the tray icon opens it, opens Settings, or quits (fans return to firmware control on quit).
- **Settings.** Start with Windows, close to tray, fan control on/off, include pumps, include graphics card fans. Developer options (a simulator for working without hardware) are hidden until you tap the version number in About seven times.

## Layout

- `src/` React UI built with shadcn/ui (Base UI + Tailwind). Pages in `src/pages/`, engine in `src/engine.ts`, fan controller in `src/lib/curve.ts` (unit-tested), calibration in `src/calibrate.ts`, settings in `src/settings.ts`.
- `src/lib/hybrid.ts` routes calls to OpenRGB, the fan hardware service, the Keychron keyboard and the simulator behind the `Backend` interface in `src/lib/types.ts`.
- `src-tauri/` Tauri shell: tray, close-to-tray, single instance, autostart, the OpenRGB client (`openrgb.rs`), Kraken screen (`kraken.rs`), Keychron/VIA keyboards (`via.rs`), and the launcher for the hardware service (`hw.rs`).
- `sidecar/` C# hardware service on LibreHardwareMonitor (sensors and fan controls). Started with a Windows administrator prompt.
- `firmware/keychron-q6/` patched Keychron Q6 firmware and flashing instructions.

## Develop

```
npm install
npm run dev         # browser, simulated hardware
npm run tauri dev   # desktop app
npm test            # controller unit tests
```

Requires Node, Rust (MSVC toolchain on Windows), WebView2 and the .NET 9 SDK. Build the hardware service once:

```
cd sidecar
dotnet publish -c Release -r win-x64 --self-contained false -o ../sidecar-publish
```

Environment switches for development: `LFA_NO_ELEVATE=1` runs the hardware service without administrator rights (limited sensors); `LFA_TRACE=1` logs rendered frames per 5 s to `%TEMP%\lfa-trace.log`, which shows whether a hidden window keeps running at full speed.

## Notes

- The webview is started with background throttling disabled, so effects and fan control keep running while the window is hidden in the tray.
- Starting with Windows launches the app minimized to the tray. With fan control on, Windows asks for administrator permission at each sign-in until the service is installed as a scheduled task (planned).
- The Keychron firmware is a patched build of Keychron's GPLv2 source; `lfa-per-key.patch` is the complete change.

## License

The app is MIT licensed (`LICENSE`). `firmware/keychron-q6/` is GPL-licensed (`firmware/keychron-q6/LICENSE`)
because it derives from Keychron's QMK firmware. Third-party components and their licenses are listed in
`THIRD_PARTY_NOTICES.md`.

## Roadmap

1. Bundle the hardware service with releases and start it without a prompt on every launch.
2. Profiles, scheduling, audio-reactive and screen-ambient effects, JS effect plugins.
