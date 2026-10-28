//! Minimal OpenRGB SDK client (TCP, little-endian). Speaks protocol v4 at most, which every
//! OpenRGB release since 0.9 accepts; newer servers downgrade to what the client announces.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

const MAGIC: &[u8; 4] = b"ORGB";
const MAX_PROTO: u32 = 4;
const TIMEOUT: Duration = Duration::from_secs(2);

const REQUEST_CONTROLLER_COUNT: u32 = 0;
const REQUEST_CONTROLLER_DATA: u32 = 1;
const REQUEST_PROTOCOL_VERSION: u32 = 40;
const SET_CLIENT_NAME: u32 = 50;
const RESIZE_ZONE: u32 = 1000;
const UPDATE_LEDS: u32 = 1050;
const UPDATE_MODE: u32 = 1101;

const MODE_FLAG_HAS_SPEED: u32 = 1 << 0;
const MODE_FLAG_HAS_BRIGHTNESS: u32 = 1 << 4;
const COLOR_MODE_MODE_SPECIFIC: u32 = 2;

/// One lighting mode of a device (OpenRGB's mode_t), as reported by the server.
#[derive(Clone, Debug, PartialEq)]
pub struct ModeInfo {
    pub name: String,
    pub value: u32,
    pub flags: u32,
    pub speed_min: u32,
    pub speed_max: u32,
    pub brightness_min: u32,
    pub brightness_max: u32,
    pub colors_min: u32,
    pub colors_max: u32,
    pub speed: u32,
    pub brightness: u32,
    pub direction: u32,
    pub color_mode: u32,
    pub colors: Vec<[u8; 3]>,
}
const SET_CUSTOM_MODE: u32 = 1100;

#[derive(Serialize, Clone, Debug)]
pub struct ZoneInfo {
    pub name: String,
    /// 0 single, 1 linear, 2 matrix
    pub kind: i32,
    pub led_count: u32,
    /// resizable zones (e.g. addressable headers) report min < max
    pub min_leds: u32,
    pub max_leds: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceInfo {
    pub index: u32,
    pub name: String,
    /// OpenRGB device type (0 motherboard, 1 DRAM, 2 GPU, 3 cooler, 4 LED strip, 5 keyboard, 6 mouse, ...)
    pub kind: u32,
    pub led_count: u32,
    /// set when the device exposes a single LED matrix whose cells cover every LED
    pub cols: Option<u32>,
    pub zones: Vec<ZoneInfo>,
    pub modes: Vec<String>,
    pub active_mode: u32,
    #[serde(skip)]
    pub mode_info: Vec<ModeInfo>,
}

pub struct Client {
    stream: TcpStream,
    proto: u32,
    in_custom_mode: HashSet<u32>,
    modes: std::collections::HashMap<u32, Vec<ModeInfo>>,
}

impl Client {
    pub fn connect(addr: &str) -> Result<Self, String> {
        let sock = addr
            .to_socket_addrs()
            .map_err(|e| format!("bad address {addr}: {e}"))?
            .next()
            .ok_or_else(|| format!("bad address {addr}"))?;
        let stream = TcpStream::connect_timeout(&sock, Duration::from_millis(1500))
            .map_err(|e| format!("cannot reach OpenRGB at {addr}: {e}"))?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(TIMEOUT)).ok();
        stream.set_write_timeout(Some(TIMEOUT)).ok();

        let mut c = Client { stream, proto: 0, in_custom_mode: HashSet::new(), modes: Default::default() };
        c.send(0, REQUEST_PROTOCOL_VERSION, &MAX_PROTO.to_le_bytes())?;
        let body = c.recv(REQUEST_PROTOCOL_VERSION)?;
        let server = u32::from_le_bytes(body.get(..4).ok_or("short protocol reply")?.try_into().unwrap());
        c.proto = server.min(MAX_PROTO);
        c.send(0, SET_CLIENT_NAME, b"Lights Fan Action\0")?;
        Ok(c)
    }

