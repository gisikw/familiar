use familiar_viewer::graphics::KittyAction;
use familiar_viewer::terminal::ghostty::GhosttyTerminal;
use familiar_viewer::terminal::{for_every_split, GridSize, TerminalCore};

const SIZE: GridSize = GridSize {
    columns: 10,
    rows: 5,
};
const RAW: &[u8] = b"\x1b_Ga=T,f=24,s=1,v=1,i=42,p=2,c=1,r=1,q=2;/wAA\x1b\\";

fn assert_image(updates: &[familiar_viewer::terminal::TerminalUpdate]) {
    let events = updates.iter().flat_map(|u| &u.graphics).collect::<Vec<_>>();
    let image = events
        .iter()
        .rev()
        .find(|e| e.action == KittyAction::TransmitAndDisplay)
        .expect("libghostty-vt snapshot did not expose the Kitty placement");
    assert_eq!(image.image_id, Some(42));
    assert_eq!(image.placement_id, Some(2));
    assert_eq!(image.payload, [255, 0, 0]);
}

#[test]
fn raw_kitty_image_survives_every_split() {
    for_every_split(
        RAW,
        || GhosttyTerminal::new(SIZE).unwrap(),
        |_, _, updates| assert_image(updates),
    );
}

#[test]
fn chunked_transmission_is_completed_before_placement() {
    let fixture = b"\x1b_Ga=t,f=24,s=2,v=1,i=43,m=1,q=2;/wAA\x1b\\\x1b_Gm=0;AP8A\x1b\\\x1b_Ga=p,i=43,p=4,c=2,r=1,q=2;\x1b\\";
    for_every_split(
        fixture,
        || GhosttyTerminal::new(SIZE).unwrap(),
        |_, _, updates| {
            let image = updates
                .iter()
                .flat_map(|u| &u.graphics)
                .rev()
                .find(|e| e.action == KittyAction::TransmitAndDisplay)
                .unwrap();
            assert_eq!(image.image_id, Some(43));
            assert_eq!(image.payload, [255, 0, 0, 0, 255, 0]);
        },
    );
}

#[test]
fn unicode_placeholder_virtual_placement_is_extracted() {
    // One magenta RGBA pixel, transmitted as a virtual 1x1 placement, followed
    // by kitten's placeholder encoding: image id in foreground RGB and row/col
    // zero as the first Kitty diacritic (U+0305).
    let fixture = concat!(
        "\x1b_Ga=T,f=32,s=1,v=1,i=42,U=1,c=1,r=1,q=2;/wD//w==\x1b\\",
        "\x1b[38;2;0;0;42m\u{10eeee}\u{0305}\u{0305}\x1b[39m"
    );
    let mut terminal = GhosttyTerminal::new(SIZE).unwrap();
    let update = terminal.feed(fixture.as_bytes()).unwrap();
    let image = update
        .graphics
        .iter()
        .find(|event| event.action == KittyAction::TransmitAndDisplay)
        .expect("virtual placeholder placement was not surfaced");
    assert_eq!(image.image_id, Some(42));
    assert_eq!((image.column, image.row), (0, 0));
    assert_eq!((image.columns, image.rows), (Some(1), Some(1)));
    assert_eq!((image.source_width, image.source_height), (1, 1));
    assert_eq!(image.payload, [255, 0, 255, 255]);
    assert_eq!(terminal.cell(0, 0).unwrap().text, "");
}

