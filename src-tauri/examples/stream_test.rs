use lightsfanaction_lib::openrgb::Client;
use std::time::{Duration, Instant};

/// Sends rainbow frames to every device the way the app does, and measures how far behind the server is.
/// Usage: stream_test <seconds> <device fps> <kraken fps>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let secs: u64 = a[1].parse().unwrap();
    let fps: u64 = a[2].parse().unwrap();
    let kfps: u64 = a[3].parse().unwrap();
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let devs = c.devices().unwrap();
    println!("{} devices; streaming {fps} fps ({kfps} fps to the Kraken) for {secs}s", devs.len());
    let end = Instant::now() + Duration::from_secs(secs);
    let mut last_send: Vec<Instant> = devs.iter().map(|_| Instant::now() - Duration::from_secs(5)).collect();
    let mut last_ping = Instant::now();
    let t0 = Instant::now();
    while Instant::now() < end {
        let t = t0.elapsed().as_secs_f32();
        for (k, d) in devs.iter().enumerate() {
            let rate = if d.name.to_lowercase().contains("kraken") { kfps } else { fps };
            if rate == 0 || last_send[k].elapsed() < Duration::from_millis(1000 / rate) {
                continue;
            }
            last_send[k] = Instant::now();
            let rgb: Vec<u8> = (0..d.led_count)
                .flat_map(|i| {
                    let h = (i as f32 / d.led_count as f32 + t * 0.3).fract() * 6.0;
                    let x = ((h.fract()) * 255.0) as u8;
                    match h as u32 { 0 => [255, x, 0], 1 => [255 - x, 255, 0], 2 => [0, 255, x], 3 => [0, 255 - x, 255], 4 => [x, 0, 255], _ => [255, 0, 255 - x] }
                })
                .collect();
            c.set_leds(d.index, &rgb).unwrap();
        }
        if last_ping.elapsed() > Duration::from_secs(3) {
            last_ping = Instant::now();
            println!("t={:>4.0}s server round trip: {:?}", t, c.ping().unwrap());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
