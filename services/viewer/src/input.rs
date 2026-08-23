//! Pure host-mouse hit testing and child-protocol encoding.

use crate::app::ViewerTarget;
use crate::layout::ViewerLayout;
use crate::terminal::{MouseEncoding, MouseTracking, TerminalModes};
use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidebarHit {
    Mark,
    JobRow(usize),
    Dead,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MouseRoute {
    /// Familiar chrome consumed the event; these bytes never reach the PTY.
    Sidebar(SidebarHit),
    Child(Vec<u8>),
    Swallowed,
}

/// Resolves chrome navigation without changing keyboard focus. Chunk 4 supplies
/// the stable agent id for a live model index; stale indices remain no-ops.
pub fn target_for_sidebar_hit<F>(hit: SidebarHit, agent_for_row: F) -> Option<ViewerTarget>
where
    F: FnOnce(usize) -> Option<String>,
{
    match hit {
        SidebarHit::Mark => Some(ViewerTarget::Presence),
        SidebarHit::JobRow(index) => agent_for_row(index).map(ViewerTarget::Agent),
        SidebarHit::Dead => None,
    }
}

/// Routes an event against canonical geometry. `job_row_lookup` is the Chunk 4
/// seam: it maps a sidebar-relative row to a live model row, or `Dead` for
/// blank/stale rows.
pub fn route_mouse<F>(
    event: MouseEvent,
    layout: ViewerLayout,
    modes: TerminalModes,
    job_row_lookup: F,
) -> MouseRoute
where
    F: FnOnce(usize) -> SidebarHit,
{
    if contains(layout.mark, event.column, event.row) {
        return MouseRoute::Sidebar(SidebarHit::Mark);
    }
    if contains(layout.job_rows, event.column, event.row) {
        return MouseRoute::Sidebar(job_row_lookup(
            event.row.saturating_sub(layout.job_rows.y) as usize
        ));
    }
    if !contains(layout.main, event.column, event.row) {
        return MouseRoute::Swallowed;
    }

    let column = event.column.saturating_sub(layout.main.x);
    let row = event.row.saturating_sub(layout.main.y);
    if modes.mouse_tracking == MouseTracking::None {
        return alternate_scroll(event.kind, modes.alternate_screen);
    }
    let Some(report) = report_for(event.kind, modes.mouse_tracking) else {
        return MouseRoute::Swallowed;
    };
    MouseRoute::Child(encode_report(
        report,
        column,
        row,
        event.modifiers,
        modes.mouse_encoding,
    ))
}

fn contains(rect: ratatui::layout::Rect, column: u16, row: u16) -> bool {
    column >= rect.x
        && column < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
}

fn alternate_scroll(kind: MouseEventKind, alternate_screen: bool) -> MouseRoute {
    if !alternate_screen {
        return MouseRoute::Swallowed;
    }
    let sequence = match kind {
        MouseEventKind::ScrollUp => b"\x1b[A".as_slice(),
        MouseEventKind::ScrollDown => b"\x1b[B".as_slice(),
        _ => return MouseRoute::Swallowed,
    };
    MouseRoute::Child(sequence.repeat(3))
}

#[derive(Clone, Copy)]
struct Report {
    button: u8,
    motion: bool,
    release: bool,
}

fn button(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    }
}

fn report_for(kind: MouseEventKind, tracking: MouseTracking) -> Option<Report> {
    match kind {
        MouseEventKind::Down(value) => Some(Report {
            button: button(value),
            motion: false,
            release: false,
        }),
        MouseEventKind::ScrollUp => Some(Report {
            button: 64,
            motion: false,
            release: false,
        }),
        MouseEventKind::ScrollDown => Some(Report {
            button: 65,
            motion: false,
            release: false,
        }),
        MouseEventKind::ScrollLeft => Some(Report {
            button: 66,
            motion: false,
            release: false,
        }),
        MouseEventKind::ScrollRight => Some(Report {
            button: 67,
            motion: false,
            release: false,
        }),
        MouseEventKind::Up(value)
            if matches!(
                tracking,
                MouseTracking::ButtonEvent | MouseTracking::AnyEvent
            ) =>
        {
            Some(Report {
                button: button(value),
                motion: false,
                release: true,
            })
        }
        MouseEventKind::Drag(value)
            if matches!(
                tracking,
                MouseTracking::ButtonEvent | MouseTracking::AnyEvent
            ) =>
        {
            Some(Report {
                button: button(value),
                motion: true,
                release: false,
            })
        }
        MouseEventKind::Moved if tracking == MouseTracking::AnyEvent => Some(Report {
            button: 3,
            motion: true,
            release: false,
        }),
        _ => None,
    }
}

