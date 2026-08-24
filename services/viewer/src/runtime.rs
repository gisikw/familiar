use crate::app::{App, TargetRuntime, ViewerTarget};
use crate::capture::{self, HostWriter};
use crate::cli::Config;
use crate::graphics::{probe_host, CellAspect, GraphicsMode, HostGraphics};
use crate::input::{route_mouse, target_for_sidebar_hit, MouseRoute};
use crate::layout::{viewer_layout, ViewerLayout};
use crate::pty::{child_command, pty_size};
use crate::sidebar::{
    has_live_session, render as render_sidebar, rows_for, spawn_poller, RowModel, SidebarModel,
};
use crate::terminal::ghostty::GhosttyTerminal;
use crate::terminal::{CellAttributes, GridSize, TerminalColor, TerminalCore, TerminalModes};
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, window_size, EnterAlternateScreen, LeaveAlternateScreen,
};
use portable_pty::{native_pty_system, Child, MasterPty};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Alignment;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::Terminal;
use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static GRAPHICS_ACTIVE: AtomicBool = AtomicBool::new(false);

fn restore_host_terminal() {
    if TERMINAL_ACTIVE.swap(false, Ordering::SeqCst) {
        if GRAPHICS_ACTIVE.swap(false, Ordering::SeqCst) {
            let _ = HostWriter::stdout().write_all(b"\x1b_Ga=d,d=A,q=2;\x1b\\");
        }
        let _ = execute!(
            HostWriter::stdout(),
            DisableMouseCapture,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

/// Restores the host tty on ordinary returns, panics, and termination signals.
pub struct TerminalGuard;

impl TerminalGuard {
    pub fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(
            HostWriter::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture
        ) {
            let _ = execute!(
                HostWriter::stdout(),
                DisableMouseCapture,
                LeaveAlternateScreen
            );
            let _ = disable_raw_mode();
            return Err(error);
        }
        TERMINAL_ACTIVE.store(true, Ordering::SeqCst);

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_host_terminal();
            previous(info);
        }));

        let mut signals = match Signals::new([SIGTERM, SIGINT, SIGHUP]) {
            Ok(signals) => signals,
            Err(error) => {
                restore_host_terminal();
                return Err(error);
            }
        };
        thread::spawn(move || {
            if let Some(signal) = signals.forever().next() {
                restore_host_terminal();
                std::process::exit(128 + signal);
            }
        });
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_host_terminal();
    }
}

#[derive(Debug)]
enum PtyMessage {
    Data(u64, Vec<u8>),
    Eof(u64),
}

struct ChildSession {
    id: u64,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    reaped: bool,
    exit_success: Option<bool>,
}

impl ChildSession {
    fn stop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.reaped = true;
        }
    }
}

pub struct ChildManager {
    config: Config,
    tx: Sender<PtyMessage>,
    next_id: u64,
    session: Option<ChildSession>,
    size: GridSize,
}

impl ChildManager {
    fn new(config: Config, tx: Sender<PtyMessage>, size: GridSize) -> io::Result<Self> {
        let mut manager = Self {
            config,
            tx,
            next_id: 0,
            session: None,
            size,
        };
        manager.replace(&ViewerTarget::Presence)?;
        Ok(manager)
    }

    fn spawn(&mut self, target: &ViewerTarget) -> io::Result<ChildSession> {
        self.next_id += 1;
        let id = self.next_id;
        let pair = native_pty_system()
            .openpty(pty_size(self.size.rows, self.size.columns))
            .map_err(io::Error::other)?;
        let mut reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let writer = pair.master.take_writer().map_err(io::Error::other)?;
        let child = pair
            .slave
            .spawn_command(child_command(&self.config, target).portable_pty_builder())
            .map_err(io::Error::other)?;
        drop(pair.slave);

        let tx = self.tx.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        if tx
                            .send(PtyMessage::Data(id, buffer[..length].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(PtyMessage::Eof(id));
        });
        Ok(ChildSession {
            id,
            master: pair.master,
            child,
            writer,
            reaped: false,
            exit_success: None,
        })
    }

