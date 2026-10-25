use lightsfanaction_lib::via::{find, Via};
use std::{thread::sleep, time::Duration};

/// Flashes red, green, blue on every VIA keyboard, then restores its own lighting.
fn main() {
    for d in find().expect("find") {
        println!("{} ({})", d.name, d.path);
        let mut k = Via::open(&d.path).expect("open");
        for (r, g, b) in [(255, 0, 0), (0, 255, 0), (0, 0, 255)] {
            k.set_color(r, g, b).expect("set");
            sleep(Duration::from_secs(2));
        }
        k.restore();
        println!("restored");
    }
}
