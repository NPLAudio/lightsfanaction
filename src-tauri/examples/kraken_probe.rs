use lightsfanaction_lib::kraken::{Kraken, SIZE};

/// Calibration pattern for a round screen: quadrant colours, a circle at the edge, a crosshair,
/// and a red marker at the top so rotation and offset are obvious.
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
            if (r - c / 2.0).abs() < 2.0 { col = (255, 255, 255) }
            if (dx.abs() < 2.0 || dy.abs() < 2.0) && r < c - 4.0 { col = (255, 255, 255) }
            if dy < 0.0 && dy > -90.0 && dx.abs() < 30.0 - (-dy / 3.0) && r < c - 10.0 { col = (255, 0, 0) }
            let i = (y * SIZE + x) * 4;
            px[i] = col.0; px[i + 1] = col.1; px[i + 2] = col.2;
        }
    }
    px
}

fn main() {
    let k = Kraken::open().expect("open");
    println!("{:?}", k.info().expect("info"));
    match std::env::args().nth(1).as_deref() {
        Some("image") => { k.show_image(&pattern()).expect("show_image"); println!("uploaded"); }
        Some("liquid") => k.show_liquid().expect("liquid"),
        _ => {}
    }
}
