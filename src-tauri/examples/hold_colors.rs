use lightsfanaction_lib::openrgb::Client;
use std::time::{Duration, Instant};

/// Holds solid colours on devices by resending them 10x a second for N seconds.
/// Usage: hold_colors <seconds> <device:r,g,b>...
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let secs: u64 = a[1].parse().unwrap();
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let devs = c.devices().expect("devices");
    let jobs: Vec<(u32, Vec<u8>)> = a[2..]
        .iter()
        .map(|s| {
            let (i, rgb) = s.split_once(':').unwrap();
            let col: Vec<u8> = rgb.split(',').map(|v| v.parse().unwrap()).collect();
            let idx: u32 = i.parse().unwrap();
            let d = devs.iter().find(|d| d.index == idx).unwrap();
            (idx, (0..d.led_count).flat_map(|_| col.clone()).collect())
        })
        .collect();
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        for (i, rgb) in &jobs {
            c.set_leds(*i, rgb).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
