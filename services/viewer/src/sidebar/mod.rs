//! Native Familiar jobs chrome: registry polling, liveness, frame rows, and rendering.

use crate::app::ViewerTarget;
use crate::input::SidebarHit;
use crate::pty::sanitize_agent_id;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

pub const POLL_INTERVAL: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_JOBS: usize = 10;

// Kept together to mirror services/presence/sidebar.sh. Gateway theme-role
// parity should replace these literal colors in a future theme integration.
const RUNNING: Color = Color::Rgb(70, 200, 120);
const DONE: Color = Color::Rgb(90, 212, 230);
const FAILED: Color = Color::Rgb(235, 90, 90);
const UNKNOWN: Color = Color::Rgb(230, 190, 70);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Job {
    pub id: String,
    pub workspace: String,
    pub label: String,
    pub state: String,
    pub updated_at: String,
    pub live: bool,
}

impl Job {
    pub fn terminal(&self) -> bool {
        is_terminal(&self.state)
    }

    pub fn clickable(&self) -> bool {
        self.live && !self.terminal()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SidebarModel {
    pub jobs: Vec<Job>,
    /// False means the last poll failed; `jobs` remains the last good snapshot.
    pub available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrameRowKind {
    Heading,
    Workspace,
    Job { id: String, clickable: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameRow {
    pub kind: FrameRowKind,
    pub text: String,
    pub style: Style,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RowModel {
    pub rows: Vec<FrameRow>,
}

impl RowModel {
    pub fn hit(&self, row: usize) -> SidebarHit {
        match self.rows.get(row).map(|row| &row.kind) {
            Some(FrameRowKind::Job {
                id: _,
                clickable: true,
            }) => SidebarHit::JobRow(row),
            _ => SidebarHit::Dead,
        }
    }

    pub fn agent_for_row(&self, row: usize) -> Option<String> {
        match self.rows.get(row).map(|row| &row.kind) {
            Some(FrameRowKind::Job {
                id,
                clickable: true,
            }) => Some(id.clone()),
            _ => None,
        }
    }
}

pub fn parse_jobs(bytes: &[u8]) -> Result<Vec<Job>, serde_json::Error> {
    let value: Value = serde_json::from_slice(bytes)?;
    let Some(values) = value.as_array() else {
        return Err(serde_json::Error::io(io::Error::new(
            io::ErrorKind::InvalidData,
            "jobs response is not an array",
        )));
    };
    let mut active = Vec::new();
    let mut terminal = Vec::new();
    for value in values {
        let state = string_field(value, "state", "unknown");
        let cwd = string_field(value, "cwd", "");
        let prompt = normalize_whitespace(&string_field(value, "prompt", ""));
        let id = string_field(value, "id", "");
        let label_id = string_field(value, "id", "job");
        let job = Job {
            label: derive_label(&prompt, &label_id),
            workspace: workspace(&cwd),
            updated_at: string_field(value, "updated_at", ""),
            id,
            state: state.clone(),
            live: false,
        };
        if is_terminal(&state) {
            terminal.push(job);
        } else {
            active.push(job);
        }
    }
    active.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    terminal.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    active.extend(terminal);
    active.truncate(MAX_JOBS);

    // jq's group_by(.workspace) orders groups lexically while preserving the
    // already-established ordering inside each workspace.
    let mut groups: BTreeMap<String, Vec<Job>> = BTreeMap::new();
    for job in active {
        groups.entry(job.workspace.clone()).or_default().push(job);
    }
    Ok(groups.into_values().flatten().collect())
}

fn string_field(value: &Value, field: &str, default: &str) -> String {
    match value.get(field).filter(|value| !value.is_null()) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
        None => default.into(),
    }
}

pub fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn derive_label(prompt: &str, id: &str) -> String {
    let prompt = normalize_whitespace(prompt);
    if !prompt.is_empty() {
        prompt.chars().take(16).collect()
    } else {
        let tail = id.rsplit('-').next().unwrap_or("job");
        let chars: Vec<_> = tail.chars().collect();
        chars[chars.len().saturating_sub(8)..].iter().collect()
    }
}

fn workspace(cwd: &str) -> String {
    let name = cwd
        .split('/')
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("unknown");
    let clean = normalize_whitespace(name);
    if clean.is_empty() {
        "unknown".into()
    } else {
        clean
    }
}

pub fn is_terminal(state: &str) -> bool {
    matches!(state, "done" | "error" | "failed" | "cancelled" | "timeout")
}

pub fn apply_live_sessions(jobs: &mut [Job], sessions: &HashSet<String>) {
    for job in jobs {
        job.live = sessions.contains(&format!("worker-{}", sanitize_agent_id(&job.id)));
    }
}

pub fn list_sessions(socket: &Path) -> HashSet<String> {
    let output = Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(["list-sessions", "-F", "#{session_name}"])
        .output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_owned)
            .collect(),
        _ => HashSet::new(),
    }
}

pub fn has_live_session(socket: &Path, id: &str) -> bool {
    Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args([
            "has-session",
            "-t",
            &format!("=worker-{}", sanitize_agent_id(id)),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub fn spawn_poller(endpoint: String, socket: PathBuf) -> Receiver<SidebarModel> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut last_good = Vec::new();
        loop {
            let snapshot = match fetch_jobs(&endpoint).and_then(|bytes| {
                parse_jobs(&bytes)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
            }) {
                Ok(mut jobs) => {
                    apply_live_sessions(&mut jobs, &list_sessions(&socket));
                    last_good = jobs;
                    SidebarModel {
                        jobs: last_good.clone(),
                        available: true,
                    }
                }
                Err(_) => SidebarModel {
                    jobs: last_good.clone(),
                    available: false,
                },
            };
            if tx.send(snapshot).is_err() {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
    rx
}

fn fetch_jobs(endpoint: &str) -> io::Result<Vec<u8>> {
    let endpoint = endpoint.trim_end_matches('/');
    let rest = endpoint.strip_prefix("http://").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "only http agents endpoints are supported",
        )
    })?;
    let (authority, base_path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = authority
        .rsplit_once(':')
        .and_then(|(host, port)| port.parse::<u16>().ok().map(|port| (host, port)))
        .unwrap_or((authority, 80));
    let address = (host, port).to_socket_addrs()?.next().ok_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "endpoint has no address")
    })?;
    let mut stream = TcpStream::connect_timeout(&address, REQUEST_TIMEOUT)?;
    stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    stream.set_write_timeout(Some(REQUEST_TIMEOUT))?;
    let path = if base_path.is_empty() {
        "/v1/jobs".to_owned()
    } else {
        format!("/{base_path}/v1/jobs")
    };
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    )?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP response"))?;
    let headers = &response[..header_end];
    let status = headers.split(|byte| *byte == b' ').nth(1);
    if status != Some(b"200") {
        return Err(io::Error::other("jobs endpoint unavailable"));
    }
    let body = &response[header_end + 4..];
    if is_chunked(headers) {
        decode_chunked(body)
    } else {
        Ok(body.to_vec())
    }
}

/// True when the response headers declare `Transfer-Encoding: chunked`
/// (case-insensitive). The agents service answers HTTP/1.1 GETs with
/// chunked framing, which must be stripped before JSON parsing.
fn is_chunked(headers: &[u8]) -> bool {
    headers.split(|byte| *byte == b'\n').any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with(b"transfer-encoding:") && {
            let value = &line[b"transfer-encoding:".len()..];
            String::from_utf8_lossy(value).contains("chunked")
        }
    })
}

