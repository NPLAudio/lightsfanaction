//! NZXT Kraken Elite/Z3-family LCD control. Settings go over the HID interface; images go over a
//! bulk endpoint on a separate WinUSB interface. Protocol per liquidctl's `kraken3` driver.
//! Only the 2024 Elite RGB (0x3012, 640x640) has been tried.

use std::time::Duration;

use hidapi::{HidApi, HidDevice};
use nusb::MaybeFuture;
use serde::Serialize;

const VID: u16 = 0x1E71;
const PID: u16 = 0x3012;
pub const SIZE: usize = 640;
const BULK_OUT: u8 = 0x02;
const MEMORY_UNITS: u32 = 24320;
const BUCKETS: u8 = 16;
const REPORT: usize = 512;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct LcdInfo {
    pub brightness: u8,
    /// 0..3, quarter turns
    pub orientation: u8,
}

pub struct Kraken {
    hid: HidDevice,
}

impl Kraken {
    pub fn open() -> Result<Self, String> {
        let api = HidApi::new().map_err(|e| format!("hid init: {e}"))?;
        let hid = api
            .open(VID, PID)
            .map_err(|e| format!("cannot open the Kraken over HID (is NZXT CAM running?): {e}"))?;
        let k = Kraken { hid };
        k.drain();
        Ok(k)
    }

    /// Drops replies left over from earlier commands so they can't be mistaken for new ones.
    fn drain(&self) {
        let mut r = [0u8; REPORT];
        while matches!(self.hid.read_timeout(&mut r, 0), Ok(n) if n > 0) {}
    }

    /// Writes a command and returns whatever report comes back next.
    fn write_read(&self, cmd: &[u8]) -> Result<[u8; REPORT], String> {
        self.write(cmd)?;
        let mut r = [0u8; REPORT];
        let n = self.hid.read_timeout(&mut r, 1000).map_err(|e| format!("hid read: {e}"))?;
        if n == 0 { Err("Kraken did not answer".into()) } else { Ok(r) }
    }

    fn write(&self, cmd: &[u8]) -> Result<(), String> {
        // The command byte doubles as the HID report id; every output report is 512 bytes with id.
        let mut buf = [0u8; REPORT];
        buf[..cmd.len()].copy_from_slice(cmd);
        self.hid.write(&buf).map_err(|e| format!("hid write: {e}"))?;
        Ok(())
    }

    /// Writes a command and returns the first reply that starts with `prefix`.
    fn request(&self, cmd: &[u8], prefix: &[u8]) -> Result<[u8; REPORT], String> {
        self.write(cmd)?;
        for _ in 0..20 {
            let mut r = [0u8; REPORT];
            let n = self.hid.read_timeout(&mut r, 500).map_err(|e| format!("hid read: {e}"))?;
            if n == 0 {
                return Err("Kraken did not answer".into());
            }
            if r.starts_with(prefix) {
                return Ok(r);
            }
        }
        Err("Kraken did not send the expected reply".into())
    }

    pub fn info(&self) -> Result<LcdInfo, String> {
        let r = self.request(&[0x30, 0x01], &[0x31, 0x01])?;
        Ok(LcdInfo { brightness: r[0x18], orientation: r[0x1A] })
    }

    pub fn set_display(&self, brightness: u8, orientation: u8) -> Result<(), String> {
        self.write(&[0x30, 0x02, 0x01, brightness.min(100), 0, 0, 0x01, orientation & 3])
    }

    fn switch_bucket(&self, bucket: u8, mode: u8) -> Result<(), String> {
        let r = self.request(&[0x38, 0x01, mode, bucket], &[0x39, 0x01])?;
        if r[14] == 1 { Ok(()) } else { Err("Kraken refused to switch screen mode".into()) }
    }

    /// Sends colors straight to the pump ring and, if given, the fan channel, using the same reports as
    /// SignalRGB's plugin for this model: one 512-byte report per channel, GRB colors, no apply step.
    /// This is not the older 64-byte protocol that OpenRGB uses, which the cooler only follows about once a second.
    pub fn set_lights(&self, ring: &[[u8; 3]], fans: Option<&[[u8; 3]]>) -> Result<(), String> {
        self.write(&lights_packet(1, ring, RING_LEDS))?;
        if let Some(f) = fans {
            self.write(&lights_packet(2, f, FAN_LEDS))?;
        }
        Ok(())
    }

    /// Back to the built-in liquid temperature screen.
    pub fn show_liquid(&self) -> Result<(), String> {
        self.switch_bucket(0, 2)
    }

    fn bucket(&self, i: u8) -> Result<Option<(u32, u32)>, String> {
        let r = self.request(&[0x30, 0x04, i], &[0x31, 0x04])?;
        if r[15..].iter().all(|&b| b == 0) {
            return Ok(None);
        }
        Ok(Some((
            u16::from_le_bytes([r[17], r[18]]) as u32,
            u16::from_le_bytes([r[19], r[20]]) as u32,
        )))
    }

