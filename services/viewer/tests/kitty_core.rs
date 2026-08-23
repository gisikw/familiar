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