    fn send(&mut self, dev: u32, id: u32, data: &[u8]) -> Result<(), String> {
        let mut pkt = Vec::with_capacity(16 + data.len());
        pkt.extend_from_slice(MAGIC);
        pkt.extend_from_slice(&dev.to_le_bytes());
        pkt.extend_from_slice(&id.to_le_bytes());
        pkt.extend_from_slice(&(data.len() as u32).to_le_bytes());
        pkt.extend_from_slice(data);
        self.stream.write_all(&pkt).map_err(|e| format!("send failed: {e}"))
    }

    /// Reads packets until one with `want` arrives; the server may interleave notifications.
    fn recv(&mut self, want: u32) -> Result<Vec<u8>, String> {
        loop {
            let mut h = [0u8; 16];
            self.stream.read_exact(&mut h).map_err(|e| format!("read failed: {e}"))?;
            if &h[..4] != MAGIC {
                return Err("not an OpenRGB server (bad magic)".into());
            }
            let id = u32::from_le_bytes(h[8..12].try_into().unwrap());
            let size = u32::from_le_bytes(h[12..16].try_into().unwrap()) as usize;
            if size > 16 * 1024 * 1024 {
                return Err("oversized packet".into());
            }
            let mut body = vec![0u8; size];
            self.stream.read_exact(&mut body).map_err(|e| format!("read failed: {e}"))?;
            if id == want {
                return Ok(body);
            }
        }
    }

    pub fn devices(&mut self) -> Result<Vec<DeviceInfo>, String> {
        self.send(0, REQUEST_CONTROLLER_COUNT, &[])?;
        let body = self.recv(REQUEST_CONTROLLER_COUNT)?;
        let count = u32::from_le_bytes(body.get(..4).ok_or("short count reply")?.try_into().unwrap());
        let mut out = Vec::new();
        for i in 0..count {
            self.send(i, REQUEST_CONTROLLER_DATA, &self.proto.to_le_bytes())?;
            let body = self.recv(REQUEST_CONTROLLER_DATA)?;
            let dev = parse_device(i, &body, self.proto)?;
            self.modes.insert(i, dev.mode_info.clone());
            out.push(dev);
        }
        Ok(out)
    }

    /// Changes how many LEDs an addressable zone drives. The device must be re-listed afterwards.
    pub fn resize_zone(&mut self, dev: u32, zone: u32, count: u32) -> Result<(), String> {
        let mut p = Vec::with_capacity(8);
        p.extend_from_slice(&zone.to_le_bytes());
        p.extend_from_slice(&count.to_le_bytes());
        self.in_custom_mode.remove(&dev);
        self.send(dev, RESIZE_ZONE, &p)
    }

    /// Switches a device to one of its own built-in effects. The device then animates by itself, so no
    /// frames have to be streamed (slow devices cannot take them anyway). `speed` and `brightness` are
    /// 0 to 1 of the mode's own range; `colors` apply to modes that take their own colors. A later
    /// `set_leds` puts the device back into direct mode.
    pub fn set_mode(&mut self, dev: u32, name: &str, speed: Option<f32>, brightness: Option<f32>, colors: &[[u8; 3]]) -> Result<(), String> {
        let list = self.modes.get(&dev).ok_or("device modes are unknown; list devices first")?;
        let (idx, base) = list
            .iter()
            .enumerate()
            .find(|(_, m)| m.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("this device has no mode called {name}"))?;
        let mut m = base.clone();
        if let (Some(s), true) = (speed, m.flags & MODE_FLAG_HAS_SPEED != 0) {
            m.speed = lerp(m.speed_min, m.speed_max, s);
        }
        if let (Some(b), true) = (brightness, m.flags & MODE_FLAG_HAS_BRIGHTNESS != 0) {
            m.brightness = lerp(m.brightness_min, m.brightness_max, b);
        }
        if m.color_mode == COLOR_MODE_MODE_SPECIFIC && !colors.is_empty() {
            let mut cs: Vec<[u8; 3]> = colors.iter().copied().take(m.colors_max.max(1) as usize).collect();
            while (cs.len() as u32) < m.colors_min {
                cs.push(*cs.last().unwrap());
            }
            // a mode with no brightness control of its own is dimmed through its colors instead
            if let (Some(b), true) = (brightness, m.flags & MODE_FLAG_HAS_BRIGHTNESS == 0) {
                for c in cs.iter_mut() {
                    for ch in c.iter_mut() {
                        *ch = (*ch as f32 * b.clamp(0.0, 1.0)).round() as u8;
                    }
                }
            }
            m.colors = cs;
        }
        let body = encode_mode(&m, self.proto);
        let mut p = Vec::with_capacity(8 + body.len());
        p.extend_from_slice(&((8 + body.len()) as u32).to_le_bytes());
        p.extend_from_slice(&(idx as u32).to_le_bytes());
        p.extend_from_slice(&body);
        self.in_custom_mode.remove(&dev);
        self.send(dev, UPDATE_MODE, &p)
    }