#[test]
fn rectangular_unicode_placeholder_grid_is_one_placement() {
    let mut fixture = b"\x1b_Ga=T,f=24,s=64,v=32,i=42,U=1,c=4,r=2,q=2;".to_vec();
    fixture.extend_from_slice(
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            vec![0xff; 64 * 32 * 3],
        )
        .as_bytes(),
    );
    fixture.extend_from_slice(b"\x1b\\\x1b[2;3H\x1b[38;2;0;0;42m");
    fixture.extend_from_slice("\u{10eeee}\u{0305}\u{0305}\u{10eeee}\u{0305}\u{030d}\u{10eeee}\u{0305}\u{030e}\u{10eeee}\u{0305}\u{0310}".as_bytes());
    fixture.extend_from_slice(b"\x1b[3;3H");
    fixture.extend_from_slice("\u{10eeee}\u{030d}\u{0305}\u{10eeee}\u{030d}\u{030d}\u{10eeee}\u{030d}\u{030e}\u{10eeee}\u{030d}\u{0310}\x1b[39m".as_bytes());

    let mut terminal = GhosttyTerminal::new(SIZE).unwrap();
    let update = terminal.feed(&fixture).unwrap();
    let placements = update
        .graphics
        .iter()
        .filter(|event| event.action == KittyAction::TransmitAndDisplay)
        .collect::<Vec<_>>();
    assert_eq!(placements.len(), 1);
    let image = placements[0];
    assert_eq!((image.column, image.row), (2, 1));
    assert_eq!((image.columns, image.rows), (Some(4), Some(2)));
    assert_eq!((image.source_x, image.source_y), (0, 0));
    assert_eq!((image.source_width, image.source_height), (64, 32));
}

#[test]
fn sparse_unicode_placeholder_grid_is_consolidated_by_row_runs() {
    let mut fixture = b"\x1b_Ga=T,f=32,s=4,v=2,i=42,U=1,c=4,r=2,q=2;".to_vec();
    fixture.extend_from_slice(
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            vec![0xff; 4 * 2 * 4],
        )
        .as_bytes(),
    );
    fixture.extend_from_slice(b"\x1b\\\x1b[38;2;0;0;42m");
    fixture.extend_from_slice(
        "\u{10eeee}\u{0305}\u{0305}\u{10eeee}\u{0305}\u{030d} X\x1b[2;1H\u{10eeee}\u{030d}\u{0305}\x1b[39m"
            .as_bytes(),
    );
    let mut terminal = GhosttyTerminal::new(SIZE).unwrap();
    let update = terminal.feed(&fixture).unwrap();
    let placements = update
        .graphics
        .iter()
        .filter(|event| event.action == KittyAction::TransmitAndDisplay)
        .collect::<Vec<_>>();
    assert_eq!(placements.len(), 2, "{placements:?}");
    assert_eq!(
        (placements[0].columns, placements[0].rows),
        (Some(2), Some(1))
    );
    assert_eq!(
        (placements[1].columns, placements[1].rows),
        (Some(1), Some(1))
    );
}

#[test]
fn kitty_capability_query_is_answered_across_every_split() {
    let query = b"\x1b_Ga=q,f=24,s=1,v=1,i=77;AAAA\x1b\\";
    for_every_split(
        query,
        || GhosttyTerminal::new(SIZE).unwrap(),
        |_, _, updates| {
            let replies = updates
                .iter()
                .flat_map(|update| &update.replies)
                .collect::<Vec<_>>();
            assert_eq!(replies, [b"\x1b_Gi=77;OK\x1b\\"]);
        },
    );
}

#[test]
fn tmux_wrapped_kitty_query_is_answered() {
    let mut wrapped = b"\x1bPtmux;".to_vec();
    for byte in b"\x1b_Ga=q,f=24,s=1,v=1,i=78;AAAA\x1b\\" {
        if *byte == 0x1b {
            wrapped.push(0x1b);
        }
        wrapped.push(*byte);
    }
    wrapped.extend_from_slice(b"\x1b\\");
    let mut terminal = GhosttyTerminal::new(SIZE).unwrap();
    let update = terminal.feed(&wrapped).unwrap();
    assert_eq!(update.replies, [b"\x1b_Gi=78;OK\x1b\\"]);
}

#[test]
fn tmux_dcs_wrapped_kitty_image_is_extracted() {
    let mut wrapped = b"\x1bPtmux;".to_vec();
    for byte in RAW {
        if *byte == 0x1b {
            wrapped.push(0x1b);
        }
        wrapped.push(*byte);
    }
    wrapped.extend_from_slice(b"\x1b\\");
    let mut terminal = GhosttyTerminal::new(SIZE).unwrap();
    let update = terminal.feed(&wrapped).unwrap();
    assert_image(&[update]);
}