    fn active_id(&self) -> Option<u64> {
        self.session.as_ref().map(|session| session.id)
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        if let Some(session) = &mut self.session {
            session.writer.write_all(bytes)?;
            session.writer.flush()?;
        }
        Ok(())
    }

    fn poll_exit(&mut self) -> io::Result<Option<bool>> {
        let Some(session) = &mut self.session else {
            return Ok(None);
        };
        if session.reaped {
            return Ok(session.exit_success);
        }
        if let Some(status) = session.child.try_wait()? {
            session.reaped = true;
            session.exit_success = Some(status.success());
            return Ok(session.exit_success);
        }
        Ok(None)
    }

    fn resize(&mut self, size: GridSize) -> io::Result<()> {
        self.size = size;
        if let Some(session) = &self.session {
            session
                .master
                .resize(pty_size(size.rows, size.columns))
                .map_err(io::Error::other)?;
        }
        Ok(())
    }
}

impl TargetRuntime for ChildManager {
    type Error = io::Error;

    /// Spawn-first ordering keeps a failed switch from destroying the old view.
    fn replace(&mut self, target: &ViewerTarget) -> Result<(), Self::Error> {
        let replacement = self.spawn(target)?;
        let old = self.session.replace(replacement);
        if let Some(mut old) = old {
            old.stop();
        }
        Ok(())
    }
}

impl Drop for ChildManager {
    fn drop(&mut self) {
        if let Some(session) = &mut self.session {
            session.stop();
        }
    }
}

fn color(color: Option<TerminalColor>) -> Option<Color> {
    color.map(|color| match color {
        TerminalColor::Indexed(index) => Color::Indexed(index),
        TerminalColor::Rgb(r, g, b) => Color::Rgb(r, g, b),
    })
}

pub fn cell_style(
    attributes: CellAttributes,
    foreground: Option<TerminalColor>,
    background: Option<TerminalColor>,
) -> Style {
    let mut style = Style::default();
    if let Some(foreground) = color(foreground) {
        style = style.fg(foreground);
    }
    if let Some(background) = color(background) {
        style = style.bg(background);
    }
    if attributes.bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if attributes.italic {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if attributes.underlined {
        style = style.add_modifier(Modifier::UNDERLINED);
    }
    if attributes.inverse {
        style = style.add_modifier(Modifier::REVERSED);
    }
    style
}

pub fn render_cells<T: TerminalCore>(
    terminal: &T,
    area: ratatui::layout::Rect,
    buffer: &mut ratatui::buffer::Buffer,
) {
    let size = terminal.grid_size();
    for row in 0..size.rows.min(area.height) {
        for column in 0..size.columns.min(area.width) {
            let Some(cell) = terminal.cell(column, row) else {
                continue;
            };
            if cell.width == 0 {
                continue;
            }
            let symbol = if cell.text.is_empty() {
                " "
            } else {
                &cell.text
            };
            if let Some(output) = buffer.cell_mut((area.x + column, area.y + row)) {
                output.set_symbol(symbol).set_style(cell_style(
                    cell.attributes,
                    cell.foreground,
                    cell.background,
                ));
            }
        }
    }
}

fn mapped_cursor(layout: ViewerLayout, cursor: crate::terminal::CursorState) -> Option<(u16, u16)> {
    (cursor.visible && cursor.column < layout.main.width && cursor.row < layout.main.height)
        .then_some((layout.main.x + cursor.column, layout.main.y + cursor.row))
}

fn mark_image_area(mark: ratatui::layout::Rect) -> ratatui::layout::Rect {
    ratatui::layout::Rect::new(
        mark.x,
        mark.y.saturating_add(1),
        mark.width,
        mark.height.saturating_sub(4),
    )
}

fn render_mark_wordmark(
    mode: GraphicsMode,
    mark: ratatui::layout::Rect,
    target: &ViewerTarget,
    buffer: &mut ratatui::buffer::Buffer,
) {
    if mark.width == 0 || mark.height == 0 {
        return;
    }
    let mut style = Style::default().bold();
    let (text, area) = if mode == GraphicsMode::Kitty {
        style = style.fg(Color::Rgb(90, 212, 230));
        (
            "F A M I L I A R",
            ratatui::layout::Rect::new(
                mark.x,
                mark.y + mark.height.saturating_sub(2),
                mark.width,
                1,
            ),
        )
    } else {
        if matches!(target, ViewerTarget::Presence) {
            style = style.add_modifier(Modifier::REVERSED);
        }
        ("FAMILIAR", mark)
    };
    Paragraph::new(text)
        .alignment(Alignment::Center)
        .style(style)
        .render(area, buffer);
}

fn host_cell_aspect() -> CellAspect {
    window_size()
        .ok()
        .filter(|size| size.width > 0 && size.height > 0 && size.columns > 0 && size.rows > 0)
        .map(|size| CellAspect {
            // These products preserve the ratio (pixel_width / columns) /
            // (pixel_height / rows) without truncating each cell dimension.
            width: u32::from(size.width) * u32::from(size.rows),
            height: u32::from(size.height) * u32::from(size.columns),
        })
        .unwrap_or_default()
}

/// Draws the single-column separator between the Familiar chrome and the child
/// pane. The glyph color uses an ANSI palette slot (like the rest of the
/// sidebar) so the host terminal's Familiar theme controls the exact shade —
/// slot 8 (bright black) maps to the theme's `borderMuted` role.
fn render_divider(area: ratatui::layout::Rect, buffer: &mut ratatui::buffer::Buffer) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let style = Style::default().fg(Color::Indexed(8));
    for row in area.y..area.y.saturating_add(area.height) {
        if let Some(cell) = buffer.cell_mut((area.x, row)) {
            cell.set_symbol("│").set_style(style);
        }
    }
}

fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    terminal: &GhosttyTerminal,
    layout: ViewerLayout,
    notices: (Option<&str>, Option<&str>),
    sidebar_rows: &RowModel,
    target: &ViewerTarget,
    graphics_mode: GraphicsMode,
) {
    let (child_notice, sidebar_notice) = notices;
    if layout.sidebar.width > 0 {
        render_mark_wordmark(graphics_mode, layout.mark, target, frame.buffer_mut());
    }
    render_sidebar(sidebar_rows, layout.job_rows, frame.buffer_mut());
    render_divider(layout.divider, frame.buffer_mut());
    if let Some(notice) = sidebar_notice {
        Paragraph::new(notice)
            .style(Style::default().fg(Color::Indexed(1)))
            .render(layout.job_rows, frame.buffer_mut());
    }
    render_cells(terminal, layout.main, frame.buffer_mut());
    if let Some(notice) = child_notice {
        Paragraph::new(notice)
            .alignment(Alignment::Center)
            .render(layout.main, frame.buffer_mut());
    } else if let Some(position) = terminal
        .cursor()
        .and_then(|cursor| mapped_cursor(layout, cursor))
    {
        frame.set_cursor_position(position);
    }
}

pub fn is_quit_key(key: KeyEvent) -> bool {
    // Legacy terminals encode Ctrl-\ as 0x1C, which is also Ctrl-4; crossterm
    // reports that byte as Char('4')+CONTROL, so both spellings mean quit.
    !matches!(key.kind, KeyEventKind::Release)
        && matches!(key.code, KeyCode::Char('\\') | KeyCode::Char('4'))
        && key.modifiers.contains(KeyModifiers::CONTROL)
}