    /// Round trip through the server's request queue. The server handles one packet at a time, so a
    /// long time here means it is behind on frames we already sent.
    pub fn ping(&mut self) -> Result<std::time::Duration, String> {
        let started = std::time::Instant::now();
        self.send(0, REQUEST_CONTROLLER_COUNT, &[])?;
        self.recv(REQUEST_CONTROLLER_COUNT)?;
        Ok(started.elapsed())
    }

    pub fn set_leds(&mut self, dev: u32, rgb: &[u8]) -> Result<(), String> {
        if self.in_custom_mode.insert(dev) {
            self.send(dev, SET_CUSTOM_MODE, &[])?;
        }
        let n = rgb.len() / 3;
        let mut p = Vec::with_capacity(6 + n * 4);
        p.extend_from_slice(&((4 + 2 + n * 4) as u32).to_le_bytes());
        p.extend_from_slice(&(n as u16).to_le_bytes());
        for c in rgb.chunks_exact(3) {
            p.extend_from_slice(&[c[0], c[1], c[2], 0]);
        }
        self.send(dev, UPDATE_LEDS, &p)
    }
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("truncated device data")?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.take(n).map(|_| ())
    }
    fn mode(&mut self, proto: u32) -> Result<ModeInfo, String> {
        let name = self.string()?;
        let value = self.u32()?;
        let flags = self.u32()?;
        let speed_min = self.u32()?;
        let speed_max = self.u32()?;
        let (brightness_min, brightness_max) = if proto >= 3 { (self.u32()?, self.u32()?) } else { (0, 0) };
        let colors_min = self.u32()?;
        let colors_max = self.u32()?;
        let speed = self.u32()?;
        let brightness = if proto >= 3 { self.u32()? } else { 0 };
        let direction = self.u32()?;
        let color_mode = self.u32()?;
        let n = self.u16()? as usize;
        let mut colors = Vec::with_capacity(n);
        for _ in 0..n {
            let c = self.take(4)?;
            colors.push([c[0], c[1], c[2]]);
        }
        Ok(ModeInfo {
            name,
            value,
            flags,
            speed_min,
            speed_max,
            brightness_min,
            brightness_max,
            colors_min,
            colors_max,
            speed,
            brightness,
            direction,
            color_mode,
            colors,
        })
    }
    /// u16 length (including the trailing NUL) followed by that many bytes
    fn string(&mut self) -> Result<String, String> {
        let n = self.u16()? as usize;
        let s = self.take(n)?;
        Ok(String::from_utf8_lossy(s.split(|&c| c == 0).next().unwrap_or(&[])).into_owned())
    }
}

fn push_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&((s.len() + 1) as u16).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
    out.push(0);
}

