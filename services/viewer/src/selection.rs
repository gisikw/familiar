//! Host-side text selection for the child pane.
//!
//! The viewer runs inside a host terminal with mouse capture enabled, so the
//! host emulator's native click-drag selection is suppressed. When the child
//! application has *not* requested mouse tracking, the viewer reconstructs the
//! familiar "drag to select, release to copy" gesture itself and copies the
//! finalized selection to the system clipboard via OSC 52.
//!
//! Selection lifecycle:
//!
//!   left-down in main pane → anchor recorded (no highlight yet — may be a click)
//!   drag                   → selection becomes active, cells highlighted
//!   left-up after a drag   → finalized; caller extracts text and copies it
//!   next click / keystroke → a retained selection is cleared
//!
//! Coordinates are stored main-pane-relative (column, row), matching the grid
//! the renderer already exposes through `TerminalCore`.

use crate::terminal::TerminalCore;

/// Phase of an in-progress or finalized selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    /// Button is down but has not moved. A release here is a plain click.
    Anchored,
    /// The pointer moved from the anchor; cells are being highlighted.
    Dragging,
    /// Released after dragging. The span is visible and copy-ready.
    Done,
}

/// A rectangular-by-flow text selection within the child pane, in main-relative
/// cell coordinates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Selection {
    anchor: (u16, u16),
    cursor: (u16, u16),
    phase: Phase,
}

impl Selection {
    /// Records the anchor for a potential selection. Nothing is highlighted yet.
    pub fn anchor(column: u16, row: u16) -> Self {
        Self {
            anchor: (column, row),
            cursor: (column, row),
            phase: Phase::Anchored,
        }
    }

    /// Extends the selection to a new pointer cell, promoting it to an active
    /// drag once the pointer leaves the anchor cell.
    pub fn drag_to(&mut self, column: u16, row: u16) {
        self.cursor = (column, row);
        if self.phase == Phase::Anchored && self.cursor != self.anchor {
            self.phase = Phase::Dragging;
        }
    }

    /// Finalizes the gesture. Returns `true` when this was a real drag (and is
    /// therefore copy-worthy); a plain click returns `false`.
    pub fn finish(&mut self) -> bool {
        let dragged = self.phase == Phase::Dragging;
        self.phase = Phase::Done;
        dragged
    }

    /// Whether cells should be highlighted for this selection.
    pub fn is_active(&self) -> bool {
        matches!(self.phase, Phase::Dragging | Phase::Done)
    }

    /// Ordered (start, end) endpoints in reading order (top-to-bottom,
    /// left-to-right on the anchor row).
    fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        let a = (self.anchor.1, self.anchor.0);
        let c = (self.cursor.1, self.cursor.0);
        if a <= c {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }

    /// Whether a given main-relative cell falls within the selection span.
    /// Multi-row selections cover from the start column on the first row,
    /// through whole intermediate rows, to the end column on the last row.
    pub fn contains(&self, column: u16, row: u16) -> bool {
        if !self.is_active() {
            return false;
        }
        let (start, end) = self.ordered();
        let (sc, sr) = (start.0, start.1);
        let (ec, er) = (end.0, end.1);
        if row < sr || row > er {
            return false;
        }
        let left = if row == sr { sc } else { 0 };
        let right = if row == er { ec } else { u16::MAX };
        column >= left && column <= right
    }
}

/// Extracts the selected text from a terminal grid, joining rows with `\n` and
/// trimming trailing whitespace on each row (matching common terminal copy
/// behavior). Returns `None` when the selection yields no printable content.
pub fn selected_text<T: TerminalCore>(terminal: &T, selection: &Selection) -> Option<String> {
    if !selection.is_active() {
        return None;
    }
    let size = terminal.grid_size();
    let (start, end) = selection.ordered();
    let (sc, sr) = (start.0, start.1);
    let (ec, er) = (end.0, end.1);

    let mut lines: Vec<String> = Vec::new();
    for row in sr..=er.min(size.rows.saturating_sub(1)) {
        let left = if row == sr { sc } else { 0 };
        let right = if row == er {
            ec
        } else {
            size.columns.saturating_sub(1)
        };
        let mut line = String::new();
        let mut column = left;
        while column <= right && column < size.columns {
            if let Some(cell) = terminal.cell(column, row) {
                // Skip wide-character trailing spacer cells (width 0); their
                // glyph lives in the preceding cell.
                if cell.width == 0 {
                    column += 1;
                    continue;
                }
                if cell.text.is_empty() {
                    line.push(' ');
                } else {
                    line.push_str(&cell.text);
                }
            } else {
                line.push(' ');
            }
            column += 1;
        }
        lines.push(line.trim_end().to_string());
    }

    let text = lines.join("\n");
    if text.chars().all(char::is_whitespace) {
        None
    } else {
        Some(text)
    }
}

