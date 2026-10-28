use lightsfanaction_lib::openrgb::Client;

/// Starts one of a device's built-in effects. Usage: mode_test <device fragment> <mode> [speed 0-1]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let frag = a[1].to_lowercase();
    let mode = &a[2];
    let speed: Option<f32> = a.get(3).map(|s| s.parse().unwrap());
    let mut c = Client::connect("127.0.0.1:6742").expect("connect");
    let d = c.devices().unwrap().into_iter().find(|d| d.name.to_lowercase().contains(&frag)).expect("no such device");
    println!("{}: modes {:?}", d.name, d.modes);
    for m in d.mode_info.iter().filter(|m| m.name.eq_ignore_ascii_case(mode)) {
        println!("  {} flags={:#x} speed {}..{} colors {}..{} color_mode={} direction={}", m.name, m.flags, m.speed_min, m.speed_max, m.colors_min, m.colors_max, m.color_mode, m.direction);
    }
    c.set_mode(d.index, mode, speed, Some(1.0), &[[255, 0, 80], [0, 120, 255]]).expect("set_mode");
    std::thread::sleep(std::time::Duration::from_millis(500));
    println!("sent: {mode}");
}
