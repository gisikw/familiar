use familiar_viewer::terminal::ghostty::GhosttyTerminal;
use familiar_viewer::terminal::{
    for_every_split, GridSize, MouseEncoding, MouseTracking, TerminalColor, TerminalCore,
};

const SIZE: GridSize = GridSize {
    columns: 24,
    rows: 6,
};

fn terminal(size: GridSize) -> GhosttyTerminal {
    GhosttyTerminal::new(size).unwrap()
}

fn row(core: &GhosttyTerminal, y: u16) -> String {
    (0..core.grid_size().columns)
        .filter_map(|x| core.cell(x, y))
        .map(|cell| cell.text)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[test]
fn every_split_preserves_streaming_parser_state() {
    let fixture = concat!(
        "\x1b[2J\x1b[Hplain",
        "\x1b[2;1H\x1b[1;31mR\x1b[38;5;196mP\x1b[38;2;1;2;3;48;2;4;5;6mT\x1b[0m",
        "\x1b[3;1H界🙂",
        "\x1b]2;split osc title\x07",
        "\x1bP1;2|split-dcs\x1b\\",
        "\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2026h",
        "\x1b[?1049hALT\x1b[?1049l",
        "\x1b[c"
    )
    .as_bytes();

    for_every_split(
        fixture,
        || terminal(SIZE),
        |split, core, updates| {
            assert_eq!(row(core, 0), "plain", "split at {split}");
            assert_eq!(core.cell(0, 2).unwrap().text, "界", "split at {split}");
            assert_eq!(core.cell(0, 2).unwrap().width, 2, "split at {split}");
            assert_eq!(core.cell(1, 2).unwrap().width, 0, "split at {split}");
            assert_eq!(core.cell(2, 2).unwrap().text, "🙂", "split at {split}");

            let red = core.cell(0, 1).unwrap();
            assert!(red.attributes.bold, "split at {split}");
            assert_eq!(
                red.foreground,
                Some(TerminalColor::Indexed(1)),
                "split at {split}"
            );
            assert_eq!(
                core.cell(1, 1).unwrap().foreground,
                Some(TerminalColor::Indexed(196))
            );
            let truecolor = core.cell(2, 1).unwrap();
            assert_eq!(truecolor.foreground, Some(TerminalColor::Rgb(1, 2, 3)));
            assert_eq!(truecolor.background, Some(TerminalColor::Rgb(4, 5, 6)));

            let modes = core.modes();
            assert_eq!(modes.mouse_tracking, MouseTracking::AnyEvent);
            assert_eq!(modes.mouse_encoding, MouseEncoding::Sgr);
            assert!(modes.bracketed_paste);
            assert!(modes.application_cursor);
            assert!(modes.application_keypad);
            assert!(modes.synchronized_output);
            assert!(!modes.alternate_screen);

            let replies = updates
                .iter()
                .flat_map(|update| update.replies.iter())
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            assert!(
                replies.starts_with(b"\x1b[?62;6;22c"),
                "split at {split}: {replies:?}"
            );
        },
    );
}

#[test]
fn truecolor_rgb_foreground_survives_conversion() {
    // Regression: pi styles editor input lines with the theme accent, a
    // TRUECOLOR RGB foreground (familiar.json accent #8ec07c). Earlier those
    // lines rendered grey because the RGB SGR was dropped by the inner tmux
    // before reaching the vendored VT (the viewer now advertises
    // COLORTERM=truecolor to the inner attach, and both tmux policies advertise
    // the RGB terminal-feature). This asserts the viewer's own conversion keeps
    // an RGB fg/bg once the SGR actually arrives, so the fix's other layer
    // (tmux passthrough) is the only remaining variable.
    let mut core = terminal(SIZE);
    core.feed(b"\x1b[38;2;142;192;124;48;2;40;40;40mACCENT\x1b[0m")
        .unwrap();
    let cell = core.cell(0, 0).unwrap();
    assert_eq!(cell.text, "A");
    assert_eq!(cell.foreground, Some(TerminalColor::Rgb(142, 192, 124)));
    assert_eq!(cell.background, Some(TerminalColor::Rgb(40, 40, 40)));
}

#[test]
fn scripted_grid_snapshot_survives_alt_screen_round_trip() {
    let mut core = terminal(GridSize {
        columns: 8,
        rows: 3,
    });
    core.feed(b"one\r\ntwo\r\nthree\r\nfour").unwrap();
    assert_eq!(
        [row(&core, 0), row(&core, 1), row(&core, 2)],
        ["two", "three", "four"]
    );

    core.feed(b"\x1b[?1049h\x1b[2J\x1b[HALT").unwrap();
    assert!(core.modes().alternate_screen);
    assert_eq!(
        [row(&core, 0), row(&core, 1), row(&core, 2)],
        ["ALT", "", ""]
    );

    core.feed(b"\x1b[?1049l").unwrap();
    assert!(!core.modes().alternate_screen);
    assert_eq!(
        [row(&core, 0), row(&core, 1), row(&core, 2)],
        ["two", "three", "four"]
    );
}

#[test]
fn resize_smaller_and_larger_keeps_terminal_live() {
    let mut core = terminal(GridSize {
        columns: 10,
        rows: 4,
    });
    core.feed(b"before").unwrap();
    core.resize(GridSize {
        columns: 5,
        rows: 2,
    })
    .unwrap();
    assert_eq!(
        core.grid_size(),
        GridSize {
            columns: 5,
            rows: 2
        }
    );
    core.feed(b"\r\nafter").unwrap();

    core.resize(GridSize {
        columns: 16,
        rows: 6,
    })
    .unwrap();
    assert_eq!(
        core.grid_size(),
        GridSize {
            columns: 16,
            rows: 6
        }
    );
    core.feed(b"!").unwrap();
    assert!(core.cell(0, 0).is_some());
    assert!(core.cell(15, 5).is_some());
    assert!(core.cell(16, 5).is_none());
}

/// BCE (background color erase): after `ESC[K` with an active SGR background,
/// the erased trailing cells must carry that background so full-line highlights
/// span the entire width. Ghostty stores the erased background in cell content
/// (not the style), which our converter must surface. A control row without EL
/// must stay default past the written text.
#[test]
fn erase_line_propagates_background_color_erase() {
    let mut core = terminal(GridSize {
        columns: 12,
        rows: 2,
    });
    // Row 0: blue bg, write "hi", then EL to end of line with bg still active.
    // Row 1: blue bg, write "hi", reset SGR, no EL -> trailing stays default.
    core.feed(b"\x1b[44mhi\x1b[K\r\n\x1b[44mhi\x1b[0m").unwrap();

    for column in 0..core.grid_size().columns {
        assert_eq!(
            core.cell(column, 0).unwrap().background,
            Some(TerminalColor::Indexed(4)),
            "BCE row must be blue across full width at column {column}"
        );
    }

    assert_eq!(
        core.cell(0, 1).unwrap().background,
        Some(TerminalColor::Indexed(4))
    );
    assert_eq!(
        core.cell(1, 1).unwrap().background,
        Some(TerminalColor::Indexed(4))
    );
    for column in 2..core.grid_size().columns {
        assert_eq!(
            core.cell(column, 1).unwrap().background,
            None,
            "control row without EL must stay default past text at column {column}"
        );
    }
}
