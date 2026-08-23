//! Thin boundary over the future FFI-backed libghostty-vt engine.
//!
//! Implementations must accept arbitrary byte chunks. Parsing, buffering and
//! mode tracking live behind this trait; callers consume grid damage, replies
//! destined for the child PTY, and semantic Kitty events.

use crate::graphics::KittyGraphicsEvent;

mod ffi;
pub mod ghostty;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GridSize {
    pub columns: u16,
    pub rows: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DirtyRegion {
    pub column: u16,
    pub row: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CellAttributes {
    pub bold: bool,
    pub italic: bool,
    pub underlined: bool,
    pub inverse: bool,
}

/// A renderer-oriented cell view. An FFI adapter may copy only requested cells
/// across the boundary after `feed` reports damage.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminalCell {
    pub text: String,
    pub attributes: CellAttributes,
    pub foreground_rgb: Option<[u8; 3]>,
    pub background_rgb: Option<[u8; 3]>,
    pub width: u8,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CursorState {
    pub column: u16,
    pub row: u16,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalModes {
    pub mouse_tracking: MouseTracking,
    pub mouse_encoding: MouseEncoding,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub focus_reporting: bool,
    pub alternate_screen: bool,
    pub synchronized_output: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MouseTracking {
    #[default]
    None,
    X10,
    ButtonEvent,
    AnyEvent,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MouseEncoding {
    #[default]
    X10,
    Utf8,
    Sgr,
    SgrPixels,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminalUpdate {
    pub dirty: Vec<DirtyRegion>,
    /// Bytes such as DA/DSR responses that must be written back to the child.
    pub replies: Vec<Vec<u8>>,
    pub graphics: Vec<KittyGraphicsEvent>,
}

pub trait TerminalCore {
    type Error;

    fn feed(&mut self, bytes: &[u8]) -> Result<TerminalUpdate, Self::Error>;
    fn resize(&mut self, size: GridSize) -> Result<TerminalUpdate, Self::Error>;
    fn grid_size(&self) -> GridSize;
    fn cell(&self, column: u16, row: u16) -> Option<TerminalCell>;
    fn cursor(&self) -> Option<CursorState> {
        None
    }
    fn modes(&self) -> TerminalModes;
}

/// Runs a fixture once for every possible two-chunk split, including empty
/// leading/trailing chunks. This catches adapters that incorrectly assume an
/// escape sequence, UTF-8 scalar, or graphics frame is contained in one read.
pub fn for_every_split<T, F, A>(fixture: &[u8], mut factory: F, mut assert_run: A)
where
    T: TerminalCore,
    F: FnMut() -> T,
    A: FnMut(usize, &T, &[TerminalUpdate]),
    T::Error: std::fmt::Debug,
{
    for split in 0..=fixture.len() {
        let mut terminal = factory();
        let updates = vec![
            terminal.feed(&fixture[..split]).unwrap(),
            terminal.feed(&fixture[split..]).unwrap(),
        ];
        assert_run(split, &terminal, &updates);
    }
}
