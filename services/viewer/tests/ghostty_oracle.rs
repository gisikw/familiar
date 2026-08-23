use base64::Engine as _;
use familiar_viewer::graphics::{
    CellAspect, GraphicsMode, HostGraphics, KittyAction, MARK_IMAGE_ID,
};
use familiar_viewer::terminal::ghostty::GhosttyTerminal;
use familiar_viewer::terminal::{GridSize, TerminalCore};
use ratatui::layout::Rect;

const SIZE: GridSize = GridSize {
    columns: 100,
    rows: 30,
};

fn kitty_transmission(control: &str, data: &[u8]) -> Vec<u8> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let chunks = encoded.as_bytes().chunks(4096).collect::<Vec<_>>();
    let mut bytes = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        if index == 0 {
            bytes.extend_from_slice(
                format!("\x1b_G{control},m={};", u8::from(chunks.len() > 1)).as_bytes(),
            );
        } else {
            bytes.extend_from_slice(
                format!("\x1b_Gm={};", u8::from(index + 1 < chunks.len())).as_bytes(),
            );
        }
        bytes.extend_from_slice(chunk);
        bytes.extend_from_slice(b"\x1b\\");
    }
    bytes
}

fn assert_oracle_image(bytes: &[u8], id: u32, dimensions: (u32, u32)) {
    let mut oracle = GhosttyTerminal::new_with_kitty_apc_limit(SIZE, 4096).unwrap();
    let update = oracle.feed(bytes).unwrap();
    assert!(update.replies.is_empty(), "q=2 must suppress host replies");
    let image = update
        .graphics
        .iter()
        .find(|event| event.action == KittyAction::TransmitAndDisplay && event.image_id == Some(id))
        .expect("Ghostty host oracle did not retain a visible image placement");
    assert_eq!((image.image_width, image.image_height), dimensions);
    assert!(image.columns.unwrap_or(0) > 0);
    assert!(image.rows.unwrap_or(0) > 0);
    assert!(image.source_width > 0);
    assert!(image.source_height > 0);
}

#[test]
fn mark_emission_is_accepted_by_ghostty_host_oracle() {
    let mut mark_png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut mark_png, 2, 3);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0xff; 2 * 3 * 4]).unwrap();
    }
    let mut graphics = HostGraphics::new_with_mark_png(GraphicsMode::Kitty, Some(mark_png));
    let emitted = graphics.emit(
        Rect::new(28, 0, 72, 30),
        Rect::new(0, 1, 28, 8),
        CellAspect::default(),
        true,
    );
    assert!(!emitted.is_empty(), "repository mark PNG was not found");
    assert_oracle_image(&emitted, MARK_IMAGE_ID, (2, 3));
}

#[test]
fn strict_ghostty_oracle_rejects_an_oversized_unchunked_payload() {
    let pixels = vec![0x7f; 64 * 32 * 3];
    let encoded = base64::engine::general_purpose::STANDARD.encode(pixels);
    let bytes = format!("\x1b_Ga=T,f=24,s=64,v=32,i=9,c=4,r=2,q=2;{encoded}\x1b\\");
    let mut oracle = GhosttyTerminal::new_with_kitty_apc_limit(SIZE, 4096).unwrap();
    let update = oracle.feed(bytes.as_bytes()).unwrap();
    assert!(
        !update
            .graphics
            .iter()
            .any(|event| event.action == KittyAction::TransmitAndDisplay),
        "strict Ghostty unexpectedly retained an oversized Kitty command"
    );
}

#[test]
fn virtual_child_image_round_trips_through_host_emission_and_ghostty_oracle() {
    // Batch-D-shaped fixture: a virtual RGB image followed by one Unicode
    // placeholder. Its payload is intentionally large enough that the host
    // re-transmission must contain continuation APCs.
    let dimensions = (64, 32);
    let pixels = (0..dimensions.0 * dimensions.1)
        .flat_map(|index| {
            let value = index as u8;
            [value, value.wrapping_mul(3), value.wrapping_mul(7)]
        })
        .collect::<Vec<_>>();
    let mut child_stream = kitty_transmission("a=T,f=24,s=64,v=32,i=42,U=1,c=4,r=2,q=2", &pixels);
    child_stream.extend_from_slice(
        "\x1b[3;5H\x1b[38;2;0;0;42m\u{10eeee}\u{0305}\u{0305}\x1b[39m".as_bytes(),
    );

    let mut child = GhosttyTerminal::new(SIZE).unwrap();
    let child_update = child.feed(&child_stream).unwrap();
    let child_image = child_update
        .graphics
        .iter()
        .find(|event| event.action == KittyAction::TransmitAndDisplay)
        .expect("embedded-child Ghostty did not extract the virtual placement");
    assert_eq!(
        (child_image.image_width, child_image.image_height),
        dimensions
    );
    assert_eq!(child_image.payload, pixels);

    let mut graphics = HostGraphics::new(GraphicsMode::Kitty);
    graphics.handle_events(child_update.graphics);
    let emitted = graphics.emit(
        Rect::new(28, 0, 72, 30),
        Rect::default(),
        CellAspect::default(),
        false,
    );
    let apcs = emitted
        .split(|byte| *byte == 0x1b)
        .filter(|part| part.starts_with(b"_G"))
        .collect::<Vec<_>>();
    assert!(apcs.len() >= 3, "large image was not emitted in chunks");
    assert!(emitted.windows(4).any(|window| window == b",m=1"));
    assert_oracle_image(&emitted, 1_000_000, dimensions);
}
