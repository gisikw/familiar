//! Kitty graphics extraction/presentation support.
//!
//! Child graphics are read from libghostty-vt as snapshots. The host owns a
//! separate ID namespace, clips every placement to the embedded main rect, and
//! never forwards child APC bytes directly.

use base64::Engine;
use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const MARK_IMAGE_ID: u32 = 4_000_000_000;
pub const PROBE_IMAGE_ID: u32 = 4_000_000_001;
const CHILD_HOST_ID_BASE: u32 = 1_000_000;
const KITTY_CHUNK: usize = 3072;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GraphicsMode {
    Kitty,
    #[default]
    Text,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KittyGraphicsEvent {
    pub action: KittyAction,
    pub image_id: Option<u32>,
    pub placement_id: Option<u32>,
    pub columns: Option<u16>,
    pub rows: Option<u16>,
    pub payload: Vec<u8>,
    #[serde(default)]
    pub image_width: u32,
    #[serde(default)]
    pub image_height: u32,
    #[serde(default)]
    pub format: u8,
    #[serde(default)]
    pub column: i32,
    #[serde(default)]
    pub row: i32,
    #[serde(default)]
    pub source_x: u32,
    #[serde(default)]
    pub source_y: u32,
    #[serde(default)]
    pub source_width: u32,
    #[serde(default)]
    pub source_height: u32,
    #[serde(default)]
    pub z: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum KittyAction {
    /// Begins a complete snapshot of currently visible child placements.
    Snapshot,
    Transmit,
    TransmitAndDisplay,
    Place,
    Delete,
    Query,
    Unknown,
}

/// Presentation-side sink kept separate from the streaming terminal engine.
pub trait GraphicsSink {
    type Error;
    fn handle(&mut self, event: KittyGraphicsEvent) -> Result<(), Self::Error>;
    fn clear_child_state(&mut self) -> Result<(), Self::Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeResult {
    Pending,
    Kitty,
    Text,
}

#[derive(Default)]
pub struct ProbeParser {
    bytes: Vec<u8>,
}

impl ProbeParser {
    pub fn feed(&mut self, bytes: &[u8]) -> ProbeResult {
        self.bytes.extend_from_slice(bytes);
        let kitty = format!("\x1b_Gi={PROBE_IMAGE_ID};OK");
        let kitty_at = self
            .bytes
            .windows(kitty.len())
            .position(|w| w == kitty.as_bytes());
        let da_at = self
            .bytes
            .windows(3)
            .position(|w| w == b"\x1b[?" || w == b"\x1b[>")
            .filter(|start| self.bytes[*start..].contains(&b'c'));
        match (kitty_at, da_at) {
            (Some(kitty), Some(da)) if kitty < da => ProbeResult::Kitty,
            (Some(_), Some(_)) | (None, Some(_)) => ProbeResult::Text,
            (Some(_), None) => ProbeResult::Kitty,
            (None, None) => ProbeResult::Pending,
        }
    }
}

pub fn strong_env_hint() -> bool {
    std::env::var("TERM_PROGRAM").is_ok_and(|v| v.eq_ignore_ascii_case("ghostty"))
        || std::env::var_os("KITTY_WINDOW_ID").is_some()
}

/// Probe the controlling terminal while raw mode is active. Bytes not consumed
/// as probe replies are returned for replay to the child PTY.
#[cfg(unix)]
pub fn probe_host(timeout: Duration) -> io::Result<(GraphicsMode, Vec<u8>)> {
    if let Ok(value) = std::env::var("FAMILIAR_GRAPHICS_MODE") {
        let mode = if value.eq_ignore_ascii_case("kitty") {
            GraphicsMode::Kitty
        } else {
            GraphicsMode::Text
        };
        debug_log(&format!("graphics mode forced: {mode:?}"));
        return Ok((mode, Vec::new()));
    }
    if strong_env_hint() {
        debug_log("kitty graphics enabled by environment hint");
        return Ok((GraphicsMode::Kitty, Vec::new()));
    }
    let query = format!("\x1b_Gi={PROBE_IMAGE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c");
    use std::io::Write;
    let mut stdout = io::stdout().lock();
    stdout.write_all(query.as_bytes())?;
    stdout.flush()?;

    let fd = libc::STDIN_FILENO;
    // SAFETY: fcntl/read operate on the process stdin fd; flags are restored.
    let old = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if old < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, old | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let deadline = Instant::now() + timeout;
    let mut parser = ProbeParser::default();
    let mut received = Vec::new();
    let mut result = ProbeResult::Pending;
    while Instant::now() < deadline && result == ProbeResult::Pending {
        let mut buf = [0_u8; 1024];
        let count = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if count > 0 {
            received.extend_from_slice(&buf[..count as usize]);
            result = parser.feed(&buf[..count as usize]);
        } else {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    unsafe { libc::fcntl(fd, libc::F_SETFL, old) };
    let mode = if result == ProbeResult::Kitty {
        GraphicsMode::Kitty
    } else {
        GraphicsMode::Text
    };
    // Probe response controls are not user input. In the uncommon mixed-read
    // case, preserve bytes outside complete terminal response sequences.
    let replay = strip_probe_responses(&received);
    debug_log(&format!("kitty probe result: {mode:?}"));
    Ok((mode, replay))
}

#[cfg(not(unix))]
pub fn probe_host(_: Duration) -> io::Result<(GraphicsMode, Vec<u8>)> {
    Ok((GraphicsMode::Text, Vec::new()))
}

fn strip_probe_responses(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"\x1b_G") {
            if let Some(end) = bytes[i + 3..].windows(2).position(|w| w == b"\x1b\\") {
                i += 3 + end + 2;
                continue;
            }
        }
        if bytes[i..].starts_with(b"\x1b[") {
            if let Some(end) = bytes[i + 2..].iter().position(|b| *b == b'c') {
                i += 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn debug_log(message: &str) {
    let Some(path) = std::env::var_os("FAMILIAR_VIEWER_DEBUG_LOG") else {
        return;
    };
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "{message}");
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Placement {
    child_image: u32,
    placement_id: u32,
    columns: u16,
    rows: u16,
    column: i32,
    row: i32,
    image_width: u32,
    image_height: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    z: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClippedPlacement {
    pub x: u16,
    pub y: u16,
    pub columns: u16,
    pub rows: u16,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
}

pub struct HostGraphics {
    mode: GraphicsMode,
    ids: HashMap<u32, u32>,
    images: HashMap<u32, (u8, u32, u32, Vec<u8>)>,
    uploaded: HashSet<u32>,
    placements: Vec<Placement>,
    next_id: u32,
    generation: u64,
    emitted_generation: u64,
    mark_png: Option<Vec<u8>>,
    mark_uploaded: bool,
    pending_deletes: Vec<u32>,
}

impl HostGraphics {
    pub fn new(mode: GraphicsMode) -> Self {
        Self {
            mode,
            ids: HashMap::new(),
            images: HashMap::new(),
            uploaded: HashSet::new(),
            placements: Vec::new(),
            next_id: CHILD_HOST_ID_BASE,
            generation: 1,
            emitted_generation: 0,
            mark_png: (mode == GraphicsMode::Kitty).then(load_mark_png).flatten(),
            mark_uploaded: false,
            pending_deletes: Vec::new(),
        }
    }

    pub fn mode(&self) -> GraphicsMode {
        self.mode
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn handle_events(&mut self, events: Vec<KittyGraphicsEvent>) {
        if events.is_empty() {
            return;
        }
        let old = self.placements.clone();
        let mut image_changed = false;
        let old_images = old.iter().map(|p| p.child_image).collect::<HashSet<_>>();
        for event in events {
            match event.action {
                KittyAction::Snapshot => self.placements.clear(),
                KittyAction::TransmitAndDisplay | KittyAction::Place => {
                    let Some(child_image) = event.image_id else {
                        continue;
                    };
                    let placement_id = event.placement_id.unwrap_or(0);
                    if !event.payload.is_empty() {
                        let image = (
                            event.format,
                            event.image_width,
                            event.image_height,
                            event.payload,
                        );
                        if self.images.get(&child_image) != Some(&image) {
                            image_changed = true;
                            if let Some(host) = self.ids.get(&child_image) {
                                self.pending_deletes.push(*host);
                                self.uploaded.remove(host);
                            }
                            self.images.insert(child_image, image);
                        }
                    }
                    self.placements.push(Placement {
                        child_image,
                        placement_id,
                        columns: event.columns.unwrap_or(1),
                        rows: event.rows.unwrap_or(1),
                        column: event.column,
                        row: event.row,
                        image_width: event.image_width,
                        image_height: event.image_height,
                        source_x: event.source_x,
                        source_y: event.source_y,
                        source_width: event.source_width,
                        source_height: event.source_height,
                        z: event.z,
                    });
                }
                KittyAction::Delete => {
                    if let Some(id) = event.image_id {
                        self.delete_child(id);
                    }
                }
                _ => {}
            }
        }
        let live_images = self
            .placements
            .iter()
            .map(|p| p.child_image)
            .collect::<HashSet<_>>();
        for child in old_images.difference(&live_images) {
            if let Some(host) = self.ids.get(child) {
                self.pending_deletes.push(*host);
                self.uploaded.remove(host);
            }
            self.images.remove(child);
        }
        if old != self.placements || image_changed {
            self.generation = self.generation.wrapping_add(1);
        }
    }

    fn host_id(&mut self, child: u32) -> u32 {
        if let Some(id) = self.ids.get(&child) {
            return *id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.ids.insert(child, id);
        id
    }

    fn delete_child(&mut self, child: u32) {
        self.placements.retain(|p| p.child_image != child);
        self.images.remove(&child);
        if let Some(host) = self.ids.get(&child) {
            self.pending_deletes.push(*host);
            self.uploaded.remove(host);
        }
        self.generation = self.generation.wrapping_add(1);
    }

    /// The host may discard image storage on alternate-screen clears, zooms,
    /// or resizes. Force data upload (not merely placement replay) next frame.
    pub fn invalidate_host_images(&mut self) {
        self.mark_uploaded = false;
        self.uploaded.clear();
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn clear_child_state(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for id in self.ids.values() {
            let _ = write!(out, "\x1b_Ga=d,d=I,i={id},q=2;\x1b\\");
        }
        self.ids.clear();
        self.images.clear();
        self.uploaded.clear();
        self.placements.clear();
        self.generation = self.generation.wrapping_add(1);
        out
    }

    pub fn emit(&mut self, main: Rect, mark: Rect, full_redraw: bool) -> Vec<u8> {
        if self.mode != GraphicsMode::Kitty {
            return Vec::new();
        }
        let changed = self.emitted_generation != self.generation;
        if !changed && !full_redraw {
            return Vec::new();
        }
        let mut out = Vec::new();
        for id in self.pending_deletes.drain(..) {
            let _ = write!(out, "\x1b_Ga=d,d=I,i={id},q=2;\x1b\\");
        }
        if !self.mark_uploaded {
            if let Some(png) = &self.mark_png {
                encode_data(
                    &mut out,
                    &format!("a=t,t=d,f=100,i={MARK_IMAGE_ID},q=2"),
                    png,
                );
            }
            self.mark_uploaded = self.mark_png.is_some();
        }
        if self.mark_uploaded && mark.width > 0 && mark.height > 0 {
            let _ = write!(
                out,
                "\x1b[{};{}H\x1b_Ga=p,i={MARK_IMAGE_ID},p=1,c={},r={},C=1,q=2;\x1b\\",
                mark.y + 1,
                mark.x + 1,
                mark.width,
                mark.height
            );
        }
        for placement in self.placements.clone() {
            let host_id = self.host_id(placement.child_image);
            if !self.uploaded.contains(&host_id) {
                if let Some((format, width, height, data)) = self.images.get(&placement.child_image)
                {
                    let f = if *format == 0 { 24 } else { 32 };
                    encode_data(
                        &mut out,
                        &format!("a=t,t=d,f={f},s={width},v={height},i={host_id},q=2"),
                        data,
                    );
                    self.uploaded.insert(host_id);
                } else {
                    continue;
                }
            }
            let Some(c) = clip_placement(&placement, main) else {
                continue;
            };
            let _ = write!(out, "\x1b[{};{}H\x1b_Ga=p,i={host_id},p={},c={},r={},z={},C=1,q=2,x={},y={},w={},h={};\x1b\\", c.y + 1, c.x + 1, placement.placement_id, c.columns, c.rows, placement.z, c.source_x, c.source_y, c.source_width, c.source_height);
        }
        self.emitted_generation = self.generation;
        out
    }
}

fn clip_placement(p: &Placement, area: Rect) -> Option<ClippedPlacement> {
    if p.columns == 0 || p.rows == 0 || area.width == 0 || area.height == 0 {
        return None;
    }
    let left = (-p.column).max(0) as u32;
    let top = (-p.row).max(0) as u32;
    let col = p.column.max(0) as u32;
    let row = p.row.max(0) as u32;
    if col >= u32::from(area.width) || row >= u32::from(area.height) {
        return None;
    }
    let cols = u32::from(p.columns)
        .saturating_sub(left)
        .min(u32::from(area.width) - col);
    let rows = u32::from(p.rows)
        .saturating_sub(top)
        .min(u32::from(area.height) - row);
    if cols == 0 || rows == 0 {
        return None;
    }
    let sw = if p.source_width == 0 {
        p.image_width
    } else {
        p.source_width
    };
    let sh = if p.source_height == 0 {
        p.image_height
    } else {
        p.source_height
    };
    let sx = p.source_x + left.saturating_mul(sw) / u32::from(p.columns);
    let sy = p.source_y + top.saturating_mul(sh) / u32::from(p.rows);
    Some(ClippedPlacement {
        x: area.x + col as u16,
        y: area.y + row as u16,
        columns: cols as u16,
        rows: rows as u16,
        source_x: sx,
        source_y: sy,
        source_width: (cols.saturating_mul(sw) / u32::from(p.columns)).max(1),
        source_height: (rows.saturating_mul(sh) / u32::from(p.rows)).max(1),
    })
}

fn encode_data(out: &mut Vec<u8>, control: &str, data: &[u8]) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    for (index, chunk) in encoded.as_bytes().chunks(KITTY_CHUNK).enumerate() {
        let more = index + 1 < encoded.len().div_ceil(KITTY_CHUNK);
        if index == 0 {
            let _ = write!(out, "\x1b_G{control},m={};", u8::from(more));
        } else {
            let _ = write!(out, "\x1b_Gm={};", u8::from(more));
        }
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\x1b\\");
    }
}

fn load_mark_png() -> Option<Vec<u8>> {
    let path = std::env::var_os("FAMILIAR_MARK_PNG")
        .map(PathBuf::from)
        .or_else(|| {
            let mut dir = std::env::current_dir().ok()?;
            loop {
                let candidate = dir.join("assets/familiar-mark.png");
                if candidate.is_file() {
                    return Some(candidate);
                }
                if !dir.pop() {
                    return None;
                }
            }
        });
    path.and_then(|p| fs::read(p).ok())
}

#[allow(dead_code)]
fn _is_png(path: &Path) -> bool {
    path.extension().is_some_and(|x| x == "png")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn placement(col: i32, row: i32, cols: u16, rows: u16) -> Placement {
        Placement {
            child_image: 7,
            placement_id: 3,
            columns: cols,
            rows,
            column: col,
            row,
            image_width: 100,
            image_height: 80,
            source_x: 0,
            source_y: 0,
            source_width: 100,
            source_height: 80,
            z: 0,
        }
    }
    #[test]
    fn probe_kitty_wins() {
        let mut p = ProbeParser::default();
        assert_eq!(p.feed(b"\x1b_Gi=4000000001;O"), ProbeResult::Pending);
        assert_eq!(p.feed(b"K\x1b\\"), ProbeResult::Kitty);
    }
    #[test]
    fn probe_da_first_is_text() {
        let mut p = ProbeParser::default();
        assert_eq!(p.feed(b"\x1b[?1;2c"), ProbeResult::Text);
    }
    #[test]
    fn timeout_remains_negative() {
        assert_eq!(ProbeParser::default().feed(b""), ProbeResult::Pending);
    }
    #[test]
    fn translation_and_right_bottom_clip() {
        let c = clip_placement(&placement(8, 8, 5, 5), Rect::new(28, 2, 10, 10)).unwrap();
        assert_eq!((c.x, c.y, c.columns, c.rows), (36, 10, 2, 2));
    }
    #[test]
    fn clipping_left_and_top_crops_source() {
        let c = clip_placement(&placement(-2, -1, 5, 4), Rect::new(28, 0, 10, 10)).unwrap();
        assert_eq!((c.x, c.y, c.columns, c.rows), (28, 0, 3, 3));
        assert_eq!((c.source_x, c.source_y), (40, 20));
    }
    #[test]
    fn fully_outside_is_dropped() {
        assert!(clip_placement(&placement(-6, 0, 5, 2), Rect::new(0, 0, 10, 10)).is_none());
        assert!(clip_placement(&placement(10, 0, 2, 2), Rect::new(0, 0, 10, 10)).is_none());
    }
    fn event(action: KittyAction) -> KittyGraphicsEvent {
        KittyGraphicsEvent {
            action,
            image_id: Some(7),
            placement_id: Some(9),
            columns: Some(4),
            rows: Some(3),
            payload: vec![255, 0, 0],
            image_width: 4,
            image_height: 3,
            format: 0,
            column: -1,
            row: 1,
            source_x: 0,
            source_y: 0,
            source_width: 4,
            source_height: 3,
            z: 2,
        }
    }

    #[test]
    fn ids_are_remapped_and_delete_propagates() {
        let mut h = HostGraphics::new(GraphicsMode::Kitty);
        let a = h.host_id(9);
        assert_ne!(a, 9);
        h.ids.insert(10, a + 1);
        let bytes = h.clear_child_state();
        assert!(String::from_utf8_lossy(&bytes).contains(&format!("i={a}")));
    }

    #[test]
    fn mark_data_is_retransmitted_after_switch_and_resize_invalidation() {
        let mut h = HostGraphics::new(GraphicsMode::Kitty);
        h.mark_png = Some(vec![1, 2, 3]);
        let main = Rect::new(28, 0, 72, 30);
        let mark = Rect::new(0, 0, 28, 12);
        let first = String::from_utf8_lossy(&h.emit(main, mark, true)).into_owned();
        assert!(first.contains(&format!("a=t,t=d,f=100,i={MARK_IMAGE_ID}")));
        assert!(first.contains(&format!("a=p,i={MARK_IMAGE_ID}")));

        h.clear_child_state();
        h.invalidate_host_images();
        let switched = String::from_utf8_lossy(&h.emit(main, mark, true)).into_owned();
        assert!(switched.contains(&format!("a=t,t=d,f=100,i={MARK_IMAGE_ID}")));
        assert!(switched.contains(&format!("a=p,i={MARK_IMAGE_ID}")));

        h.invalidate_host_images();
        let resized = String::from_utf8_lossy(&h.emit(main, mark, true)).into_owned();
        assert!(resized.contains(&format!("a=t,t=d,f=100,i={MARK_IMAGE_ID}")));
        assert!(resized.contains(&format!("a=p,i={MARK_IMAGE_ID}")));
    }

    #[test]
    fn kitty_emission_remaps_translates_clips_and_switch_deletes() {
        let mut h = HostGraphics::new(GraphicsMode::Kitty);
        h.mark_png = None;
        h.handle_events(vec![
            event(KittyAction::Snapshot),
            event(KittyAction::TransmitAndDisplay),
        ]);
        let bytes = h.emit(Rect::new(28, 0, 20, 10), Rect::default(), false);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("i=1000000"));
        assert!(text.contains("\x1b[2;29H"));
        assert!(text.contains("c=3,r=3"));
        assert!(text.contains("x=1,y=0,w=3,h=3"));

        h.handle_events(vec![event(KittyAction::Snapshot)]);
        let deleted = h.emit(Rect::new(28, 0, 20, 10), Rect::default(), false);
        assert!(String::from_utf8_lossy(&deleted).contains("a=d,d=I,i=1000000"));
    }
}
