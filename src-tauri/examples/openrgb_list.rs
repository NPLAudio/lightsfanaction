use lightsfanaction_lib::openrgb::{Client, DeviceInfo};

fn active(d: &DeviceInfo) -> &str {
    d.modes.get(d.active_mode as usize).map(String::as_str).unwrap_or("?")
}

/// Usage: openrgb_list [addr] [paint]. `paint` sets every LED blue, then re-reads the active mode.
fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:6742".into());
    let mut c = Client::connect(&addr).expect("connect");
    let devs = c.devices().expect("devices");
    for d in &devs {
        println!("{:>2}  kind={:<2} leds={:<4} cols={:?}  {}", d.index, d.kind, d.led_count, d.cols, d.name);
        println!("        modes {:?} active={}", d.modes, active(d));
        for z in &d.zones {
            println!("        zone {:?} kind={} leds={} (min {}, max {})", z.name, z.kind, z.led_count, z.min_leds, z.max_leds);
        }
    }
    if std::env::args().nth(2).as_deref() == Some("paint") {
        for d in &devs {
            let rgb: Vec<u8> = (0..d.led_count).flat_map(|_| [0u8, 0, 255]).collect();
            c.set_leds(d.index, &rgb).unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        println!("--- after painting blue");
        for d in c.devices().expect("devices") {
            println!("{:>2} {} active={}", d.index, d.name, active(&d));
        }
    }
}