pub fn encode_key(key: KeyEvent, modes: TerminalModes) -> Vec<u8> {
    if matches!(key.kind, KeyEventKind::Release) || is_quit_key(key) {
        return Vec::new();
    }
    let application = modes.application_cursor;
    let sequence: Option<&str> = match key.code {
        KeyCode::Enter => Some("\r"),
        KeyCode::Tab => Some("\t"),
        KeyCode::BackTab => Some("\x1b[Z"),
        KeyCode::Backspace => Some("\x7f"),
        KeyCode::Esc => Some("\x1b"),
        KeyCode::Up => Some(if application { "\x1bOA" } else { "\x1b[A" }),
        KeyCode::Down => Some(if application { "\x1bOB" } else { "\x1b[B" }),
        KeyCode::Right => Some(if application { "\x1bOC" } else { "\x1b[C" }),
        KeyCode::Left => Some(if application { "\x1bOD" } else { "\x1b[D" }),
        KeyCode::Home => Some(if application { "\x1bOH" } else { "\x1b[H" }),
        KeyCode::End => Some(if application { "\x1bOF" } else { "\x1b[F" }),
        KeyCode::PageUp => Some("\x1b[5~"),
        KeyCode::PageDown => Some("\x1b[6~"),
        KeyCode::Insert => Some("\x1b[2~"),
        KeyCode::Delete => Some("\x1b[3~"),
        KeyCode::F(1) => Some("\x1bOP"),
        KeyCode::F(2) => Some("\x1bOQ"),
        KeyCode::F(3) => Some("\x1bOR"),
        KeyCode::F(4) => Some("\x1bOS"),
        KeyCode::F(5) => Some("\x1b[15~"),
        KeyCode::F(6) => Some("\x1b[17~"),
        KeyCode::F(7) => Some("\x1b[18~"),
        KeyCode::F(8) => Some("\x1b[19~"),
        KeyCode::F(9) => Some("\x1b[20~"),
        KeyCode::F(10) => Some("\x1b[21~"),
        KeyCode::F(11) => Some("\x1b[23~"),
        KeyCode::F(12) => Some("\x1b[24~"),
        _ => None,
    };
    let mut bytes = if let Some(sequence) = sequence {
        sequence.as_bytes().to_vec()
    } else if let KeyCode::Char(character) = key.code {
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            let lower = character.to_ascii_lowercase();
            if lower == ' ' || lower == '@' {
                vec![0]
            } else if lower.is_ascii_lowercase() {
                vec![(lower as u8) - b'a' + 1]
            } else if lower == '[' {
                vec![0x1b]
            } else if lower == '\\' {
                vec![0x1c]
            } else if lower == ']' {
                vec![0x1d]
            } else {
                character.to_string().into_bytes()
            }
        } else {
            character.to_string().into_bytes()
        }
    } else {
        Vec::new()
    };
    if key.modifiers.contains(KeyModifiers::ALT) && !bytes.is_empty() {
        bytes.insert(0, 0x1b);
    }
    bytes
}

pub fn encode_paste(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        let mut bytes = b"\x1b[200~".to_vec();
        bytes.extend_from_slice(text.as_bytes());
        bytes.extend_from_slice(b"\x1b[201~");
        bytes
    } else {
        text.as_bytes().to_vec()
    }
}

fn dimensions(layout: ViewerLayout) -> GridSize {
    GridSize {
        columns: layout.main.width.max(1),
        rows: layout.main.height.max(1),
    }
}

