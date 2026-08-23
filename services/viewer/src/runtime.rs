use crate::app::{TargetRuntime, ViewerTarget};
use crate::cli::Config;
use crate::graphics::{probe_host, GraphicsMode, HostGraphics};
use crate::layout::{viewer_layout, ViewerLayout};
use crate::pty::{child_command, pty_size};
use crate::terminal::ghostty::GhosttyTerminal;
use crate::terminal::{CellAttributes, GridSize, TerminalCore, TerminalModes};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
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
use std::time::Duration;

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static GRAPHICS_ACTIVE: AtomicBool = AtomicBool::new(false);

fn restore_host_terminal() {
    if TERMINAL_ACTIVE.swap(false, Ordering::SeqCst) {
        if GRAPHICS_ACTIVE.swap(false, Ordering::SeqCst) {
            let _ = io::stdout().write_all(b"\x1b_Ga=d,d=A,q=2;\x1b\\");
        }
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

/// Restores the host tty on ordinary returns, panics, and termination signals.
pub struct TerminalGuard;

impl TerminalGuard {
    pub fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        TERMINAL_ACTIVE.store(true, Ordering::SeqCst);

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_host_terminal();
            previous(info);
        }));

        let mut signals = Signals::new([SIGTERM, SIGINT, SIGHUP])?;
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

    fn poll_exit(&mut self) -> io::Result<bool> {
        let Some(session) = &mut self.session else {
            return Ok(false);
        };
        if session.reaped {
            return Ok(true);
        }
        if session.child.try_wait()?.is_some() {
            session.reaped = true;
            return Ok(true);
        }
        Ok(false)
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

fn color(rgb: Option<[u8; 3]>) -> Option<Color> {
    rgb.map(|[r, g, b]| Color::Rgb(r, g, b))
}

pub fn cell_style(
    attributes: CellAttributes,
    foreground: Option<[u8; 3]>,
    background: Option<[u8; 3]>,
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
                    cell.foreground_rgb,
                    cell.background_rgb,
                ));
            }
        }
    }
}

fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    terminal: &GhosttyTerminal,
    layout: ViewerLayout,
    child_notice: Option<&str>,
    graphics_mode: GraphicsMode,
) {
    if layout.sidebar.width > 0 && graphics_mode == GraphicsMode::Text {
        frame.render_widget(
            Paragraph::new("FAMILIAR")
                .alignment(Alignment::Center)
                .style(Style::default().bold()),
            layout.mark,
        );
    }
    render_cells(terminal, layout.main, frame.buffer_mut());
    if let Some(notice) = child_notice {
        Paragraph::new(notice)
            .alignment(Alignment::Center)
            .render(layout.main, frame.buffer_mut());
    } else if let Some(cursor) = terminal.cursor() {
        if cursor.visible && cursor.column < layout.main.width && cursor.row < layout.main.height {
            frame.set_cursor_position((layout.main.x + cursor.column, layout.main.y + cursor.row));
        }
    }
}

pub fn encode_key(key: KeyEvent, modes: TerminalModes) -> Vec<u8> {
    if matches!(key.kind, KeyEventKind::Release) {
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
    let _guard = TerminalGuard::enter()?;
    // Crossterm construction performs a cursor-position query. Do it before
    // our raw capability probe so its CPR cannot be mistaken for user input.
    let backend = CrosstermBackend::new(io::stdout());
    let mut host = Terminal::new(backend)?;
    host.clear()?;
    let (graphics_mode, buffered_input) = probe_host(Duration::from_millis(200))?;
    GRAPHICS_ACTIVE.store(graphics_mode == GraphicsMode::Kitty, Ordering::SeqCst);
    let (width, height) = crossterm::terminal::size()?;
    let mut layout = viewer_layout(width, height);
    let mut core = GhosttyTerminal::new(dimensions(layout))?;
    let (tx, rx): (Sender<PtyMessage>, Receiver<PtyMessage>) = mpsc::channel();
    let mut child = ChildManager::new(config, tx, dimensions(layout))?;
    if !buffered_input.is_empty() {
        child.write_all(&buffered_input)?;
    }
    let mut graphics = HostGraphics::new(graphics_mode);
    let mut damaged = true;
    let mut child_notice: Option<String> = None;

    loop {
        if event::poll(Duration::from_millis(10))? {
            match event::read()? {
                Event::Key(key) => {
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
                Event::Resize(width, height) => {
                    layout = viewer_layout(width, height);
                    let size = dimensions(layout);
                    let update = core.resize(size)?;
                    graphics.handle_events(update.graphics);
                    child.resize(size)?;
                    host.resize(ratatui::layout::Rect::new(0, 0, width, height))?;
                    damaged = true;
                }
                _ => {}
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

        if child.poll_exit()? && child_notice.is_none() {
            child_notice = Some("tmux session ended — waiting for a new target".into());
            damaged = true;
        }

        // Mode 2026 is only a render-coalescing hint here; parser state remains live.
        if damaged && !core.modes().synchronized_output {
            if graphics_mode == GraphicsMode::Kitty {
                host.backend_mut().write_all(b"\x1b[?2026h\x1b7")?;
            }
            host.draw(|frame| {
                render_frame(frame, &core, layout, child_notice.as_deref(), graphics_mode)
            })?;
            if graphics_mode == GraphicsMode::Kitty {
                let bytes = graphics.emit(layout.main, layout.mark, true);
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
    use crate::terminal::{CursorState, TerminalCell, TerminalUpdate};
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

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
                foreground_rgb: Some([1, 2, 3]),
                background_rgb: Some([4, 5, 6]),
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
        assert_eq!(first.fg, Color::Rgb(1, 2, 3));
        assert_eq!(first.bg, Color::Rgb(4, 5, 6));
        assert!(first.modifier.contains(
            Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED | Modifier::REVERSED
        ));
        assert_eq!(buffer.cell((1, 0)).unwrap().symbol(), " ");
    }
}