fn modifier_bits(modifiers: KeyModifiers) -> u8 {
    (u8::from(modifiers.contains(KeyModifiers::SHIFT)) * 4)
        | (u8::from(modifiers.contains(KeyModifiers::ALT)) * 8)
        | (u8::from(modifiers.contains(KeyModifiers::CONTROL)) * 16)
}

fn encode_report(
    report: Report,
    column: u16,
    row: u16,
    modifiers: KeyModifiers,
    encoding: MouseEncoding,
) -> Vec<u8> {
    let mut code = report.button | modifier_bits(modifiers);
    if report.motion {
        code |= 32;
    }
    match encoding {
        MouseEncoding::Sgr | MouseEncoding::SgrPixels => {
            // Host pixel dimensions are unavailable. SGR-pixels deliberately
            // uses 1x1 pixels, so its coordinates equal one-based cell coords.
            format!(
                "\x1b[<{code};{};{}{}",
                u32::from(column) + 1,
                u32::from(row) + 1,
                if report.release { 'm' } else { 'M' }
            )
            .into_bytes()
        }
        MouseEncoding::X10 => {
            let legacy_code = if report.release {
                3 | modifier_bits(modifiers)
            } else {
                code
            };
            vec![
                0x1b,
                b'[',
                b'M',
                legacy_code.saturating_add(32),
                (column.min(222) as u8).saturating_add(33),
                (row.min(222) as u8).saturating_add(33),
            ]
        }
        MouseEncoding::Utf8 => {
            let legacy_code = if report.release {
                3 | modifier_bits(modifiers)
            } else {
                code
            };
            let mut bytes = b"\x1b[M".to_vec();
            push_utf8(&mut bytes, u32::from(legacy_code) + 32);
            push_utf8(&mut bytes, u32::from(column) + 33);
            push_utf8(&mut bytes, u32::from(row) + 33);
            bytes
        }
    }
}

