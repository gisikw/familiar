//! Pure host-mouse hit testing and child-protocol encoding.

use crate::app::ViewerTarget;
use crate::layout::ViewerLayout;
use crate::terminal::{MouseEncoding, MouseTracking, TerminalModes};
use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidebarHit {
    Mark,
    JobRow(usize),
    ActionRow(usize),
    Dead,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MouseRoute {
    /// Familiar chrome consumed the event; these bytes never reach the PTY.
    Sidebar(SidebarHit),
    Child(Vec<u8>),
    /// An unmodified left-button gesture over the child pane. The viewer owns
    /// it for host text selection and copy-on-release *even when the child
    /// advertises mouse tracking*; a plain click is later replayed to the child
    /// so non-drag clicks still reach it. See [`route_mouse`] for arbitration.
    HostSelect,
    Swallowed,
}

/// Resolves host chrome navigation; stale/non-terminal rows remain no-ops.
pub fn target_for_sidebar_hit<F>(hit: SidebarHit, target_for_row: F) -> Option<ViewerTarget>
where
    F: FnOnce(usize) -> Option<ViewerTarget>,
{
    match hit {
        SidebarHit::Mark => Some(ViewerTarget::Presence),
        SidebarHit::JobRow(index) => target_for_row(index),
        SidebarHit::ActionRow(_) | SidebarHit::Dead => None,
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

    // Mouse arbitration for the child pane. An ordinary, unmodified left-button
    // gesture (down/drag/up) belongs to the *viewer* for text selection and
    // copy-on-release, regardless of whether the child requested mouse
    // tracking. This keeps host selection/OSC 52 reachable under the real
    // topology, where the child (tmux) has mouse tracking enabled.
    //
    // Holding Shift — the conventional terminal mouse-arbitration modifier —
    // forces the left gesture through to the child instead. Wheel, middle, and
    // right events are never claimed here and fall through to the child.
    if is_left_gesture(event.kind) && !event.modifiers.contains(KeyModifiers::SHIFT) {
        return MouseRoute::HostSelect;
    }

    match child_mouse_bytes(event, layout, modes) {
        Some(bytes) => MouseRoute::Child(bytes),
        None => MouseRoute::Swallowed,
    }
}

/// Whether a mouse event is a left-button press, drag, or release — the gesture
/// classes the viewer arbitrates for host text selection.
fn is_left_gesture(kind: MouseEventKind) -> bool {
    matches!(
        kind,
        MouseEventKind::Down(MouseButton::Left)
            | MouseEventKind::Drag(MouseButton::Left)
            | MouseEventKind::Up(MouseButton::Left)
    )
}

/// Encodes a main-pane mouse event into child mouse-report bytes, honoring the
/// child's tracking mode and encoding. Returns `None` when the child is not
/// tracking or the event class is filtered out for the active tracking mode.
///
/// The event's coordinates are translated relative to the main pane; callers
/// must have already confirmed the event lies within it. This is also the seam
/// the runtime uses to *replay* a deferred plain left click to the child.
pub fn child_mouse_bytes(
    event: MouseEvent,
    layout: ViewerLayout,
    modes: TerminalModes,
) -> Option<Vec<u8>> {
    if modes.mouse_tracking == MouseTracking::None {
        return None;
    }
    let column = event.column.saturating_sub(layout.main.x);
    let row = event.row.saturating_sub(layout.main.y);
    let report = report_for(event.kind, modes.mouse_tracking)?;
    Some(encode_report(
        report,
        column,
        row,
        event.modifiers,
        modes.mouse_encoding,
    ))
}

/// Maps a host mouse event to a main-pane-relative `(column, row)` cell, or
/// `None` when the event falls outside the child pane. Used by host-side text
/// selection, which operates independently of child mouse-reporting routing.
pub fn main_cell(layout: ViewerLayout, event: MouseEvent) -> Option<(u16, u16)> {
    contains(layout.main, event.column, event.row).then(|| {
        (
            event.column.saturating_sub(layout.main.x),
            event.row.saturating_sub(layout.main.y),
        )
    })
}

fn contains(rect: ratatui::layout::Rect, column: u16, row: u16) -> bool {
    column >= rect.x
        && column < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
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
        // Coordinate translation is tested through the child-encoding seam,
        // which is independent of the left-button host-selection arbitration.
        for (host, encoded) in [
            ((28, 0), (33, 33)),
            ((299, 0), (255, 33)),
            ((28, 239), (33, 255)),
            ((299, 239), (255, 255)),
        ] {
            let bytes = child_mouse_bytes(
                mouse(MouseEventKind::Down(MouseButton::Left), host.0, host.1),
                layout,
                mode,
            )
            .expect("main edge was not forwarded");
            assert_eq!((bytes[4], bytes[5]), encoded);
        }
    }

    #[test]
    fn unmodified_left_gesture_is_owned_by_the_viewer_even_with_tracking() {
        // Real topology: child (tmux) advertises mouse tracking. An ordinary
        // unmodified left down/drag/up over the main pane is claimed by the
        // viewer for host selection, not forwarded to the child.
        let tmux = modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr);
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert_eq!(route(mouse(kind, 30, 2), tmux), MouseRoute::HostSelect);
        }
        // The same holds even when the child requests no tracking at all.
        assert_eq!(
            route(
                mouse(MouseEventKind::Down(MouseButton::Left), 30, 2),
                TerminalModes::default()
            ),
            MouseRoute::HostSelect
        );
    }

    #[test]
    fn shift_passes_left_drag_through_to_the_child() {
        // Shift is the conventional modifier that hands the left gesture back to
        // the child instead of the viewer.
        let tmux = modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr);
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            let mut event = mouse(kind, 30, 2);
            event.modifiers = KeyModifiers::SHIFT;
            assert!(
                matches!(route(event, tmux), MouseRoute::Child(_)),
                "shift+{kind:?} should reach the child"
            );
        }
    }

    #[test]
    fn wheel_and_other_buttons_still_reach_a_tracking_child() {
        // Wheel and middle/right events are never claimed for host selection;
        // they forward to a tracking child unchanged.
        let tmux = modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr);
        for kind in [
            MouseEventKind::ScrollUp,
            MouseEventKind::ScrollDown,
            MouseEventKind::Down(MouseButton::Middle),
            MouseEventKind::Down(MouseButton::Right),
            MouseEventKind::Drag(MouseButton::Right),
        ] {
            assert!(
                matches!(route(mouse(kind, 30, 2), tmux), MouseRoute::Child(_)),
                "{kind:?} should forward to the child"
            );
        }
    }

    #[test]
    fn tracking_modes_filter_event_types() {
        // Non-left events are subject to the child's tracking-mode filter. A
        // wheel event is dropped when the child requests no tracking.
        assert_eq!(
            route(
                mouse(MouseEventKind::ScrollUp, 30, 2),
                TerminalModes::default()
            ),
            MouseRoute::Swallowed
        );
        let x10 = modes(MouseTracking::X10, MouseEncoding::Sgr);
        assert!(matches!(
            route(mouse(MouseEventKind::ScrollUp, 30, 2), x10),
            MouseRoute::Child(_)
        ));
        // X10 never reports drag/moved motion, so a shift-passthrough right
        // drag is filtered out and swallowed.
        let mut right_drag = mouse(MouseEventKind::Drag(MouseButton::Right), 30, 2);
        right_drag.modifiers = KeyModifiers::SHIFT;
        assert_eq!(route(right_drag, x10), MouseRoute::Swallowed);
        let button_mode = modes(MouseTracking::ButtonEvent, MouseEncoding::Sgr);
        assert!(matches!(
            route(
                mouse(MouseEventKind::Drag(MouseButton::Right), 30, 2),
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
                let route = route(mouse(kind, 30, 2), modes(tracking, MouseEncoding::Sgr));
                // Unmodified left gestures (down/up/drag = indices 0..=2) are
                // always claimed by the viewer for host selection, regardless
                // of the child's tracking mode.
                if matches!(index, 0..=2) {
                    assert_eq!(route, MouseRoute::HostSelect, "{tracking:?} event {index}");
                    continue;
                }
                let forwarded = matches!(route, MouseRoute::Child(_));
                let expected = match tracking {
                    MouseTracking::None => false,
                    MouseTracking::X10 => matches!(index, 4..=7),
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
            target_for_sidebar_hit(SidebarHit::JobRow(4), |index| Some(
                ViewerTarget::Terminal {
                    id: format!("item-{index}"),
                    socket: "/run/plugin.sock".into(),
                    session: format!("worker-{index}")
                }
            )),
            Some(ViewerTarget::Terminal {
                id: "item-4".into(),
                socket: "/run/plugin.sock".into(),
                session: "worker-4".into()
            })
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