/// Encodes clipboard bytes as an OSC 52 write to the system clipboard.
///
/// Format: `ESC ] 52 ; c ; <base64> BEL`. The `c` target selects the system
/// clipboard (not the X11 primary selection). BEL terminates the sequence for
/// the broadest terminal compatibility.
pub fn osc52_clipboard(text: &str) -> Vec<u8> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let mut bytes = b"\x1b]52;c;".to_vec();
    bytes.extend_from_slice(encoded.as_bytes());
    bytes.push(0x07);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::{
        CursorState, GridSize, TerminalCell, TerminalCore, TerminalModes, TerminalUpdate,
    };

    /// A minimal grid backed by row strings, one char per cell.
    struct Grid {
        rows: Vec<Vec<TerminalCell>>,
    }

    impl Grid {
        fn new(rows: &[&str]) -> Self {
            Self {
                rows: rows
                    .iter()
                    .map(|line| {
                        line.chars()
                            .map(|character| TerminalCell {
                                text: character.to_string(),
                                width: 1,
                                ..Default::default()
                            })
                            .collect()
                    })
                    .collect(),
            }
        }
    }

    impl TerminalCore for Grid {
        type Error = ();
        fn feed(&mut self, _: &[u8]) -> Result<TerminalUpdate, Self::Error> {
            unreachable!()
        }
        fn resize(&mut self, _: GridSize) -> Result<TerminalUpdate, Self::Error> {
            unreachable!()
        }
        fn grid_size(&self) -> GridSize {
            GridSize {
                columns: self.rows.iter().map(Vec::len).max().unwrap_or(0) as u16,
                rows: self.rows.len() as u16,
            }
        }
        fn cell(&self, column: u16, row: u16) -> Option<TerminalCell> {
            self.rows
                .get(row as usize)
                .and_then(|line| line.get(column as usize))
                .cloned()
        }
        fn cursor(&self) -> Option<CursorState> {
            None
        }
        fn modes(&self) -> TerminalModes {
            TerminalModes::default()
        }
    }

    #[test]
    fn plain_click_is_not_a_drag_and_highlights_nothing() {
        let mut selection = Selection::anchor(3, 1);
        assert!(!selection.is_active(), "an un-dragged anchor is not highlighted");
        assert!(!selection.contains(3, 1));
        // A click that never moved reports not-copy-worthy; the caller drops it.
        assert!(!selection.finish(), "a click that never moved is not a copy");
    }

    #[test]
    fn drag_activates_finalizes_and_reports_copy_worthy() {
        let mut selection = Selection::anchor(1, 0);
        selection.drag_to(4, 0);
        assert!(selection.is_active());
        assert!(selection.contains(2, 0));
        assert!(!selection.contains(5, 0));
        assert!(selection.finish());
        // Still highlighted after release.
        assert!(selection.is_active());
    }

    #[test]
    fn selection_is_direction_agnostic() {
        let mut forward = Selection::anchor(1, 0);
        forward.drag_to(4, 0);
        let mut backward = Selection::anchor(4, 0);
        backward.drag_to(1, 0);
        for column in 1..=4 {
            assert!(forward.contains(column, 0));
            assert!(backward.contains(column, 0));
        }
    }

    #[test]
    fn multi_row_span_covers_partial_first_whole_middle_partial_last() {
        let mut selection = Selection::anchor(2, 0);
        selection.drag_to(1, 2);
        // First row: from anchor column to end.
        assert!(!selection.contains(1, 0));
        assert!(selection.contains(2, 0));
        assert!(selection.contains(50, 0));
        // Middle row: entirely selected.
        assert!(selection.contains(0, 1));
        assert!(selection.contains(99, 1));
        // Last row: up to the cursor column.
        assert!(selection.contains(0, 2));
        assert!(selection.contains(1, 2));
        assert!(!selection.contains(2, 2));
    }

    #[test]
    fn single_row_text_trims_trailing_space() {
        let grid = Grid::new(&["hello world   "]);
        let mut selection = Selection::anchor(0, 0);
        selection.drag_to(13, 0);
        assert_eq!(selected_text(&grid, &selection).as_deref(), Some("hello world"));
    }

    #[test]
    fn multi_row_text_joins_with_newlines() {
        let grid = Grid::new(&["abcdef", "ghijkl", "mnopqr"]);
        let mut selection = Selection::anchor(2, 0);
        selection.drag_to(3, 2);
        assert_eq!(
            selected_text(&grid, &selection).as_deref(),
            Some("cdef\nghijkl\nmnop")
        );
    }

    #[test]
    fn whitespace_only_selection_yields_no_text() {
        let grid = Grid::new(&["      "]);
        let mut selection = Selection::anchor(0, 0);
        selection.drag_to(5, 0);
        assert_eq!(selected_text(&grid, &selection), None);
    }

    #[test]
    fn inactive_selection_yields_no_text() {
        let grid = Grid::new(&["hello"]);
        let selection = Selection::anchor(0, 0);
        assert_eq!(selected_text(&grid, &selection), None);
    }

    #[test]
    fn osc52_targets_system_clipboard_with_bel_terminator() {
        // `c` target (system clipboard), base64 payload, BEL (0x07) terminator.
        assert_eq!(osc52_clipboard("hello"), b"\x1b]52;c;aGVsbG8=\x07");
    }

    #[test]
    fn osc52_is_not_primary_selection() {
        let bytes = osc52_clipboard("x");
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("\x1b]52;c;"));
        assert!(!text.contains(";p;"), "must not target X11 primary selection");
    }
}
