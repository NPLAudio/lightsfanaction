//! Streams an animated test pattern to the Kraken's screen and reports the frame rate and where the time goes.
//! Usage: cargo run --example kraken_stream -- <seconds>   (afterwards the built-in liquid screen is restored)
use std::time::Instant;

use lightsfanaction_lib::kraken::{to_rgb565, LcdStream, SIZE};

/// A round dial with a sweeping hand, a moving bar and a color wash, so smoothness and tearing are obvious.
fn frame(t: f32) -> Vec<u8> {
    let c = SIZE as f32 / 2.0;
    let mut px = vec![0u8; SIZE * SIZE * 4];
    let hand = t * 1.5;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
            let r = (dx * dx + dy * dy).sqrt();
            let a = dy.atan2(dx);
            let wash = 0.5 + 0.5 * (a * 2.0 + t).sin();
            let mut col = [(30.0 + 60.0 * wash) as u8, (20.0 + 40.0 * (1.0 - wash)) as u8, (80.0 + 100.0 * wash) as u8];
            if (r - (c - 8.0)).abs() < 5.0 { col = [255, 255, 255] }
            let d = ((a - hand + std::f32::consts::PI * 3.0) % (std::f32::consts::PI * 2.0)) - std::f32::consts::PI;
            if r < c - 30.0 && d.abs() < 0.06 { col = [255, 60, 60] }
            if (y as f32 - (60.0 + 520.0 * (0.5 + 0.5 * (t * 2.0).sin()))).abs() < 4.0 && r < c - 20.0 { col = [60, 255, 120] }
            let i = (y * SIZE + x) * 4;
            px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
        }
    }
    px
}

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10.0);
    let mut s = LcdStream::open().expect("open the Kraken screen");
    let started = Instant::now();
    let (mut frames, mut draw, mut send) = (0u32, 0.0f32, 0.0f32);
    while started.elapsed().as_secs_f32() < secs {
        let t0 = Instant::now();
        let pix = to_rgb565(&frame(started.elapsed().as_secs_f32()));
        let t1 = Instant::now();
        if let Err(e) = s.frame(&pix) {
            eprintln!("frame failed: {e}");
            break;
        }
        draw += (t1 - t0).as_secs_f32();
        send += t1.elapsed().as_secs_f32();
        frames += 1;
    }
    let total = started.elapsed().as_secs_f32();
    println!(
        "{frames} frames in {total:.1} s = {:.1} per second; drawing {:.0} ms/frame, encode and send {:.0} ms/frame",
        frames as f32 / total,
        draw * 1000.0 / frames.max(1) as f32,
        send * 1000.0 / frames.max(1) as f32
    );
    let _ = s.finish();
}
