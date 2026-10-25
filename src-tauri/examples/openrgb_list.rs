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
    // paint <device> <r> <g> <b>: fill one device with a colour
    let a: Vec<String> = std::env::args().collect();
    if a.get(2).map(String::as_str) == Some("paint") {
        let idx: u32 = a[3].parse().unwrap();
        let col: Vec<u8> = a[4..7].iter().map(|v| v.parse().unwrap()).collect();
        let d = devs.iter().find(|d| d.index == idx).expect("no such device");
        let rgb: Vec<u8> = (0..d.led_count).flat_map(|_| col.clone()).collect();
        c.set_leds(idx, &rgb).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        println!("painted {} ({} leds)", d.name, d.led_count);
    }
}
