use lightsfanaction_lib::openrgb::Client;

fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:6742".into());
    let mut c = Client::connect(&addr).expect("connect");
    for d in c.devices().expect("devices") {
        println!("{:>2}  kind={:<2} leds={:<4} cols={:?}  {}", d.index, d.kind, d.led_count, d.cols, d.name);
        for z in &d.zones {
            println!("        zone {:?} kind={} leds={}", z.name, z.kind, z.led_count);
        }
    }
}