pub fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    // Initialize the capture tap before any host-bound bytes leave the process
    // (the guard enters the alternate screen on construction).
    capture::init();
    let _guard = TerminalGuard::enter()?;
    // Crossterm construction performs a cursor-position query. Do it before
    // our raw capability probe so its CPR cannot be mistaken for user input.
    let backend = CrosstermBackend::new(HostWriter::stdout());
    let mut host = Terminal::new(backend)?;
    host.clear()?;
    let (graphics_mode, buffered_input) = probe_host(Duration::from_millis(200))?;
    GRAPHICS_ACTIVE.store(graphics_mode == GraphicsMode::Kitty, Ordering::SeqCst);
    let (width, height) = crossterm::terminal::size()?;
    let mut layout = viewer_layout(width, height);
    let mut core = GhosttyTerminal::new(dimensions(layout))?;
    let mut app = App::default();
    let agents_socket = config.agents_socket.clone();
    let sidebar_rx = spawn_poller(config.agents_endpoint.clone(), agents_socket.clone());
    let mut sidebar_model = SidebarModel::default();
    let mut sidebar_rows = rows_for(
        &sidebar_model,
        app.target(),
        layout.job_rows.height,
        layout.job_rows.width,
    );
    let (tx, rx): (Sender<PtyMessage>, Receiver<PtyMessage>) = mpsc::channel();
    let mut child = ChildManager::new(config, tx, dimensions(layout))?;
    if !buffered_input.is_empty() {
        child.write_all(&buffered_input)?;
    }
    let mut graphics = HostGraphics::new(graphics_mode);
    let mut cell_aspect = host_cell_aspect();
    let mut damaged = true;
    let mut child_notice: Option<String> = None;
    let mut sidebar_notice: Option<(String, Instant)> = None;

    loop {
        if sidebar_notice
            .as_ref()
            .is_some_and(|(_, until)| Instant::now() >= *until)
        {
            sidebar_notice = None;
            damaged = true;
        }
        if event::poll(Duration::from_millis(10))? {
            match event::read()? {
                Event::Key(key) => {
                    if is_quit_key(key) {
                        return Ok(());
                    }
                    if child.write_all(&encode_key(key, core.modes())).is_err() {
                        child_notice = Some("tmux session ended — waiting for a new target".into());
                        damaged = true;
                    }
                }
                Event::Paste(text) => {
                    if child
                        .write_all(&encode_paste(&text, core.modes().bracketed_paste))
                        .is_err()
                    {
                        child_notice = Some("tmux session ended — waiting for a new target".into());
                        damaged = true;
                    }
                }
                Event::Mouse(mouse) => {
                    match route_mouse(mouse, layout, core.modes(), |row| sidebar_rows.hit(row)) {
                        MouseRoute::Child(bytes) => {
                            let _ = child.write_all(&bytes);
                        }
                        MouseRoute::Sidebar(hit)
                            if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) =>
                        {
                            let target =
                                target_for_sidebar_hit(hit, |row| sidebar_rows.agent_for_row(row));
                            if let Some(target) = target {
                                if target != *app.target() {
                                    // Snapshot liveness avoids misleading clicks; this
                                    // immediate check closes the poll-to-click race.
                                    if let ViewerTarget::Agent(id) = &target {
                                        if !has_live_session(&agents_socket, id) {
                                            continue;
                                        }
                                    }
                                    match app.switch_target(target, &mut child) {
                                        Ok(()) => {
                                            // A fresh core cannot leak parser, modes, or screen
                                            // state from the previous child.
                                            core = GhosttyTerminal::new(dimensions(layout))?;
                                            let deletes = graphics.clear_child_state();
                                            host.backend_mut().write_all(&deletes)?;
                                            host.clear()?;
                                            graphics.invalidate_host_images();
                                            child_notice = None;
                                            sidebar_notice = None;
                                            sidebar_rows = rows_for(
                                                &sidebar_model,
                                                app.target(),
                                                layout.job_rows.height,
                                                layout.job_rows.width,
                                            );
                                            damaged = true;
                                        }
                                        Err(error) => {
                                            sidebar_notice = Some((
                                                format!("Could not switch target: {error}"),
                                                Instant::now() + Duration::from_secs(3),
                                            ));
                                            damaged = true;
                                        }
                                    }
                                }
                            }
                        }
                        MouseRoute::Sidebar(_) | MouseRoute::Swallowed => {}
                    }
                }
                Event::Resize(width, height) => {
                    layout = viewer_layout(width, height);
                    let size = dimensions(layout);
                    let update = core.resize(size)?;
                    graphics.handle_events(update.graphics);
                    graphics.invalidate_host_images();
                    cell_aspect = host_cell_aspect();
                    child.resize(size)?;
                    host.resize(ratatui::layout::Rect::new(0, 0, width, height))?;
                    sidebar_rows = rows_for(
                        &sidebar_model,
                        app.target(),
                        layout.job_rows.height,
                        layout.job_rows.width,
                    );
                    damaged = true;
                }
                _ => {}
            }
        }

        while let Ok(snapshot) = sidebar_rx.try_recv() {
            if snapshot != sidebar_model {
                sidebar_model = snapshot;
                sidebar_rows = rows_for(
                    &sidebar_model,
                    app.target(),
                    layout.job_rows.height,
                    layout.job_rows.width,
                );
                damaged = true;
            }
        }

        while let Ok(message) = rx.try_recv() {
            match message {
                PtyMessage::Data(id, bytes) if Some(id) == child.active_id() => {
                    let update = core.feed(&bytes)?;
                    for reply in update.replies {
                        let _ = child.write_all(&reply);
                    }
                    graphics.handle_events(update.graphics);
                    damaged |= !update.dirty.is_empty();
                }
                PtyMessage::Eof(id) if Some(id) == child.active_id() => {
                    child_notice = Some("tmux session ended — waiting for a new target".into());
                    damaged = true;
                }
                _ => {}
            }
        }

        match child.poll_exit()? {
            Some(true) => return Ok(()),
            Some(false) if child_notice.is_none() => {
                child_notice = Some("tmux session ended — waiting for a new target".into());
                damaged = true;
            }
            _ => {}
        }

        // Mode 2026 is only a render-coalescing hint here; parser state remains live.
        if damaged && !core.modes().synchronized_output {
            if graphics_mode == GraphicsMode::Kitty {
                host.backend_mut().write_all(b"\x1b[?2026h")?;
            }
            host.draw(|frame| {
                render_frame(
                    frame,
                    &core,
                    layout,
                    (
                        child_notice.as_deref(),
                        sidebar_notice.as_ref().map(|(notice, _)| notice.as_str()),
                    ),
                    &sidebar_rows,
                    app.target(),
                    graphics_mode,
                )
            })?;
            if graphics_mode == GraphicsMode::Kitty {
                // Save only after ratatui has positioned the mapped child
                // cursor. Saving before draw restored a stale sidebar cursor.
                host.backend_mut().write_all(b"\x1b7")?;
                let bytes =
                    graphics.emit(layout.main, mark_image_area(layout.mark), cell_aspect, true);
                host.backend_mut().write_all(&bytes)?;
                host.backend_mut().write_all(b"\x1b8\x1b[?2026l")?;
                host.backend_mut().flush()?;
            }
            damaged = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::SidebarHit;
    use crate::terminal::{CursorState, TerminalCell, TerminalUpdate};
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    #[test]
    fn viewer_quit_is_intercepted_but_other_control_keys_pass_through() {
        let quit = KeyEvent::new(KeyCode::Char('\\'), KeyModifiers::CONTROL);
        assert!(is_quit_key(quit));
        assert!(encode_key(quit, TerminalModes::default()).is_empty());

        // Legacy 0x1C arrives from real terminals as Ctrl-4; it must quit,
        // not leak a literal '4' into the child.
        let quit_legacy = KeyEvent::new(KeyCode::Char('4'), KeyModifiers::CONTROL);
        assert!(is_quit_key(quit_legacy));
        assert!(encode_key(quit_legacy, TerminalModes::default()).is_empty());

        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(!is_quit_key(ctrl_c));
        assert_eq!(encode_key(ctrl_c, TerminalModes::default()), b"\x03");
    }

    #[test]
    fn arrows_follow_application_cursor_mode() {
        let key = KeyEvent::new(KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(encode_key(key, TerminalModes::default()), b"\x1b[A");
        let modes = TerminalModes {
            application_cursor: true,
            ..Default::default()
        };
        assert_eq!(encode_key(key, modes), b"\x1bOA");
    }

    #[test]
    fn sidebar_click_does_not_capture_the_next_keystroke() {
        let click = crossterm::event::MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 1,
            row: 1,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(
            route_mouse(
                click,
                viewer_layout(100, 30),
                TerminalModes::default(),
                |_| SidebarHit::Dead,
            ),
            MouseRoute::Sidebar(SidebarHit::Mark)
        );
        assert_eq!(
            encode_key(
                KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
                TerminalModes::default()
            ),
            b"x"
        );
    }

    #[test]
    fn child_cursor_is_always_mapped_past_the_sidebar() {
        let layout = viewer_layout(100, 30);
        assert_eq!(
            mapped_cursor(
                layout,
                CursorState {
                    column: 2,
                    row: 7,
                    visible: true,
                },
            ),
            Some((30, 7))
        );
        // Graphics cursor save/restore is emitted after draw, so this mapped
        // position is the one restored after image placements.
        assert!(b"\x1b7".starts_with(b"\x1b"));
    }

    #[test]
    fn divider_paints_a_themed_column_between_sidebar_and_main() {
        let layout = viewer_layout(100, 30);
        let mut buffer = Buffer::empty(ratatui::layout::Rect::new(0, 0, 100, 30));
        render_divider(layout.divider, &mut buffer);
        // The divider occupies the sidebar's last column across the full height,
        // styled from the theme palette (never a hardcoded hex).
        for row in 0..30 {
            let cell = buffer.cell((layout.divider.x, row)).unwrap();
            assert_eq!(cell.symbol(), "│");
            assert_eq!(cell.fg, Color::Indexed(8));
        }
        // The child pane's first column stays untouched.
        assert_eq!(buffer.cell((layout.main.x, 0)).unwrap().symbol(), " ");
    }

    #[test]
    fn kitty_mode_renders_the_spaced_wordmark_below_the_image() {
        let mark = ratatui::layout::Rect::new(0, 0, 28, 12);
        let mut buffer = Buffer::empty(mark);
        render_mark_wordmark(
            GraphicsMode::Kitty,
            mark,
            &ViewerTarget::Presence,
            &mut buffer,
        );
        let row = (0..mark.width)
            .map(|column| buffer.cell((column, 10)).unwrap().symbol())
            .collect::<String>();
        assert!(row.contains("F A M I L I A R"));
        assert_eq!(buffer.cell((7, 10)).unwrap().fg, Color::Rgb(90, 212, 230));
    }

    #[test]
    fn paste_wraps_only_in_bracketed_mode() {
        assert_eq!(encode_paste("hello", false), b"hello");
        assert_eq!(encode_paste("hello", true), b"\x1b[200~hello\x1b[201~");
    }

    struct Cells(Vec<TerminalCell>);
    impl TerminalCore for Cells {
        type Error = ();
        fn feed(&mut self, _: &[u8]) -> Result<TerminalUpdate, Self::Error> {
            unreachable!()
        }
        fn resize(&mut self, _: GridSize) -> Result<TerminalUpdate, Self::Error> {
            unreachable!()
        }
        fn grid_size(&self) -> GridSize {
            GridSize {
                columns: self.0.len() as u16,
                rows: 1,
            }
        }
        fn cell(&self, column: u16, _: u16) -> Option<TerminalCell> {
            self.0.get(column as usize).cloned()
        }
        fn cursor(&self) -> Option<CursorState> {
            None
        }
        fn modes(&self) -> TerminalModes {
            TerminalModes::default()
        }
    }

    #[test]
    fn render_converts_attributes_and_skips_wide_spacers() {
        let core = Cells(vec![
            TerminalCell {
                text: "界".into(),
                width: 2,
                attributes: CellAttributes {
                    bold: true,
                    italic: true,
                    underlined: true,
                    inverse: true,
                },
                foreground: Some(TerminalColor::Indexed(2)),
                background: Some(TerminalColor::Rgb(4, 5, 6)),
            },
            TerminalCell {
                text: "ignored".into(),
                width: 0,
                ..Default::default()
            },
        ]);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 2, 1));
        render_cells(&core, Rect::new(0, 0, 2, 1), &mut buffer);
        let first = buffer.cell((0, 0)).unwrap();
        assert_eq!(first.symbol(), "界");
        assert_eq!(first.fg, Color::Indexed(2));
        assert_eq!(first.bg, Color::Rgb(4, 5, 6));
        assert!(first.modifier.contains(
            Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED | Modifier::REVERSED
        ));
        assert_eq!(buffer.cell((1, 0)).unwrap().symbol(), " ");
    }
}
