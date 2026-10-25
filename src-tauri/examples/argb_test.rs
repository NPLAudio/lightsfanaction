use lightsfanaction_lib::openrgb::Client;
use std::time::{Duration, Instant};

/// Sizes the motherboard's addressable headers, then holds a colour on them.
/// Usage: argb_test <device> <leds per header> <seconds> <r,g,b>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dev: u32 = a[1].parse().unwrap();
    let n: u32 = a[2].parse().unwrap();
    let secs: u64 = a[3].parse().unwrap();
    let col: Vec<u8> = a[4].split(',').map(|v| v.parse().unwrap()).collect();
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let d = c.devices().unwrap().into_iter().find(|d| d.index == dev).unwrap();
    for (zi, z) in d.zones.iter().enumerate() {
        if z.max_leds > z.min_leds {
            c.resize_zone(dev, zi as u32, n.min(z.max_leds)).unwrap();
        }
    }
    std::thread::sleep(Duration::from_millis(500));
    let d = c.devices().unwrap().into_iter().find(|d| d.index == dev).unwrap();
    println!("{}: {} leds, zones {:?}", d.name, d.led_count, d.zones.iter().map(|z| (&z.name[..], z.led_count)).collect::<Vec<_>>());
    let rgb: Vec<u8> = (0..d.led_count).flat_map(|_| col.clone()).collect();
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        c.set_leds(dev, &rgb).unwrap();
        std::thread::sleep(Duration::from_millis(100));
    }
}
