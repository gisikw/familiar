//! Regression: real `kitten icat` streams (captured under a graphics-capable
//! host and a silent host) must both produce child image emission after the
//! embedded core decode + host translation.
//!
//! The `icat-pty-ghostty.raw` fixture is a classic direct placement (`a=T`
//! with `s=`/`v=` pixels, no `c=`/`r=` grid) — the shape icat sends when the
//! host answered its capability probe. Before the cell-pixel priming fix this
//! collapsed to a 0x0 grid and emitted nothing.
use familiar_viewer::graphics::{CellAspect, GraphicsMode, HostGraphics};
use familiar_viewer::terminal::ghostty::GhosttyTerminal;
use familiar_viewer::terminal::{GridSize, TerminalCore};
use ratatui::layout::Rect;

/// Unwrap tmux passthrough DCS blocks (`\x1bPtmux;<doubled-esc payload>\x1b\\`).
fn unwrap_tmux(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"\x1bPtmux;") {
            i += b"\x1bPtmux;".len();
            // Payload runs until a single (undoubled) ST `\x1b\\`.
            while i < bytes.len() {
                if bytes[i] == 0x1b {
                    if bytes.get(i + 1) == Some(&0x1b) {
                        // doubled ESC -> literal ESC
                        out.push(0x1b);
                        i += 2;
                        continue;
                    }
                    if bytes.get(i + 1) == Some(&b'\\') {
                        // terminating ST of the passthrough block
                        i += 2;
                        break;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Feed a captured `kitten icat` stream (tmux passthrough form) through the
/// real embedded-core decode + host emission path and return the number of
/// child image placements the viewer would write to the host terminal.
fn child_placements_for(fixture: &str) -> usize {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/{fixture}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let stream = unwrap_tmux(&raw);
    let size = GridSize {
        columns: 100,
        rows: 30,
    };
    let mut core = GhosttyTerminal::new(size).unwrap();
    let update = core.feed(&stream).unwrap();
    let mut g = HostGraphics::new(GraphicsMode::Kitty);
    g.handle_events(update.graphics);
    let emitted = g.emit(
        Rect::new(28, 0, 72, 30),
        Rect::default(),
        CellAspect::default(),
        false,
    );
    String::from_utf8_lossy(&emitted)
        .matches("a=p,i=1000000")
        .count()
}

// The restty (silent host) case uses U=1 unicode-placeholder placements and
// always emitted; the ghostty (graphics-capable host) case is a classic direct
// placement with no c=/r= grid, which regressed to zero emission before the
// cell-pixel priming fix. Both must emit at least one child placement now.

#[test]
fn ghostty_flavored_classic_placement_emits_child_image() {
    assert!(
        child_placements_for("icat-pty-ghostty.raw") >= 1,
        "graphics-capable host (classic placement) produced no child emission"
    );
}

#[test]
fn restty_flavored_virtual_placement_emits_child_image() {
    assert!(
        child_placements_for("icat-pty-restty.raw") >= 1,
        "silent host (virtual placeholder) produced no child emission"
    );
}
