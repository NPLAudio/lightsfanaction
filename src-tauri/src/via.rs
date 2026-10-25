//! Colour control for QMK keyboards that speak the VIA raw-HID protocol (Keychron Q-series with
//! stock firmware, and many others). Stock firmware exposes only the built-in RGB matrix effects,
//! not per-key colours, so we switch the board to its solid-colour effect and stream one colour.
//! These "set value" commands do not touch the keyboard's EEPROM; a power cycle restores its own
//! saved lighting, and we write the original settings back when we let go.

use std::ffi::CString;

use hidapi::{HidApi, HidDevice};
use serde::Serialize;

const USAGE_PAGE: u16 = 0xFF60;
const USAGE: u16 = 0x61;

const GET_VALUE: u8 = 0x08;
const SET_VALUE: u8 = 0x07;
const RGB_MATRIX: u8 = 3;
const BRIGHTNESS: u8 = 1;
const EFFECT: u8 = 2;
const COLOR: u8 = 4;
const EFFECT_SOLID: u8 = 1;

#[derive(Serialize, Clone, Debug)]
pub struct ViaDevice {
    /// HID path; stable enough to reopen the same board during a session
    pub path: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug)]
struct Saved {
    effect: u8,
    brightness: u8,
    h: u8,
    s: u8,
}

pub struct Via {
    dev: HidDevice,
    saved: Saved,
    last: Option<(u8, u8, u8)>,
}

fn ask(dev: &HidDevice, cmd: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 33];
    out[1..1 + cmd.len()].copy_from_slice(cmd);
    dev.write(&out).map_err(|e| format!("keyboard write: {e}"))?;
    let mut r = [0u8; 32];
    let n = dev.read_timeout(&mut r, 500).map_err(|e| format!("keyboard read: {e}"))?;
    if n == 0 {
        return Err("keyboard did not answer".into());
    }
    Ok(r)
}

fn get(dev: &HidDevice, id: u8) -> Result<[u8; 32], String> {
    let r = ask(dev, &[GET_VALUE, RGB_MATRIX, id])?;
    // an unhandled command is echoed back as 0xFF
    if r[0] == GET_VALUE && r[1] == RGB_MATRIX && r[2] == id { Ok(r) } else { Err("no RGB matrix support".into()) }
}

/// Lists VIA keyboards that expose the RGB matrix channel.
pub fn find() -> Result<Vec<ViaDevice>, String> {
    let api = HidApi::new().map_err(|e| format!("hid init: {e}"))?;
    let mut out = Vec::new();
    for info in api.device_list().filter(|d| d.usage_page() == USAGE_PAGE && d.usage() == USAGE) {
        let Ok(dev) = info.open_device(&api) else { continue };
        if get(&dev, EFFECT).is_ok() {
            out.push(ViaDevice {
                path: info.path().to_string_lossy().into_owned(),
                name: info.product_string().unwrap_or("VIA keyboard").to_string(),
            });
        }
    }
    Ok(out)
}

fn hsv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (rf, gf, bf) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = rf.max(gf).max(bf);
    let d = max - rf.min(gf).min(bf);
    let h = if d == 0.0 {
        0.0
    } else if max == rf {
        ((gf - bf) / d).rem_euclid(6.0)
    } else if max == gf {
        (bf - rf) / d + 2.0
    } else {
        (rf - gf) / d + 4.0
    } / 6.0;
    let s = if max == 0.0 { 0.0 } else { d / max };
    ((h * 255.0).round() as u8, (s * 255.0).round() as u8, (max * 255.0).round() as u8)
}

impl Via {
    pub fn open(path: &str) -> Result<Self, String> {
        let api = HidApi::new().map_err(|e| format!("hid init: {e}"))?;
        let c = CString::new(path).map_err(|e| e.to_string())?;
        let dev = api.open_path(&c).map_err(|e| format!("cannot open the keyboard: {e}"))?;
        let effect = get(&dev, EFFECT)?[3];
        let brightness = get(&dev, BRIGHTNESS)?[3];
        let color = get(&dev, COLOR)?;
        Ok(Via { dev, saved: Saved { effect, brightness, h: color[3], s: color[4] }, last: None })
    }

    pub fn set_color(&mut self, r: u8, g: u8, b: u8) -> Result<(), String> {
        if self.last == Some((r, g, b)) {
            return Ok(());
        }
        if self.last.is_none() {
            ask(&self.dev, &[SET_VALUE, RGB_MATRIX, EFFECT, EFFECT_SOLID])?;
        }
        let (h, s, v) = hsv(r, g, b);
        ask(&self.dev, &[SET_VALUE, RGB_MATRIX, COLOR, h, s])?;
        ask(&self.dev, &[SET_VALUE, RGB_MATRIX, BRIGHTNESS, v])?;
        self.last = Some((r, g, b));
        Ok(())
    }

    /// Puts the keyboard's own lighting back.
    pub fn restore(&mut self) {
        let s = self.saved;
        let _ = ask(&self.dev, &[SET_VALUE, RGB_MATRIX, COLOR, s.h, s.s]);
        let _ = ask(&self.dev, &[SET_VALUE, RGB_MATRIX, BRIGHTNESS, s.brightness]);
        let _ = ask(&self.dev, &[SET_VALUE, RGB_MATRIX, EFFECT, s.effect]);
        self.last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::hsv;

    #[test]
    fn converts_primaries() {
        assert_eq!(hsv(255, 0, 0), (0, 255, 255));
        assert_eq!(hsv(0, 255, 0), (85, 255, 255));
        assert_eq!(hsv(0, 0, 255), (170, 255, 255));
        assert_eq!(hsv(255, 255, 255), (0, 0, 255));
        assert_eq!(hsv(0, 0, 0), (0, 0, 0));
    }
}
