use lightsfanaction_lib::kraken::{Kraken, SIZE};

fn main() {
    let k = Kraken::open().expect("open");
    println!("{:?}", k.info().expect("info"));
    if std::env::args().nth(1).as_deref() == Some("image") {
        // diagonal gradient with a white border so orientation is obvious
        let mut px = vec![0u8; SIZE * SIZE * 4];
        for y in 0..SIZE {
            for x in 0..SIZE {
                let i = (y * SIZE + x) * 4;
                let edge = x < 8 || y < 8 || x >= SIZE - 8 || y >= SIZE - 8;
                let (r, g, b) = if edge { (255, 255, 255) } else { ((x * 255 / SIZE) as u8, (y * 255 / SIZE) as u8, 160) };
                px[i] = r; px[i + 1] = g; px[i + 2] = b;
            }
        }
        k.show_image(&px).expect("show_image");
        println!("uploaded");
    }
    if std::env::args().nth(1).as_deref() == Some("liquid") {
        k.show_liquid().expect("liquid");
    }
}
