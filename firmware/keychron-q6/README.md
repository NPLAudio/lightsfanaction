# Keychron Q6 firmware with per-key lighting

Keychron's current official firmware already has a per-key lighting command over USB (the one
their Launcher uses). Older Q6 firmware does not answer it, which is why the app could only set one
color for the whole keyboard. This folder holds a build of Keychron's official source with three
small additions, so the app can drive every key.

- `keychron_q6_ansi_lfa.bin`: the firmware for the **Q6 ANSI, no knob** (`keychron/q6/ansi`,
  USB `3434:0160`). Do not flash it on any other board or layout.
- `lfa-per-key.patch`: the full difference from Keychron's source (branch `2025q3`, commit
  `2b493ff95f2665db719b1e95c91babb5036e72f3`). Three changes:
  1. the per-key effect now honors each key's brightness (it used to ignore it, so dark colors
     showed at full brightness);
  2. setting the per-key type also switches the keyboard into the per-key effect, in RAM only;
  3. a new command pair (`0xA8 0x20` / `0xA8 0x21`, "version 2") stages a frame and applies it all at
     once at the start of a lighting pass. Without it, moving effects tore and flickered because the
     keyboard drew half-updated frames.
- `SHA256SUMS`: checksum of the `.bin`.

Everything the app sends is held in RAM. Unplugging the keyboard brings back its saved lighting.

## License

This folder is a derivative of Keychron's `qmk_firmware` (GPL-2.0-or-later) and is licensed under the GPL,
unlike the rest of the repository (MIT). The full text is in `LICENSE` here. The corresponding source for
the `.bin` is Keychron's commit named above plus `lfa-per-key.patch`.

## Before you flash

- Flashing replaces the keyboard's firmware. The chip's built-in bootloader cannot be overwritten,
  so you can always flash again, including Keychron's own firmware.
- Remaps and macros stored on the keyboard may be reset. If you changed any, export them first
  from the Keychron Launcher in Chrome or Edge (https://launcher.keychron.com).
- This firmware keeps Keychron's `VIA_INSECURE` build option on (it is on in their own firmware).
  It lets host software that can talk to the keyboard read key state, which is how the Launcher
  shows live key presses.

## Flash

1. Install QMK Toolbox: `winget install QMK.QMKToolbox`. It also installs the USB drivers.
2. Unplug the keyboard. Hold the **Esc** key (top-left), keep holding it, and plug the keyboard in.
3. QMK Toolbox should print "STM32 DFU device connected".
4. In Toolbox, open `keychron_q6_ansi_lfa.bin`, then click **Flash**. Wait for "Flash complete".
5. Unplug and replug the keyboard normally.

To check it worked, run the app and open Lighting: the Keychron should show as a per-key device
(no single-color note).

## Go back to stock

Download Keychron's official Q6 firmware from their site and flash it the same way, or build their
unmodified source:

```
git clone --depth 1 -b 2025q3 https://github.com/Keychron/qmk_firmware.git
make keychron/q6/ansi:keychron
```

## Rebuild this firmware

Use QMK MSYS (https://msys.qmk.fm), clone Keychron's `2025q3` branch with submodules, apply
`lfa-per-key.patch` (`git apply`), and run `make keychron/q6/ansi:keychron`.