/// The wire form of a mode, the inverse of `Reader::mode`.
fn encode_mode(m: &ModeInfo, proto: u32) -> Vec<u8> {
    let mut o = Vec::new();
    push_str(&mut o, &m.name);
    for v in [m.value, m.flags, m.speed_min, m.speed_max] {
        o.extend_from_slice(&v.to_le_bytes());
    }
    if proto >= 3 {
        o.extend_from_slice(&m.brightness_min.to_le_bytes());
        o.extend_from_slice(&m.brightness_max.to_le_bytes());
    }
    o.extend_from_slice(&m.colors_min.to_le_bytes());
    o.extend_from_slice(&m.colors_max.to_le_bytes());
    o.extend_from_slice(&m.speed.to_le_bytes());
    if proto >= 3 {
        o.extend_from_slice(&m.brightness.to_le_bytes());
    }
    o.extend_from_slice(&m.direction.to_le_bytes());
    o.extend_from_slice(&m.color_mode.to_le_bytes());
    o.extend_from_slice(&(m.colors.len() as u16).to_le_bytes());
    for c in &m.colors {
        o.extend_from_slice(&[c[0], c[1], c[2], 0]);
    }
    o
}

fn lerp(min: u32, max: u32, t: f32) -> u32 {
    (min as f32 + (max as f32 - min as f32) * t.clamp(0.0, 1.0)).round() as u32
}

