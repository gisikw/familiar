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
