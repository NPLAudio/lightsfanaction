//! Streams a rotating rainbow straight to the Kraken's lights and reports how fast the cooler takes it.
//! Usage: cargo run --example kraken_lights -- <ring|both|fans> <frames per second> <seconds>
use std::time::{Duration, Instant};

use lightsfanaction_lib::kraken::{Kraken, FAN_LEDS, RING_LEDS};

fn hsv(h: f32) -> [u8; 3] {
    let h = (h - h.floor()) * 6.0;
    let (i, f) = (h.floor() as u32, h - h.floor());
    let (q, t) = (1.0 - f, f);
    let (r, g, b) = match i % 6 { 0 => (1.0, t, 0.0), 1 => (q, 1.0, 0.0), 2 => (0.0, 1.0, t), 3 => (0.0, q, 1.0), 4 => (t, 0.0, 1.0), _ => (1.0, 0.0, q) };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let what = args.get(1).map(String::as_str).unwrap_or("ring");
    let fps: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20.0);
    let secs: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6.0);
    let k = Kraken::open().expect("open the Kraken");

    let started = Instant::now();
    let period = Duration::from_secs_f32(1.0 / fps);
    let (mut frames, mut slowest) = (0u32, Duration::ZERO);
    while started.elapsed().as_secs_f32() < secs {
        let frame_start = Instant::now();
        let t = started.elapsed().as_secs_f32();
        // one full turn every 4 seconds
        let ring: Vec<[u8; 3]> = (0..RING_LEDS).map(|i| hsv(i as f32 / RING_LEDS as f32 - t * 0.25)).collect();
        let fans: Vec<[u8; 3]> = (0..FAN_LEDS).map(|i| hsv(i as f32 / FAN_LEDS as f32 - t * 0.25)).collect();
        let result = match what {
            "fans" => k.set_lights(&[], Some(&fans)),
            "both" => k.set_lights(&ring, Some(&fans)),
            _ => k.set_lights(&ring, None),
        };
        if let Err(e) = result {
            eprintln!("write failed: {e}");
            break;
        }
        frames += 1;
        slowest = slowest.max(frame_start.elapsed());
        if let Some(rest) = period.checked_sub(frame_start.elapsed()) {
            std::thread::sleep(rest);
        }
    }
    println!("{what}: {frames} frames in {:.1} s = {:.1} per second, slowest write {:?}", started.elapsed().as_secs_f32(), frames as f32 / started.elapsed().as_secs_f32(), slowest);
}
