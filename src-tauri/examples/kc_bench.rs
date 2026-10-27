use lightsfanaction_lib::via::{find, Via};
use std::time::Instant;

/// Times per-key frames on a Keychron with per-key firmware, then restores its lighting.
fn main() {
    let d = find().expect("find").into_iter().find(|d| d.per_key).expect("no per-key keyboard");
    println!("{} leds={}", d.name, d.led_count);
    let mut k = Via::open(&d.path).expect("open");
    let n = d.led_count as usize;
    let mut worst = 0u128;
    let t0 = Instant::now();
    let frames = 60;
    for f in 0..frames {
        let rgb: Vec<u8> = (0..n)
            .flat_map(|i| {
                let h = ((i as f32 / n as f32) + f as f32 * 0.01).fract();
                let c = (h * 6.0) as usize % 6;
                let x = ((h * 6.0).fract() * 255.0) as u8;
                [[255, x, 0], [255 - x, 255, 0], [0, 255, x], [0, 255 - x, 255], [x, 0, 255], [255, 0, 255 - x]][c]
            })
            .collect();
        let t = Instant::now();
        k.set_leds(&rgb).expect("set_leds");
        worst = worst.max(t.elapsed().as_millis());
    }
    let total = t0.elapsed();
    println!("{frames} frames in {:?}: avg {:.1} ms/frame, worst {} ms", total, total.as_millis() as f64 / frames as f64, worst);
    k.restore();
}