/// Minimal HTTP/1.1 chunked-transfer decoder: hex size line, payload,
/// CRLF, repeated until a zero-size chunk. Trailers are ignored.
fn decode_chunked(mut body: &[u8]) -> io::Result<Vec<u8>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid chunked body");
    let mut decoded = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(invalid)?;
        let size_token = std::str::from_utf8(&body[..line_end])
            .map_err(|_| invalid())?
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let size = usize::from_str_radix(size_token, 16).map_err(|_| invalid())?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if body.len() < size + 2 {
            return Err(invalid());
        }
        decoded.extend_from_slice(&body[..size]);
        if &body[size..size + 2] != b"\r\n" {
            return Err(invalid());
        }
        body = &body[size + 2..];
    }
}

pub fn rows_for(model: &SidebarModel, target: &ViewerTarget, height: u16, width: u16) -> RowModel {
    if height == 0 || width == 0 {
        return RowModel::default();
    }
    let dim = Style::default().add_modifier(Modifier::DIM);
    let mut rows = vec![FrameRow {
        kind: FrameRowKind::Heading,
        text: if model.available {
            "agents".into()
        } else {
            "agents  unavailable".into()
        },
        style: dim,
    }];
    let mut previous = None;
    for (index, job) in model.jobs.iter().enumerate() {
        if previous != Some(job.workspace.as_str()) {
            rows.push(FrameRow {
                kind: FrameRowKind::Workspace,
                text: truncate(&job.workspace, width as usize),
                style: Style::default(),
            });
            previous = Some(&job.workspace);
        }
        let last_in_group = model
            .jobs
            .get(index + 1)
            .is_none_or(|next| next.workspace != job.workspace);
        let connector = if last_in_group { "└─" } else { "├─" };
        let active = matches!(target, ViewerTarget::Agent(id) if id == &job.id);
        let glyph = if active { '◉' } else { '●' };
        let prefix = format!("{connector} {glyph} ");
        let state_width = job.state.chars().count();
        let available = (width as usize).saturating_sub(prefix.chars().count() + state_width + 1);
        let label = truncate(&job.label, available.max(1));
        let text = format!("{prefix}{label} {}", job.state);
        let style = if !job.clickable() {
            state_style(&job.state).add_modifier(Modifier::DIM)
        } else {
            state_style(&job.state)
        };
        rows.push(FrameRow {
            kind: FrameRowKind::Job {
                id: job.id.clone(),
                clickable: job.clickable(),
            },
            text: truncate(&text, width as usize),
            style,
        });
    }
    rows.truncate(height as usize);
    RowModel { rows }
}