    fn delete_bucket(&self, i: u8) -> Result<(), String> {
        let r = self.request(&[0x32, 0x02, i], &[0x33, 0x02])?;
        if r[14] == 1 { Ok(()) } else { Err("Kraken refused to free image memory".into()) }
    }

    /// Shows a 640x640 image. `rgbx` is 4 bytes per pixel (R, G, B, ignored), row-major.
    pub fn show_image(&self, rgbx: &[u8]) -> Result<(), String> {
        if rgbx.len() != SIZE * SIZE * 4 {
            return Err(format!("image must be {SIZE}x{SIZE} with 4 bytes per pixel"));
        }
        let mut payload = rgbx.to_vec();
        for px in payload.chunks_exact_mut(4) {
            px[3] = 0;
        }

        // `[0x36, 0x03]` is undocumented but sent by the vendor software before bucket work
        self.write_read(&[0x36, 0x03])?;
        let mut buckets = Vec::new();
        for i in 0..BUCKETS {
            buckets.push(self.bucket(i)?);
        }
        let need = (20 + payload.len() as u32).div_ceil(1024);
        let idx = buckets.iter().position(Option::is_none).unwrap_or(0) as u8;
        if buckets[idx as usize].is_some() {
            self.delete_bucket(idx)?;
        }
        self.delete_bucket(idx)?;
        buckets[idx as usize] = None;

        let mut used: Vec<(u32, u32)> = buckets.iter().flatten().copied().collect();
        used.sort();
        let mut addr = 0;
        let fits = |a: u32, used: &[(u32, u32)]| {
            a + need <= MEMORY_UNITS && used.iter().all(|&(s, z)| a + need <= s || s + z <= a)
        };
        let mut candidates = vec![0];
        candidates.extend(used.iter().map(|&(s, z)| s + z));
        match candidates.into_iter().find(|&a| fits(a, &used)) {
            Some(a) => addr = a,
            None => {
                for i in 0..BUCKETS {
                    self.delete_bucket(i)?;
                }
            }
        }

        let setup = [
            0x32, 0x01, idx, idx + 1, addr as u8, (addr >> 8) as u8, need as u8, (need >> 8) as u8, 0x01,
        ];
        let r = self.request(&setup, &[0x33, 0x01])?;
        if r[14] != 1 {
            return Err("Kraken refused to allocate image memory".into());
        }
        self.write_read(&[0x36, 0x01, idx])?;
        self.bulk_write(&payload)?;
        self.write(&[0x36, 0x02])?;
        self.switch_bucket(idx, 4)
    }

    fn bulk_write(&self, payload: &[u8]) -> Result<(), String> {
        let dev = nusb::list_devices()
            .wait()
            .map_err(|e| format!("usb list: {e}"))?
            .find(|d| d.vendor_id() == VID && d.product_id() == PID)
            .ok_or("Kraken not found on USB")?;
        let device = dev.open().wait().map_err(|e| format!("usb open: {e}"))?;
        let iface = device
            .claim_interface(0)
            .wait()
            .map_err(|e| format!("cannot claim the Kraken's image interface (is NZXT CAM running?): {e}"))?;
        let mut ep = iface
            .endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(BULK_OUT)
            .map_err(|e| format!("bulk endpoint: {e}"))?;

        // the header must be its own transfer; the image follows in separate ones
        let mut header = vec![0x12, 0xFA, 0x01, 0xE8, 0xAB, 0xCD, 0xEF, 0x98, 0x76, 0x54, 0x32, 0x10];
        header.extend_from_slice(&[0x02, 0, 0, 0]); // static image
        header.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        let mut send = |bytes: &[u8]| {
            ep.transfer_blocking(bytes.to_vec().into(), Duration::from_secs(10))
                .status
                .map_err(|e| format!("image upload failed: {e}"))
        };
        send(&header)?;
        for chunk in payload.chunks(2 * 1024 * 1024) {
            send(chunk)?;
        }
        Ok(())
    }
}

/// LEDs in the pump ring.
pub const RING_LEDS: usize = 24;
/// LEDs SignalRGB addresses on the fan channel.
pub const FAN_LEDS: usize = 40;