fn parse_device(index: u32, body: &[u8], proto: u32) -> Result<DeviceInfo, String> {
    let mut r = Reader { b: body, p: 0 };
    r.u32()?; // total size
    let kind = r.u32()?;
    let name = r.string()?;
    if proto >= 1 {
        r.string()?; // vendor
    }
    for _ in 0..4 {
        r.string()?; // description, version, serial, location
    }

    let n_modes = r.u16()?;
    let active_mode = r.u32()?;
    let mut mode_info = Vec::new();
    for _ in 0..n_modes {
        mode_info.push(r.mode(proto)?);
    }
    let modes: Vec<String> = mode_info.iter().map(|m| m.name.clone()).collect();

    let n_zones = r.u16()?;
    let mut matrix: Option<(u32, u32)> = None;
    let mut zones = Vec::new();
    for _ in 0..n_zones {
        let zname = r.string()?;
        let zkind = r.u32()? as i32;
        let zmin = r.u32()?;
        let zmax = r.u32()?;
        let zleds = r.u32()?;
        zones.push(ZoneInfo { name: zname, kind: zkind, led_count: zleds, min_leds: zmin, max_leds: zmax });
        let m = r.u16()? as usize;
        if m > 0 {
            let h = r.u32()?;
            let w = r.u32()?;
            r.skip(h as usize * w as usize * 4)?;
            matrix = Some((w, h));
        }
        if proto >= 4 {
            for _ in 0..r.u16()? {
                r.string()?;
                r.skip(12)?;
            }
        }
    }

    let led_count = r.u16()? as u32;
    let cols = match (matrix, n_zones) {
        (Some((w, h)), 1) if w * h == led_count => Some(w),
        _ => None,
    };
    Ok(DeviceInfo { index, name, kind, led_count, cols, zones, modes, active_mode, mode_info })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(out: &mut Vec<u8>, v: &str) {
        out.extend_from_slice(&((v.len() + 1) as u16).to_le_bytes());
        out.extend_from_slice(v.as_bytes());
        out.push(0);
    }

    fn device_bytes() -> Vec<u8> {
        let mut b = vec![0, 0, 0, 0];
        b.extend_from_slice(&5u32.to_le_bytes()); // keyboard
        for v in ["Test KB", "Acme", "desc", "1.0", "serial", "loc"] {
            s(&mut b, v);
        }
        b.extend_from_slice(&1u16.to_le_bytes()); // one mode
        b.extend_from_slice(&0u32.to_le_bytes());
        s(&mut b, "Direct");
        b.extend(std::iter::repeat(0).take(16 + 8 + 8 + 4 + 4 + 8));
        b.extend_from_slice(&0u16.to_le_bytes()); // no mode colors
        b.extend_from_slice(&1u16.to_le_bytes()); // one zone
        s(&mut b, "Keys");
        b.extend(std::iter::repeat(0).take(16));
        b.extend_from_slice(&1u16.to_le_bytes()); // matrix present
        b.extend_from_slice(&2u32.to_le_bytes()); // h
        b.extend_from_slice(&3u32.to_le_bytes()); // w
        b.extend(std::iter::repeat(0).take(24));
        b.extend_from_slice(&0u16.to_le_bytes()); // no segments
        b.extend_from_slice(&6u16.to_le_bytes()); // 6 leds
        b
    }

    #[test]
    fn mode_survives_a_round_trip() {
        let m = ModeInfo {
            name: "Rainbow Wave".into(),
            value: 3,
            flags: MODE_FLAG_HAS_SPEED | MODE_FLAG_HAS_BRIGHTNESS,
            speed_min: 10,
            speed_max: 1,
            brightness_min: 0,
            brightness_max: 100,
            colors_min: 1,
            colors_max: 4,
            speed: 5,
            brightness: 80,
            direction: 2,
            color_mode: COLOR_MODE_MODE_SPECIFIC,
            colors: vec![[1, 2, 3], [250, 251, 252]],
        };
        let bytes = encode_mode(&m, 4);
        let mut r = Reader { b: &bytes, p: 0 };
        assert_eq!(r.mode(4).unwrap(), m);
        assert_eq!(r.p, bytes.len());
        assert_eq!(lerp(10, 1, 0.0), 10);
        assert_eq!(lerp(10, 1, 1.0), 1);
    }

    #[test]
    fn parses_v4_device() {
        let d = parse_device(0, &device_bytes(), 4).unwrap();
        assert_eq!((d.name.as_str(), d.kind, d.led_count, d.cols), ("Test KB", 5, 6, Some(3)));
    }

    /// Runs the client against a scripted fake server and checks the bytes it puts on the wire.
    #[test]
    fn talks_to_a_fake_server() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut read = |sock: &mut TcpStream| {
                let mut h = [0u8; 16];
                sock.read_exact(&mut h).unwrap();
                let id = u32::from_le_bytes(h[8..12].try_into().unwrap());
                let mut body = vec![0u8; u32::from_le_bytes(h[12..16].try_into().unwrap()) as usize];
                sock.read_exact(&mut body).unwrap();
                (id, body)
            };
            let reply = |sock: &mut TcpStream, id: u32, body: &[u8]| {
                let mut p = b"ORGB".to_vec();
                p.extend_from_slice(&0u32.to_le_bytes());
                p.extend_from_slice(&id.to_le_bytes());
                p.extend_from_slice(&(body.len() as u32).to_le_bytes());
                p.extend_from_slice(body);
                sock.write_all(&p).unwrap();
            };
            let (id, body) = read(&mut sock);
            assert_eq!((id, body), (REQUEST_PROTOCOL_VERSION, 4u32.to_le_bytes().to_vec()));
            reply(&mut sock, id, &5u32.to_le_bytes()); // server newer than us
            let (id, body) = read(&mut sock);
            assert_eq!((id, body.as_slice()), (SET_CLIENT_NAME, &b"Lights Fan Action\0"[..]));
            let (id, _) = read(&mut sock);
            assert_eq!(id, REQUEST_CONTROLLER_COUNT);
            reply(&mut sock, id, &1u32.to_le_bytes());
            let (id, body) = read(&mut sock);
            assert_eq!((id, body), (REQUEST_CONTROLLER_DATA, 4u32.to_le_bytes().to_vec()));
            reply(&mut sock, 100, &[]); // unrelated notification must be skipped
            reply(&mut sock, id, &device_bytes());
            for _ in 0..2 {
                seen.push(read(&mut sock));
            }
            seen
        });

        let mut c = Client::connect(&addr).unwrap();
        assert_eq!(c.proto, 4);
        let devs = c.devices().unwrap();
        assert_eq!((devs.len(), devs[0].led_count), (1, 6));
        c.set_leds(0, &[1, 2, 3, 4, 5, 6]).unwrap();

        let seen = server.join().unwrap();
        assert_eq!(seen[0].0, SET_CUSTOM_MODE);
        assert_eq!(seen[1].0, UPDATE_LEDS);
        let mut want = 14u32.to_le_bytes().to_vec();
        want.extend_from_slice(&2u16.to_le_bytes());
        want.extend_from_slice(&[1, 2, 3, 0, 4, 5, 6, 0]);
        assert_eq!(seen[1].1, want);
    }
}
