use lightsfanaction_lib::openrgb::Client;
use std::time::{Duration, Instant};

/// Drives only the first Kraken channel (the ring) through three patterns, ten seconds each, so it is
/// clear which kinds of update the ring follows.
/// A: solid colour that changes every second. B: moving rainbow at 4 fps. C: moving rainbow at 1 fps.
fn main() {
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let d = c.devices().unwrap().into_iter().find(|d| d.name.to_lowercase().contains("kraken")).expect("no kraken");
    let ring = d.zones[0].led_count as usize;
    let total = d.led_count as usize;
    let hue = |h: f32| -> [u8; 3] {
        let h = h.fract() * 6.0;
        let x = (h.fract() * 255.0) as u8;
        match h as u32 { 0 => [255, x, 0], 1 => [255 - x, 255, 0], 2 => [0, 255, x], 3 => [0, 255 - x, 255], 4 => [x, 0, 255], _ => [255, 0, 255 - x] }
    };
    let frame = |f: &dyn Fn(usize) -> [u8; 3]| -> Vec<u8> { (0..total).flat_map(|i| if i < ring { f(i) } else { [0, 0, 0] }).collect() };
    let phases: [(&str, u64); 3] = [("A: solid colour changing every second, 4 fps", 4), ("B: moving rainbow, 4 fps", 4), ("C: moving rainbow, 1 fps", 1)];
    for (pi, (name, fps)) in phases.iter().enumerate() {
        println!("{name} (10 s)");
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            let t = start.elapsed().as_secs_f32();
            let rgb = match pi {
                0 => { let col = [[255u8, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]][(t as usize) % 4]; frame(&|_| col) }
                _ => frame(&|i| hue(i as f32 / ring as f32 + t * 0.3)),
            };
            c.set_leds(d.index, &rgb).unwrap();
            std::thread::sleep(Duration::from_millis(1000 / fps));
        }
    }
}
