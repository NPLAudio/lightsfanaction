//! Streams a raw 640x640 RGBA file (as produced by the app's canvas) to the screen, then restores the liquid screen.
//! Usage: cargo run --example kraken_file -- <path> <seconds>
use std::time::Duration;

use lightsfanaction_lib::kraken::{to_rgb565, LcdStream};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).expect("read the frame file");
    let secs: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    let mut s = LcdStream::open().expect("open the stream");
    s.frame(&to_rgb565(&bytes)).expect("frame");
    std::thread::sleep(Duration::from_secs(secs));
    let _ = s.finish();
    println!("shown {} bytes for {secs} s", bytes.len());
}
