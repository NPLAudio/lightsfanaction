//! Shows the calibration pattern through the streaming path or the older image upload, so the two can be compared.
//! Usage: cargo run --example kraken_pattern -- <stream|image> <seconds>
use std::time::Duration;

use lightsfanaction_lib::kraken::{to_rgb565, Kraken, LcdStream, SIZE};

/// Quadrant colors, a white ring and crosshair, and a red marker at the top, so rotation and mirroring are obvious.
fn pattern() -> Vec<u8> {
    let c = SIZE as f32 / 2.0;
    let mut px = vec![0u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
            let r = (dx * dx + dy * dy).sqrt();
            let mut col = match (dx >= 0.0, dy >= 0.0) {
                (false, false) => (40, 60, 160),
                (true, false) => (30, 130, 70),
                (false, true) => (150, 110, 20),
                (true, true) => (110, 40, 130),
            };
            if (r - (c - 4.0)).abs() < 4.0 { col = (255, 255, 255) }
            if (dx.abs() < 2.0 || dy.abs() < 2.0) && r < c - 4.0 { col = (255, 255, 255) }
            if dy < 0.0 && dy > -90.0 && dx.abs() < 30.0 - (-dy / 3.0) && r < c - 10.0 { col = (255, 0, 0) }
            let i = (y * SIZE + x) * 4;
            px[i] = col.0; px[i + 1] = col.1; px[i + 2] = col.2;
        }
    }
    px
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let how = a.get(1).map(String::as_str).unwrap_or("stream");
    let secs: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    let img = pattern();
    if how == "image" {
        Kraken::open().expect("open").show_image(&img).expect("upload");
        std::thread::sleep(Duration::from_secs(secs));
        let _ = Kraken::open().and_then(|k| k.show_liquid());
    } else {
        let mut s = LcdStream::open().expect("open the stream");
        let pix = to_rgb565(&img);
        s.frame(&pix).expect("frame");
        std::thread::sleep(Duration::from_secs(secs));
        let _ = s.finish();
    }
    println!("{how}: shown for {secs} s");
}