fn state_style(state: &str) -> Style {
    match state {
        "running" => Style::default().fg(RUNNING),
        "done" => Style::default().fg(DONE),
        "error" | "failed" | "timeout" => Style::default().fg(FAILED),
        "cancelled" => Style::default().add_modifier(Modifier::DIM),
        _ => Style::default().fg(UNKNOWN),
    }
}

fn truncate(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.into();
    }
    if width == 0 {
        return String::new();
    }
    value
        .chars()
        .take(width - 1)
        .chain(std::iter::once('…'))
        .collect()
}

pub fn render(rows: &RowModel, area: Rect, buffer: &mut ratatui::buffer::Buffer) {
    let lines: Vec<_> = rows
        .rows
        .iter()
        .map(|row| Line::from(Span::styled(row.text.clone(), row.style)))
        .collect();
    Paragraph::new(lines).render(area, buffer);
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"[
      {"id":"job-active","cwd":"/work/alpha","prompt":"Fix\nsidebar","state":"running","updated_at":"2026-08-22T07:30:00Z"},
      {"id":"job-blocked","cwd":"/work/alpha","prompt":"Need input","state":"blocked","updated_at":"2026-08-22T07:20:00Z"},
      {"id":"job-abcdefgh","cwd":"/work/beta","prompt":"  ","state":"done","updated_at":"2026-08-22T07:40:00Z"},
      {"id":"job-old","cwd":"/work/alpha","prompt":"Old task","state":"cancelled","updated_at":"2026-08-22T07:10:00Z"}
    ]"#;

    #[test]
    fn chunked_transfer_encoding_is_detected_and_decoded() {
        assert!(is_chunked(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r"
        ));
        assert!(is_chunked(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r"
        ));
        assert!(!is_chunked(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r"));

        // "[{}]" split across two chunks, with a chunk extension and trailer.
        let body = b"2;ext=1\r\n[{\r\n2\r\n}]\r\n0\r\nTrailer: x\r\n\r\n";
        assert_eq!(decode_chunked(body).unwrap(), b"[{}]");

        assert!(decode_chunked(b"zz\r\nbad").is_err());
        assert!(decode_chunked(b"5\r\nshort").is_err());
    }

    #[test]
    fn bash_fixture_has_grouping_order_and_labels() {
        let jobs = parse_jobs(FIXTURE.as_bytes()).unwrap();
        assert_eq!(
            jobs.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
            ["job-active", "job-blocked", "job-old", "job-abcdefgh"]
        );
        assert_eq!(
            jobs.iter()
                .map(|job| job.workspace.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "alpha", "alpha", "beta"]
        );
        assert_eq!(jobs[0].label, "Fix sidebar");
        assert_eq!(jobs[3].label, "abcdefgh");
    }

    #[test]
    fn malformed_non_array_and_empty_are_tolerated() {
        assert!(parse_jobs(b"not json").is_err());
        assert!(parse_jobs(br#"{"jobs":[]}"#).is_err());
        assert!(parse_jobs(b"[]").unwrap().is_empty());
    }

    #[test]
    fn labels_cover_whitespace_empty_prompt_short_id_and_unicode() {
        assert_eq!(
            derive_label("  one\n two\tthree ", "ignored"),
            "one two three"
        );
        assert_eq!(derive_label("", "job-id"), "id");
        assert_eq!(derive_label("", "x"), "x");
        assert_eq!(derive_label("abcdefghijklmnopQ", "x"), "abcdefghijklmnop");
    }

    #[test]
    fn active_precedes_terminal_and_total_is_capped() {
        let values: Vec<_> = (0..12)
            .map(|index| {
                serde_json::json!({
                    "id": format!("job-{index}"), "cwd": "/z", "prompt": "p",
                    "state": if index == 11 { "running" } else { "done" },
                    "updated_at": format!("{index:02}")
                })
            })
            .collect();
        let jobs = parse_jobs(serde_json::to_string(&values).unwrap().as_bytes()).unwrap();
        assert_eq!(jobs.len(), 10);
        assert_eq!(jobs[0].id, "job-11");
    }

    #[test]
    fn sanitized_names_drive_liveness() {
        let mut jobs = vec![Job {
            id: "a b/c".into(),
            workspace: "w".into(),
            label: "l".into(),
            state: "running".into(),
            updated_at: String::new(),
            live: false,
        }];
        apply_live_sessions(&mut jobs, &HashSet::from(["worker-a-b-c".into()]));
        assert!(jobs[0].live);
    }

    #[test]
    fn rendered_row_and_hit_test_share_the_same_index() {
        let mut jobs = parse_jobs(FIXTURE.as_bytes()).unwrap();
        jobs[0].live = true;
        jobs[1].live = false;
        let rows = rows_for(
            &SidebarModel {
                jobs,
                available: true,
            },
            &ViewerTarget::Presence,
            20,
            28,
        );
        assert_eq!(rows.hit(2), SidebarHit::JobRow(2));
        assert_eq!(rows.agent_for_row(2).as_deref(), Some("job-active"));
        assert_eq!(rows.hit(3), SidebarHit::Dead);
        assert_eq!(rows.agent_for_row(3), None);
    }
}
