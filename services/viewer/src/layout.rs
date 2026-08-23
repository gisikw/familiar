use ratatui::layout::Rect;

pub const SIDEBAR_WIDTH: u16 = 28;
pub const NARROW_COLLAPSE_WIDTH: u16 = 40;
pub const MARK_HEIGHT: u16 = 12;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayoutMode {
    Desktop,
    Narrow,
}

/// The one canonical geometry result for rendering, hit-testing, child PTY
/// resize, and Kitty graphics placement. Below 40 columns Familiar chrome is
/// collapsed; the main region retains at least one column even for a zero-size
/// startup report. Future narrow navigation belongs behind `LayoutMode`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ViewerLayout {
    pub mode: LayoutMode,
    pub sidebar: Rect,
    pub mark: Rect,
    pub job_rows: Rect,
    pub main: Rect,
}

pub fn viewer_layout(width: u16, height: u16) -> ViewerLayout {
    let desktop = width >= NARROW_COLLAPSE_WIDTH;
    let sidebar_width = if desktop { SIDEBAR_WIDTH } else { 0 };
    let sidebar = Rect::new(0, 0, sidebar_width, height);
    let mark_height = MARK_HEIGHT.min(height);
    ViewerLayout {
        mode: if desktop {
            LayoutMode::Desktop
        } else {
            LayoutMode::Narrow
        },
        sidebar,
        mark: Rect::new(0, 0, sidebar_width, mark_height),
        job_rows: Rect::new(
            0,
            mark_height,
            sidebar_width,
            height.saturating_sub(mark_height),
        ),
        main: Rect::new(
            sidebar_width,
            0,
            width.saturating_sub(sidebar_width).max(1),
            height,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_regions_partition_sidebar_vertically() {
        let layout = viewer_layout(100, 30);
        assert_eq!(layout.sidebar, Rect::new(0, 0, 28, 30));
        assert_eq!(layout.mark, Rect::new(0, 0, 28, 12));
        assert_eq!(layout.job_rows, Rect::new(0, 12, 28, 18));
        assert_eq!(layout.main, Rect::new(28, 0, 72, 30));
    }

    #[test]
    fn threshold_collapses_sidebar() {
        assert_eq!(viewer_layout(40, 10).mode, LayoutMode::Desktop);
        let narrow = viewer_layout(39, 10);
        assert_eq!(narrow.mode, LayoutMode::Narrow);
        assert_eq!(narrow.sidebar.width, 0);
        assert_eq!(narrow.main, Rect::new(0, 0, 39, 10));
    }

    #[test]
    fn main_has_a_column_at_zero_width() {
        assert_eq!(viewer_layout(0, 0).main.width, 1);
    }
}
