use lightsfanaction_lib::openrgb::Client;
use std::time::{Duration, Instant};

/// Lights one zone at a time so it is clear which physical lights belong to which zone.
/// Usage: zone_test <device name fragment> <seconds per zone>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let frag = a[1].to_lowercase();
    let secs: u64 = a[2].parse().unwrap();
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let d = c.devices().unwrap().into_iter().find(|d| d.name.to_lowercase().contains(&frag)).expect("no such device");
    println!("{} (index {}), {} LEDs, zones {:?}", d.name, d.index, d.led_count, d.zones.iter().map(|z| (&z.name[..], z.led_count)).collect::<Vec<_>>());
    let colors = [[255u8, 0, 0], [0, 255, 0], [0, 0, 255]];
    let mut start = 0usize;
    for (zi, z) in d.zones.iter().enumerate() {
        let col = colors[zi % colors.len()];
        println!("zone {} ({}): {:?} for {secs}s", zi, z.name, col);
        let rgb: Vec<u8> = (0..d.led_count as usize)
            .flat_map(|i| if i >= start && i < start + z.led_count as usize { col } else { [0, 0, 0] })
            .collect();
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end {
            c.set_leds(d.index, &rgb).unwrap();
            std::thread::sleep(Duration::from_millis(250));
        }
        start += z.led_count as usize;
    }
}
