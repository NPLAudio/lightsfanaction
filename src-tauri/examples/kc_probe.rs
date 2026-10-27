use hidapi::HidApi;

/// Read-only probe of Keychron's raw-HID extensions (command groups 0xA0..0xA8).
fn main() {
    let api = HidApi::new().unwrap();
    let info = api
        .device_list()
        .find(|d| d.vendor_id() == 0x3434 && d.usage_page() == 0xFF60 && d.usage() == 0x61)
        .expect("no VIA interface");
    println!("{:?}", info.product_string());
    let dev = info.open_device(&api).unwrap();
    let ask = |cmd: &[u8]| {
        let mut out = [0u8; 33];
        out[1..1 + cmd.len()].copy_from_slice(cmd);
        dev.write(&out).unwrap();
        let mut r = [0u8; 32];
        dev.read_timeout(&mut r, 500).unwrap();
        r
    };
    let r = ask(&[0xA0]);
    println!("protocol (0xA0): {:02x?}", &r[..6]);
    let r = ask(&[0xA1]);
    println!("firmware (0xA1): {:?}", String::from_utf8_lossy(&r[1..30]));
    let r = ask(&[0xA2]);
    println!("features (0xA2): {:02x?}  (byte1 bit7 = keychron rgb)", &r[..6]);
    let r = ask(&[0xA8, 0x01]);
    println!("rgb version (0xA8 01): {:02x?}", &r[..6]);
    let r = ask(&[0xA8, 0x05]);
    println!("rgb led count (0xA8 05): {:02x?}", &r[..6]);
}