fn push_utf8(bytes: &mut Vec<u8>, value: u32) {
    if let Some(character) = char::from_u32(value) {
        let mut buffer = [0; 4];
        bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::viewer_layout;

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn modes(tracking: MouseTracking, encoding: MouseEncoding) -> TerminalModes {
        TerminalModes {
            mouse_tracking: tracking,
            mouse_encoding: encoding,
            ..Default::default()
        }
    }

    fn route(event: MouseEvent, modes: TerminalModes) -> MouseRoute {
        route_mouse(event, viewer_layout(100, 30), modes, SidebarHit::JobRow)
    }

    #[test]
    fn translates_all_main_corners_and_clamps_legacy_edges() {
        let layout = viewer_layout(300, 240);
        let mode = modes(MouseTracking::X10, MouseEncoding::X10);
        for (host, encoded) in [
            ((28, 0), (33, 33)),
            ((299, 0), (255, 33)),
            ((28, 239), (33, 255)),
            ((299, 239), (255, 255)),
        ] {
            let MouseRoute::Child(bytes) = route_mouse(
                mouse(MouseEventKind::Down(MouseButton::Left), host.0, host.1),
                layout,
                mode,
                SidebarHit::JobRow,
            ) else {
                panic!("main edge was not forwarded")
            };
            assert_eq!((bytes[4], bytes[5]), encoded);
        }
    }

    #[test]
    fn tracking_modes_filter_event_types_and_alternate_scrolls() {
        let press = mouse(MouseEventKind::Down(MouseButton::Left), 30, 2);
        assert_eq!(
            route(press, TerminalModes::default()),
            MouseRoute::Swallowed
        );
        let alt = TerminalModes {
            alternate_screen: true,
            ..Default::default()
        };
        assert_eq!(
            route(mouse(MouseEventKind::ScrollUp, 30, 2), alt),
            MouseRoute::Child(b"\x1b[A\x1b[A\x1b[A".to_vec())
        );
        assert_eq!(
            route(
                mouse(MouseEventKind::ScrollUp, 30, 2),
                TerminalModes::default()
            ),
            MouseRoute::Swallowed
        );
        let x10 = modes(MouseTracking::X10, MouseEncoding::Sgr);
        assert!(matches!(route(press, x10), MouseRoute::Child(_)));
        assert_eq!(
            route(mouse(MouseEventKind::Up(MouseButton::Left), 30, 2), x10),
            MouseRoute::Swallowed
        );
        let button_mode = modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr);
        assert!(matches!(
            route(
                mouse(MouseEventKind::Drag(MouseButton::Left), 30, 2),
                button_mode
            ),
            MouseRoute::Child(_)
        ));
        assert_eq!(
            route(mouse(MouseEventKind::Moved, 30, 2), button_mode),
            MouseRoute::Swallowed
        );
        assert!(matches!(
            route(
                mouse(MouseEventKind::Moved, 30, 2),
                modes(MouseTracking::AnyEvent, MouseEncoding::Sgr)
            ),
            MouseRoute::Child(_)
        ));
    }

    #[test]
    fn every_tracking_mode_filters_every_event_class() {
        let events = [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Moved,
            MouseEventKind::ScrollUp,
            MouseEventKind::ScrollDown,
            MouseEventKind::ScrollLeft,
            MouseEventKind::ScrollRight,
        ];
        for tracking in [
            MouseTracking::None,
            MouseTracking::X10,
            MouseTracking::ButtonEvent,
            MouseTracking::AnyEvent,
        ] {
            for (index, kind) in events.into_iter().enumerate() {
                let forwarded = matches!(
                    route(mouse(kind, 30, 2), modes(tracking, MouseEncoding::Sgr)),
                    MouseRoute::Child(_)
                );
                let expected = match tracking {
                    MouseTracking::None => false,
                    MouseTracking::X10 => matches!(index, 0 | 4..=7),
                    MouseTracking::ButtonEvent => index != 3,
                    MouseTracking::AnyEvent => true,
                };
                assert_eq!(forwarded, expected, "{tracking:?} event {index}");
            }
        }
    }

    #[test]
    fn encodings_include_modifiers_motion_and_release() {
        let mut press = mouse(MouseEventKind::Down(MouseButton::Left), 30, 2);
        press.modifiers = KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL;
        assert_eq!(
            route(press, modes(MouseTracking::X10, MouseEncoding::X10)),
            MouseRoute::Child(vec![0x1b, b'[', b'M', 60, 35, 35])
        );
        assert_eq!(
            route(press, modes(MouseTracking::X10, MouseEncoding::Utf8)),
            MouseRoute::Child(b"\x1b[M<##".to_vec())
        );
        assert_eq!(
            route(press, modes(MouseTracking::X10, MouseEncoding::Sgr)),
            MouseRoute::Child(b"\x1b[<28;3;3M".to_vec())
        );
        assert_eq!(
            route(press, modes(MouseTracking::X10, MouseEncoding::SgrPixels)),
            MouseRoute::Child(b"\x1b[<28;3;3M".to_vec())
        );
        let mut release = mouse(MouseEventKind::Up(MouseButton::Right), 30, 2);
        release.modifiers = KeyModifiers::CONTROL;
        assert_eq!(
            route(
                release,
                modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr)
            ),
            MouseRoute::Child(b"\x1b[<18;3;3m".to_vec())
        );
        assert_eq!(
            route(
                release,
                modes(MouseTracking::ButtonEvent, MouseEncoding::X10)
            ),
            MouseRoute::Child(vec![0x1b, b'[', b'M', 51, 35, 35])
        );
        assert_eq!(
            route(
                release,
                modes(MouseTracking::ButtonEvent, MouseEncoding::Utf8)
            ),
            MouseRoute::Child(b"\x1b[M3##".to_vec())
        );
        assert_eq!(
            route(
                mouse(MouseEventKind::Drag(MouseButton::Middle), 30, 2),
                modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr)
            ),
            MouseRoute::Child(b"\x1b[<33;3;3M".to_vec())
        );
        assert_eq!(
            route(
                mouse(MouseEventKind::ScrollDown, 30, 2),
                modes(MouseTracking::X10, MouseEncoding::Sgr)
            ),
            MouseRoute::Child(b"\x1b[<65;3;3M".to_vec())
        );
    }

    #[test]
    fn sidebar_targets_resolve_presence_agents_and_dead_rows() {
        assert_eq!(
            target_for_sidebar_hit(SidebarHit::Mark, |_| None),
            Some(ViewerTarget::Presence)
        );
        assert_eq!(
            target_for_sidebar_hit(SidebarHit::JobRow(4), |index| Some(format!(
                "agent-{index}"
            ))),
            Some(ViewerTarget::Agent("agent-4".into()))
        );
        assert_eq!(target_for_sidebar_hit(SidebarHit::Dead, |_| None), None);
    }

    #[test]
    fn every_sidebar_event_is_consumed_with_no_child_bytes() {
        let all = [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::ScrollDown,
        ];
        for kind in all {
            assert_eq!(
                route(
                    mouse(kind, 1, 1),
                    modes(MouseTracking::AnyEvent, MouseEncoding::Sgr)
                ),
                MouseRoute::Sidebar(SidebarHit::Mark)
            );
            assert_eq!(
                route(
                    mouse(kind, 1, 14),
                    modes(MouseTracking::AnyEvent, MouseEncoding::Sgr)
                ),
                MouseRoute::Sidebar(SidebarHit::JobRow(2))
            );
        }
        assert_eq!(
            route_mouse(
                mouse(MouseEventKind::Down(MouseButton::Left), 1, 14),
                viewer_layout(100, 30),
                TerminalModes::default(),
                |_| SidebarHit::Dead,
            ),
            MouseRoute::Sidebar(SidebarHit::Dead)
        );
    }
}
