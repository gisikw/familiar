use familiar_viewer::terminal::{
    for_every_split, GridSize, TerminalCell, TerminalCore, TerminalModes, TerminalUpdate,
};
use std::convert::Infallible;

#[derive(Default)]
struct RecordingCore {
    bytes: Vec<u8>,
    feed_lengths: Vec<usize>,
}

impl TerminalCore for RecordingCore {
    type Error = Infallible;

    fn feed(&mut self, bytes: &[u8]) -> Result<TerminalUpdate, Self::Error> {
        self.bytes.extend_from_slice(bytes);
        self.feed_lengths.push(bytes.len());
        Ok(TerminalUpdate::default())
    }

    fn resize(&mut self, _size: GridSize) -> Result<TerminalUpdate, Self::Error> {
        Ok(TerminalUpdate::default())
    }

    fn grid_size(&self) -> GridSize {
        GridSize::default()
    }

    fn cell(&self, _column: u16, _row: u16) -> Option<TerminalCell> {
        None
    }

    fn modes(&self) -> TerminalModes {
        TerminalModes::default()
    }
}

#[test]
fn fixture_survives_every_byte_boundary() {
    let fixture = include_bytes!("fixtures/stream.vt");
    for_every_split(
        fixture,
        RecordingCore::default,
        |split, terminal, updates| {
            assert_eq!(terminal.bytes, fixture, "split at byte {split}");
            assert_eq!(terminal.feed_lengths, [split, fixture.len() - split]);
            assert_eq!(updates.len(), 2);
        },
    );
}

#[test]
fn fixture_survives_one_byte_chunks() {
    let fixture = include_bytes!("fixtures/stream.vt");
    let mut terminal = RecordingCore::default();
    for byte in fixture {
        terminal.feed(std::slice::from_ref(byte)).unwrap();
    }
    assert_eq!(terminal.bytes, fixture);
    assert!(terminal.feed_lengths.iter().all(|length| *length == 1));
}
