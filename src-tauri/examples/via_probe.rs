use hidapi::HidApi;

/// Read-only probe of a keyboard's VIA raw-HID interface (usage page 0xFF60, usage 0x61).
fn main() {
    let (vid, pid) = (0x3434u16, std::env::args().nth(1).map(|s| u16::from_str_radix(&s, 16).unwrap()).unwrap_or(0x0160));
    let api = HidApi::new().unwrap();
    for d in api.device_list().filter(|d| d.vendor_id() == vid && d.product_id() == pid) {
        println!("iface={} usage_page={:#06x} usage={:#04x} product={:?}", d.interface_number(), d.usage_page(), d.usage(), d.product_string());
    }
    let info = api.device_list().find(|d| d.vendor_id() == vid && d.product_id() == pid && d.usage_page() == 0xFF60 && d.usage() == 0x61);
    let Some(info) = info else { println!("no VIA interface"); return };
    let dev = info.open_device(&api).expect("open");
    let ask = |cmd: &[u8]| {
        let mut out = [0u8; 33];
        out[1..1 + cmd.len()].copy_from_slice(cmd);
        dev.write(&out).expect("write");
        let mut r = [0u8; 32];
        let n = dev.read_timeout(&mut r, 500).expect("read");
        (n, r)
    };
    let (n, r) = ask(&[0x01]);
    println!("protocol version: n={n} {:02x?}", &r[..4]);
    for (name, ch, id) in [("brightness", 3u8, 1u8), ("effect", 3, 2), ("speed", 3, 3), ("color h,s", 3, 4)] {
        let (n, r) = ask(&[0x08, ch, id]);
        println!("rgb_matrix {name}: n={n} {:02x?}", &r[..6]);
    }
}
