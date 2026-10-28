# Third-party notices

Lights Fan Action's own code is MIT licensed (see `LICENSE`). The installer ships only this project's own
files; programs it works with are installed separately by the user. The software below is used under its own
license. Versions are those in the lock files at the time of writing.

## Firmware (GPL)

| Component | License | Where |
| --- | --- | --- |
| Keychron `qmk_firmware` (branch `2025q3`, commit `2b493ff95f2665db719b1e95c91babb5036e72f3`) and QMK | GPL-2.0-or-later | `firmware/keychron-q6/` |

`firmware/keychron-q6/keychron_q6_ansi_lfa.bin` is a build of Keychron's source with the changes in
`firmware/keychron-q6/lfa-per-key.patch`. That folder is licensed under the GPL, not the MIT license; its
text is in `firmware/keychron-q6/LICENSE`. The patch and the upstream commit together are the complete
corresponding source, and `firmware/keychron-q6/README.md` says how to rebuild it.

## Hardware service (C#)

| Component | License | Notes |
| --- | --- | --- |
| [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) 0.9.6 | MPL-2.0 | **Not distributed.** `sidecar/` is compiled against `LibreHardwareMonitorLib` and, at run time, loads the copy the user installed. |

## Rust (desktop shell)

| Crate | License |
| --- | --- |
| tauri, tauri-build, tauri-plugin-autostart, tauri-plugin-single-instance | Apache-2.0 OR MIT |
| hidapi | MIT |
| nusb | Apache-2.0 OR MIT |
| serde, serde_json | MIT OR Apache-2.0 |

Their own dependencies carry permissive licenses of the same kinds; run `cargo license` in `src-tauri/`
for the full list.

## JavaScript (interface)

| Package | License |
| --- | --- |
| react, react-dom, zustand, clsx, tailwind-merge, tailwindcss, @tailwindcss/vite, tw-animate-css, sonner, next-themes, @base-ui/react, shadcn (generated components in `src/components/ui/`) | MIT |
| class-variance-authority | Apache-2.0 |
| lucide-react (icons) | ISC |
| @fontsource-variable/geist (Geist font) | SIL Open Font License 1.1 |
| @tauri-apps/api, @tauri-apps/plugin-autostart | Apache-2.0 OR MIT |

Development tools (Vite, Vitest, TypeScript, oxlint, the Tauri CLI) are not shipped.

## Programs used but not included

- **OpenRGB** (GPL-2.0) is a separate program. Lights Fan Action talks to it over its network SDK and
  contains none of its code.
- **liquidctl** (GPL-3.0) documents the NZXT Kraken screen protocol. The protocol was reimplemented in
  Rust from that description; no liquidctl code is included.
- **PawnIO** (needed by OpenRGB for RAM lighting) is installed separately by the user and is not redistributed here.
- **WebView2** is Microsoft's runtime, part of Windows 11, and is not redistributed here.
