# Lights Fan Action

Open-source RGB lighting and fan control for Windows, in the spirit of SignalRGB: live effects, per-key keyboard lighting, a cooler screen, and temperature-driven fan curves with calibration. It lives in the system tray.

## What it does

- **Lighting.** Per-device effects with live previews, brightness and effect options. Lighting goes to real devices through a running **OpenRGB** server (turn on *SDK Server* in OpenRGB, port 6742). Keychron Q6 per-key lighting works with the patched firmware in `firmware/keychron-q6/`.
- **Fans.** Fans are controlled by default (administrator permission needed). Pumps and graphics card fans are hidden and left to their firmware unless switched on in Settings. Each fan has a temperature curve plus tunable smoothing, hysteresis, speed limits, a quiet cap and an emergency temperature. Stalled fans are kicked and flagged; fans that ignore commands are flagged. **Calibration** measures a fan's top speed, stall point and restart point (one fan or a batch, never pumps).
- **Sound reactive.** Bass Pulse, Spectrum Analyzer, Shockwave, Level Meter, Energy Flow and Treble Sparkle follow whatever the PC is playing. The app listens to the default output device (loopback capture, no microphone) and turns it into 32 frequency bands, bass/mid/treble levels and beats; only those numbers are used, and listening runs only while a device is using one of these effects. Sensitivity is adjustable per effect.
- **Stream Deck.** A plugin adds keys and dials for temperatures, fan speeds (press for full speed), cooler status, lighting effects and brightness. **Lighting display keys** turn any keys you choose into one lighting screen: drop the action on keys, and each shows its own part of the deck's picture, placed by its column and row, so effects (sound-reactive ones too) flow across the buttons like a single display. The deck is an item in the lighting list with its own effect, update rate, detail and key gap, works with any Stream Deck model, Pressing a display key sends a ripple across the deck (switch it off in the deck options), and Temperature, Fan, Cooler, Lighting effect and Brightness keys can optionally draw over the lighting display, joining the deck's picture with their own readout on top. Keys without a display key or that option are never touched. Settings, General shows the plugin file; double-click it to install. It talks to the app through a local, token-protected API that only accepts effect, brightness and fan full-speed commands, plus deck reports and lighting frames.
- **Cooler.** NZXT Kraken Elite (2024). The ring and fan lights are driven directly over USB at up to 20 updates a second (the reports SignalRGB uses), so every effect, including sound-reactive ones, runs on it; close NZXT CAM first. The display is its own item in the lighting list, **Kraken display**, next to the cooler's lights, and is always live: choose *Stats only*, *Match cooler lighting*, or any effect, and the effect paints the background and the temperature gauge while the numbers stay readable (the gauge turns red as the liquid heats up). Choosing *Picture* holds an image of your own on the screen, and *Cooler's own screen* hands it back; its backlight and rotation are under Display options. Frames stream through the cooler's fast path. If direct light access is unavailable the lights fall back to the cooler's built-in effects.
- **Tray.** Closing the window keeps the app running; the tray icon opens it, opens Settings, or quits (fans return to firmware control on quit).
- **Settings.** Start with Windows, close to tray, fan control on/off, include pumps, include graphics card fans. Developer options (a simulator for working without hardware) are hidden until you tap the version number in About seven times.

## Layout

- `src/` React UI built with shadcn/ui (Base UI + Tailwind). Pages in `src/pages/`, engine in `src/engine.ts`, fan controller in `src/lib/curve.ts` (unit-tested), calibration in `src/calibrate.ts`, settings in `src/settings.ts`.
- `src/lib/hybrid.ts` routes calls to OpenRGB, the fan hardware service, the Keychron keyboard and the simulator behind the `Backend` interface in `src/lib/types.ts`.
- `src-tauri/` Tauri shell: tray, close-to-tray, single instance, autostart, the OpenRGB client (`openrgb.rs`), Kraken screen (`kraken.rs`), Keychron/VIA keyboards (`via.rs`), and the launcher for the hardware service (`hw.rs`).
- `streamdeck/` Stream Deck plugin (TypeScript, Elgato SDK). `npm run streamdeck:pack` builds `streamdeck/dist/*.streamDeckPlugin`; the installer ships it.
- `sidecar/` C# hardware service for sensors and fan controls (.NET Framework 4.7.2). It uses the separately installed LibreHardwareMonitor and is started with a Windows administrator prompt.
- `firmware/keychron-q6/` patched Keychron Q6 firmware and flashing instructions.

## Install

Download the MSI from the releases page and run it. Nothing third-party is included in the installer: its
"Programs it works with" page checks for these, shows what is missing, and links to each download.

| Needed for | Program | Notes |
| --- | --- | --- |
| The window | [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Already part of Windows 11. |
| Lighting | [OpenRGB](https://openrgb.org/releases.html) | Turn on its *SDK Server* (port 6742). For RAM lighting OpenRGB also needs the PawnIO driver. |
| Fan control | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest) | Unzip `LibreHardwareMonitor.zip` to `C:\Program Files\LibreHardwareMonitor`. It must be in a folder only administrators can change (the fan service runs with administrator rights and will not load libraries from anywhere else). The installer offers to set that up for you. Elsewhere? Set its folder under Settings, Fans. |

**No prompt each time.** Fan control needs administrator rights. The installer (which asks for permission once) registers two on-demand scheduled tasks, "Lights Fan Action" and "Lights Fan Action (tray)". Starting the app, from the Start menu or at sign-in, hands over to the matching task, which runs it elevated without a prompt. Only members of the Administrators group can use the tasks. If they are missing, or on a standard account, the app starts as before and asks when it needs to.

The installer asks for nothing else. The small fan service it installs (`sidecar/`) runs on the .NET Framework
that ships with Windows and loads LibreHardwareMonitor from its own folder.

## Build the installer

```
npm run build:msi
```

builds the fan service and then the MSI at `src-tauri/target/release/bundle/msi/`. The first run downloads the
WiX toolset. The wizard page that checks for the programs above is in `src-tauri/installer/main.wxs`.

## Develop

```
npm install
npm run dev         # browser, simulated hardware
npm run tauri dev   # desktop app
npm test            # controller unit tests
```

Requires Node, Rust (MSVC toolchain on Windows), WebView2 and a .NET SDK. Build the hardware service once:

```
npm run sidecar:release
```

Environment switches for development: `LFA_NO_ELEVATE=1` runs the hardware service without administrator rights (limited sensors); `LFA_TRACE=1` logs rendered frames per 5 s to `%TEMP%\lfa-trace.log`, which shows whether a hidden window keeps running at full speed.

## Notes

- The webview is started with background throttling disabled, so effects and fan control keep running while the window is hidden in the tray.
- Starting with Windows launches the app minimized to the tray. With the installer, fan control starts through a scheduled task, so there is no prompt at sign-in.
- The Keychron firmware is a patched build of Keychron's GPLv2 source; `lfa-per-key.patch` is the complete change.

## License

The app is MIT licensed (`LICENSE`). `firmware/keychron-q6/` is GPL-licensed (`firmware/keychron-q6/LICENSE`)
because it derives from Keychron's QMK firmware. Third-party components and their licenses are listed in
`THIRD_PARTY_NOTICES.md`.

## Roadmap

1. Code signing for the installer.
2. Profiles, scheduling, screen-ambient effects, JS effect plugins.