/// One lighting report: `0x26 0x14`, the channel twice, then GRB triplets for `count` LEDs.
fn lights_packet(channel: u8, colors: &[[u8; 3]], count: usize) -> Vec<u8> {
    let mut p = vec![0x26, 0x14, channel, channel];
    for i in 0..count {
        let c = colors.get(i).copied().unwrap_or([0, 0, 0]);
        p.extend([c[1], c[0], c[2]]);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lighting_report_is_grb_and_padded_to_the_led_count() {
        let p = lights_packet(1, &[[1, 2, 3], [4, 5, 6]], RING_LEDS);
        assert_eq!(&p[..4], &[0x26, 0x14, 1, 1]);
        assert_eq!(&p[4..10], &[2, 1, 3, 5, 4, 6]);
        assert_eq!(p.len(), 4 + RING_LEDS * 3);
        assert!(p[10..].iter().all(|&b| b == 0));
        assert_eq!(lights_packet(2, &[], FAN_LEDS).len(), 4 + FAN_LEDS * 3);
        assert_eq!(&lights_packet(2, &[], FAN_LEDS)[..4], &[0x26, 0x14, 2, 2]);
    }

    #[test]
    fn rgb565_conversion_hits_the_extremes_and_ignores_the_fourth_byte() {
        assert_eq!(to_rgb565(&[255, 255, 255, 7, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0]), vec![0xFFFF, 0x0000, 0xF800, 0x07E0, 0x001F]);
    }
}

/// Converts R, G, B, ignored 8-bit pixels to RGB565 with rounding.
pub fn to_rgb565(rgbx: &[u8]) -> Vec<u16> {
    rgbx.chunks_exact(4)
        .map(|p| {
            let r = (p[0] as u32 * 249 + 1014) >> 11;
            let g = (p[1] as u32 * 253 + 505) >> 10;
            let b = (p[2] as u32 * 249 + 1014) >> 11;
            ((r << 11) | (g << 5) | b) as u16
        })
        .collect()
}

/// Streams frames to the screen the way the Elite's own "fast memory" path takes them: each frame is
/// Q565-compressed (a small RGB565 format) and sent with no bucket bookkeeping. The USB interface and HID
/// handle stay open between frames, so a frame costs one encode and one bulk transfer.
pub struct LcdStream {
    k: Kraken,
    ep: nusb::Endpoint<nusb::transfer::Bulk, nusb::transfer::Out>,
    _iface: nusb::Interface,
    encoded: Vec<u8>,
    /// false until the first frame has gone out; see `frame`
    warm: bool,
}

impl LcdStream {
    pub fn open() -> Result<Self, String> {
        let k = Kraken::open()?;
        let dev = nusb::list_devices()
            .wait()
            .map_err(|e| format!("usb list: {e}"))?
            .find(|d| d.vendor_id() == VID && d.product_id() == PID)
            .ok_or("Kraken not found on USB")?;
        let device = dev.open().wait().map_err(|e| format!("usb open: {e}"))?;
        let iface = device
            .claim_interface(0)
            .wait()
            .map_err(|e| format!("cannot claim the Kraken's image interface (is NZXT CAM running?): {e}"))?;
        let ep = iface
            .endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(BULK_OUT)
            .map_err(|e| format!("bulk endpoint: {e}"))?;
        // same preparation the vendor software does, then show the "bucket" screen the frames land in
        k.write_read(&[0x36, 0x03])?;
        k.switch_bucket(0, 4)?;
        Ok(LcdStream { k, ep, _iface: iface, encoded: Vec::with_capacity(256 * 1024), warm: false })
    }

    /// Shows one 640x640 frame (`pixels` is RGB565, row-major).
    pub fn frame(&mut self, pixels: &[u16]) -> Result<(), String> {
        if pixels.len() != SIZE * SIZE {
            return Err(format!("frame must be {SIZE}x{SIZE}"));
        }
        self.encoded.clear();
        if !q565::encode::Q565EncodeContext::encode_to_vec(SIZE as u16, SIZE as u16, pixels, &mut self.encoded) {
            return Err("could not compress the frame".into());
        }
        self.send_encoded()?;
        if !self.warm {
            // The first frame after the stream opens is sometimes lost while the screen is still switching to it
            // (seen on a 2024 Elite), and a picture that never changes would then never be resent. Sending it
            // twice, a moment apart, makes the first one reliable.
            std::thread::sleep(Duration::from_millis(150));
            self.send_encoded()?;
            self.warm = true;
        }
        Ok(())
    }

    /// Sends the frame in `self.encoded`: start, header, payload, end.
    fn send_encoded(&mut self) -> Result<(), String> {
        self.k.request(&[0x36, 0x01, 0x00, 0x01, 0x08], &[0x37, 0x01])?;
        let mut header = vec![0x12, 0xFA, 0x01, 0xE8, 0xAB, 0xCD, 0xEF, 0x98, 0x76, 0x54, 0x32, 0x10];
        header.extend_from_slice(&[0x08, 0, 0, 0]);
        header.extend_from_slice(&(self.encoded.len() as u32).to_le_bytes());
        let mut send = |bytes: Vec<u8>| {
            self.ep
                .transfer_blocking(bytes.into(), Duration::from_secs(5))
                .status
                .map_err(|e| format!("frame upload failed: {e}"))
        };
        send(header)?;
        send(self.encoded.clone())?;
        self.k.request(&[0x36, 0x02], &[0x37, 0x02])?;
        Ok(())
    }

    /// Back to the cooler's own liquid temperature screen.
    pub fn finish(&self) -> Result<(), String> {
        self.k.show_liquid()
    }
}
