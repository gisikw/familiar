//! Familiar-owned rendering of a bounded plugin semantic tree.
use crate::app::ViewerTarget;
use crate::input::SidebarHit;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};
use serde::Deserialize;
use std::{
    collections::HashSet,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BYTES: usize = 256 << 10;
const MAX_NODES: usize = 512;
const MAX_DEPTH: usize = 8;
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Activation {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub socket: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub action: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    kind: String,
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    status: String,
    children: Option<Vec<Node>>,
    activation: Option<Activation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    render_api: u8,
    revision: u64,
    ttl_ms: u64,
    target: String,
    content: Node,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Item {
    pub id: String,
    pub workspace: String,
    pub label: String,
    pub status: String,
    pub activation: Option<Activation>,
}
impl Item {
    fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "done" | "error" | "failed" | "cancelled" | "timeout"
        )
    }
    pub fn target(&self) -> Option<ViewerTarget> {
        self.activation
            .as_ref()
            .filter(|a| a.kind == "terminal")
            .map(|a| ViewerTarget::Terminal {
                id: self.id.clone(),
                socket: a.socket.clone(),
                session: a.session.clone(),
            })
    }
}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SidebarModel {
    pub label: Option<String>,
    pub items: Vec<Item>,
    pub available: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrameRowKind {
    Heading,
    Workspace,
    Item { target: Option<ViewerTarget> },
    Action { action: String },
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
        match self.rows.get(row).map(|x| &x.kind) {
            Some(FrameRowKind::Item { target: Some(_) }) => SidebarHit::JobRow(row),
            Some(FrameRowKind::Action { .. }) => SidebarHit::ActionRow(row),
            _ => SidebarHit::Dead,
        }
    }
    pub fn target_for_row(&self, row: usize) -> Option<ViewerTarget> {
        match self.rows.get(row).map(|x| &x.kind) {
            Some(FrameRowKind::Item { target }) => target.clone(),
            _ => None,
        }
    }
    pub fn action_for_row(&self, row: usize) -> Option<&str> {
        match self.rows.get(row).map(|x| &x.kind) {
            Some(FrameRowKind::Action { action }) => Some(action),
            _ => None,
        }
    }
}
pub fn parse_render(bytes: &[u8]) -> io::Result<SidebarModel> {
    if bytes.len() > MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "render too large",
        ));
    }
    let e: Envelope =
        serde_json::from_slice(bytes).map_err(|x| io::Error::new(io::ErrorKind::InvalidData, x))?;
    if e.render_api != 1 || e.target != "left-nav" || e.ttl_ms == 0 || e.content.kind != "tree" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported render envelope",
        ));
    }
    let _ = (e.revision, e.ttl_ms);
    let mut seen = HashSet::new();
    let mut count = 0;
    let mut items = vec![];
    fn walk(
        n: &Node,
        depth: usize,
        workspace: &str,
        seen: &mut HashSet<String>,
        count: &mut usize,
        out: &mut Vec<Item>,
    ) -> io::Result<()> {
        *count += 1;
        if depth > MAX_DEPTH
            || *count > MAX_NODES
            || n.id.is_empty()
            || n.id.len() > 256
            || n.label.len() > 256
            || !seen.insert(n.id.clone())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed render tree",
            ));
        }
        match n.kind.as_str() {
            "tree" | "branch" => {
                if n.activation.is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "branch activation",
                    ));
                }
                let next = if n.kind == "branch" && !n.label.is_empty() {
                    n.label.as_str()
                } else {
                    workspace
                };
                for c in n
                    .children
                    .as_ref()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing children"))?
                {
                    walk(c, depth + 1, next, seen, count, out)?
                }
            }
            "item" => {
                if n.children.is_some() {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "item children"));
                }
                if let Some(a) = &n.activation {
                    let valid = match a.kind.as_str() {
                        "terminal" => {
                            Path::new(&a.socket).is_absolute()
                                && !a.session.is_empty()
                                && a.session.len() <= 128
                                && a.action.is_empty()
                        }
                        "action" => {
                            a.socket.is_empty()
                                && a.session.is_empty()
                                && !a.action.is_empty()
                                && a.action.len() <= 256
                                && a.action.chars().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')
                                })
                        }
                        _ => false,
                    };
                    if !valid {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "unsafe activation",
                        ));
                    }
                }
                out.push(Item {
                    id: n.id.clone(),
                    workspace: workspace.into(),
                    label: n.label.clone(),
                    status: n.status.clone(),
                    activation: n.activation.clone(),
                })
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "node kind")),
        }
        Ok(())
    }
    walk(&e.content, 1, "", &mut seen, &mut count, &mut items)?;
    Ok(SidebarModel {
        label: (!e.content.label.is_empty()).then_some(e.content.label),
        items,
        available: true,
    })
}
/// The plan the viewer executes for a sidebar click. Keeping this pure makes
/// the actionable-click and visible-failure behaviors directly testable without
/// a live terminal or PTY.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivationPlan {
    /// No actionable target (dead/nonclickable row, or already current).
    Ignore,
    /// Actionable, but the exact terminal is gone at click time. The viewer
    /// must surface this as a visible, bounded sidebar notice — never a silent
    /// no-op.
    Notice(String),
    /// Invoke the spawn-first writable switch to this unmodified target.
    Switch(ViewerTarget),
}
/// Decides what a sidebar click should do. `live` re-checks the exact same-host
/// terminal target and closes the poll-to-click race; a dead target yields a
/// visible notice rather than a silent drop.
pub fn plan_activation<F>(
    hit_target: Option<ViewerTarget>,
    current: &ViewerTarget,
    live: F,
) -> ActivationPlan
where
    F: FnOnce(&str, &str) -> bool,
{
    let Some(target) = hit_target else {
        return ActivationPlan::Ignore;
    };
    if &target == current {
        return ActivationPlan::Ignore;
    }
    if let ViewerTarget::Terminal {
        socket, session, ..
    } = &target
    {
        if !live(socket, session) {
            return ActivationPlan::Notice("Terminal is no longer available".into());
        }
    }
    ActivationPlan::Switch(target)
}
pub fn terminal_live(a: &Activation) -> bool {
    Command::new("tmux")
        .arg("-S")
        .arg(&a.socket)
        .args(["has-session", "-t", &format!("={}", a.session)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
pub fn spawn_poller(endpoint: Option<String>) -> Receiver<SidebarModel> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let Some(endpoint) = endpoint else { return };
        let mut last = SidebarModel::default();
        let mut revision = 0;
        loop {
            let path = format!(
                "{}{}revision={revision}",
                endpoint,
                if endpoint.contains('?') { "&" } else { "?" }
            );
            match fetch(&path).and_then(|(b, r)| parse_render(&b).map(|m| (m, r))) {
                Ok((mut m, r)) => {
                    for i in &mut m.items {
                        if i.activation
                            .as_ref()
                            .is_some_and(|a| a.kind == "terminal" && !terminal_live(a))
                        {
                            i.activation = None
                        }
                    }
                    revision = r;
                    last = m
                }
                Err(_) => last.available = false,
            }
            if tx.send(last.clone()).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(50))
        }
    });
    rx
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionOutcome { Complete, Partial }

pub fn invoke_action(endpoint: &str, action: &str) -> io::Result<ActionOutcome> {
    if action.is_empty()
        || !action
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe action"));
    }
    let base = endpoint
        .split('?')
        .next()
        .unwrap_or(endpoint)
        .trim_end_matches('/');
    let target = format!("{base}/action/{action}");
    let rest = target
        .strip_prefix("http://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "only http action URLs"))?;
    let split = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..split];
    let path = &rest[split..];
    let (host, port) = authority
        .rsplit_once(':')
        .and_then(|(h, p)| p.parse().ok().map(|p| (h, p)))
        .unwrap_or((authority, 80));
    let addr = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no address"))?;
    let mut s = TcpStream::connect_timeout(&addr, REQUEST_TIMEOUT)?;
    s.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    write!(s, "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
    let mut response = Vec::new();
    s.take(4096).read_to_end(&mut response)?;
    let end = response.windows(4).position(|x| x == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "action response"))?;
    let status = String::from_utf8_lossy(&response[..end]);
    if !status.starts_with("HTTP/1.1 2") && !status.starts_with("HTTP/1.0 2") {
        return Err(io::Error::other("action failed"));
    }
    #[derive(Deserialize)]
    struct ResultBody { #[serde(default)] failed: usize }
    let body: ResultBody = serde_json::from_slice(&response[end + 4..]).unwrap_or(ResultBody { failed: 0 });
    Ok(if body.failed > 0 { ActionOutcome::Partial } else { ActionOutcome::Complete })
}

fn fetch(endpoint: &str) -> io::Result<(Vec<u8>, u64)> {
    let rest = endpoint
        .strip_prefix("http://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "only http render URLs"))?;
    let split = rest.find(|c| c == '/' || c == '?').unwrap_or(rest.len());
    let authority = &rest[..split];
    let suffix = &rest[split..];
    let path = if suffix.starts_with('/') {
        suffix.to_owned()
    } else {
        format!("/{suffix}")
    };
    let (host, port) = authority
        .rsplit_once(':')
        .and_then(|(h, p)| p.parse().ok().map(|p| (h, p)))
        .unwrap_or((authority, 80));
    let addr = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no address"))?;
    let mut s = TcpStream::connect_timeout(&addr, REQUEST_TIMEOUT)?;
    s.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
    )?;
    let mut r = Vec::new();
    s.take((MAX_BYTES + 8192) as u64).read_to_end(&mut r)?;
    let end = r
        .windows(4)
        .position(|x| x == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "HTTP"))?;
    let h = &r[..end];
    if h.split(|x| *x == b' ').nth(1) != Some(b"200") {
        return Err(io::Error::other("render unavailable"));
    }
    let headers = String::from_utf8_lossy(h);
    let rev = header_value(&headers, "x-familiar-revision")
        .and_then(|x| x.parse().ok())
        .unwrap_or(0);
    let body = &r[end + 4..];
    let body = if header_value(&headers, "transfer-encoding")
        .is_some_and(|value| value.split(',').any(|part| part.trim().eq_ignore_ascii_case("chunked")))
    {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    if body.len() > MAX_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "render too large"));
    }
    Ok((body, rev))
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn decode_chunked(mut input: &[u8]) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let line_end = input
            .windows(2)
            .position(|bytes| bytes == b"\r\n")
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "HTTP chunk size"))?;
        let size_text = std::str::from_utf8(&input[..line_end])
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or(""), 16)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(output);
        }
        if size > MAX_BYTES.saturating_sub(output.len())
            || input.len() < size + 2
            || &input[size..size + 2] != b"\r\n"
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP chunk body"));
        }
        output.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
}
pub fn rows_for(m: &SidebarModel, target: &ViewerTarget, height: u16, width: u16) -> RowModel {
    if height == 0 || width == 0 || m.items.is_empty() && m.label.is_none() {
        return RowModel::default();
    }
    let mut rows = vec![];
    if let Some(label) = &m.label {
        rows.push(FrameRow {
            kind: FrameRowKind::Heading,
            text: if m.available {
                label.clone()
            } else {
                format!("{label}  unavailable")
            },
            style: Style::default().add_modifier(Modifier::DIM),
        })
    }
    let mut prior = "";
    let mut visible: Vec<_> = m
        .items
        .iter()
        .filter(|i| i.activation.as_ref().is_none_or(|a| a.kind != "action"))
        .collect();
    // Retained settled jobs can outnumber the viewport. Project live/current
    // rows before settled history so a busy earlier workspace cannot push a
    // newly dispatched job in a later workspace below the hard truncation.
    // Stable sorting preserves renderer order within both groups.
    visible.sort_by_key(|item| {
        let active = matches!(target, ViewerTarget::Terminal { id, .. } if id == &item.id);
        usize::from(!active && item.terminal())
    });
    for (i, item) in visible.iter().enumerate() {
        if item.workspace != prior {
            rows.push(FrameRow {
                kind: FrameRowKind::Workspace,
                text: truncate(&item.workspace, width as usize),
                style: Style::default(),
            });
            prior = &item.workspace
        }
        let last = visible
            .get(i + 1)
            .is_none_or(|n| n.workspace != item.workspace);
        let active = matches!(target,ViewerTarget::Terminal{id,..}if id==&item.id);
        let prefix = format!(
            "{} {} ",
            if last { "└─" } else { "├─" },
            if active { '◉' } else { '●' }
        );
        let text = match status_suffix(&item.status) {
            Some(status) => format!("{prefix}{} {status}", item.label),
            None if item.terminal() && item.activation.is_none() => {
                format!("{prefix}{} (reaped)", item.label)
            }
            None => format!("{prefix}{}", item.label),
        };
        let mut style = state_style(&item.status);
        // Fade rows the user cannot act on, and settled rows that are still
        // clickable during their retained tmux lifetime: a done-but-not-reaped
        // row reads as inactive (DIM + its state color) while staying
        // clickable, but failure/cancel colors survive so distinctions remain.
        // Active/running rows with a live terminal keep their bright color.
        if item.activation.is_none() || item.terminal() {
            style = style.add_modifier(Modifier::DIM)
        }
        rows.push(FrameRow {
            kind: FrameRowKind::Item {
                target: item.target(),
            },
            text: truncate(&text, width as usize),
            style,
        })
    }
    if let Some(action) = m.items.iter().find_map(|i| {
        i.activation
            .as_ref()
            .filter(|a| a.kind == "action")
            .map(|a| a.action.clone())
    }) {
        // Reserve the bottom three rows so the manual retirement control is
        // present even when the bounded job list fills the sidebar.
        rows.truncate(height.saturating_sub(3) as usize);
        let inner = width.saturating_sub(2) as usize;
        let label = "Retire Golems";
        rows.push(FrameRow {
            kind: FrameRowKind::Workspace,
            text: format!("┌{}┐", "─".repeat(inner)),
            style: Style::default().add_modifier(Modifier::DIM),
        });
        rows.push(FrameRow {
            kind: FrameRowKind::Action { action },
            text: truncate(&format!("│{:^inner$}│", label), width as usize),
            style: Style::default().add_modifier(Modifier::BOLD),
        });
        rows.push(FrameRow {
            kind: FrameRowKind::Workspace,
            text: format!("└{}┘", "─".repeat(inner)),
            style: Style::default().add_modifier(Modifier::DIM),
        });
    }
    rows.truncate(height as usize);
    RowModel { rows }
}
fn state_style(s: &str) -> Style {
    match s {
        "running" => Style::default().fg(Color::Indexed(2)),
        "done" => Style::default().fg(Color::Indexed(6)),
        "error" | "failed" | "timeout" => Style::default().fg(Color::Indexed(1)),
        "cancelled" => Style::default().add_modifier(Modifier::DIM),
        _ => Style::default().fg(Color::Indexed(3)),
    }
}
/// The colored dot alone conveys `running` (green) and `done` (cyan), so their
/// textual labels are redundant and dropped. States that share or lack a
/// distinctive color keep their text: error/failed/timeout all render red,
/// cancelled has no color of its own, and blocked/unknown states carry
/// actionable information the dot cannot.
fn status_suffix(s: &str) -> Option<&str> {
    match s {
        "running" | "done" | "" => None,
        other => Some(other),
    }
}
fn truncate(s: &str, w: usize) -> String {
    if s.chars().count() <= w {
        return s.into();
    }
    if w == 0 {
        return String::new();
    }
    s.chars().take(w - 1).chain(std::iter::once('…')).collect()
}
pub fn render(rows: &RowModel, area: Rect, b: &mut ratatui::buffer::Buffer) {
    Paragraph::new(
        rows.rows
            .iter()
            .map(|r| Line::from(Span::styled(r.text.clone(), r.style)))
            .collect::<Vec<_>>(),
    )
    .render(area, b)
}
#[cfg(test)]
mod tests {
    use super::*;
    const OK: &str = r#"{"render_api":1,"revision":2,"ttl_ms":1000,"target":"left-nav","content":{"kind":"tree","id":"root","label":"agents","children":[{"kind":"branch","id":"w","label":"alpha","children":[{"kind":"item","id":"j","label":"Fix sidebar","status":"running","activation":{"type":"terminal","socket":"/run/g.sock","session":"worker-j"}}]}]}}"#;
    #[test]
    fn chunked_render_body_decodes_before_json_parsing() {
        let split = OK.len() / 2;
        let wire = format!(
            "{:x}\r\n{}\r\n{:x};ext=ignored\r\n{}\r\n0\r\n\r\n",
            split,
            &OK[..split],
            OK.len() - split,
            &OK[split..]
        );
        let decoded = decode_chunked(wire.as_bytes()).unwrap();
        assert_eq!(parse_render(&decoded).unwrap().items[0].id, "j");
        assert_eq!(
            header_value("Transfer-Encoding: chunked\r\n", "transfer-encoding"),
            Some("chunked")
        );
    }

    #[test]
    fn semantic_tree_parses() {
        let m = parse_render(OK.as_bytes()).unwrap();
        assert_eq!(m.label.as_deref(), Some("agents"));
        assert_eq!(m.items[0].workspace, "alpha");
        assert!(m.items[0].target().is_some())
    }
    #[test]
    fn malformed_target_duplicate_and_relative_socket_rejected() {
        assert!(parse_render(OK.replace("left-nav", "right").as_bytes()).is_err());
        assert!(parse_render(OK.replace("\"id\":\"j\"", "\"id\":\"w\"").as_bytes()).is_err());
        assert!(parse_render(OK.replace("/run/g.sock", "relative").as_bytes()).is_err())
    }
    #[test]
    fn dead_item_nonclickable() {
        let mut m = parse_render(OK.as_bytes()).unwrap();
        m.items[0].activation = None;
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 28);
        assert!(r.target_for_row(2).is_none())
    }

    // The host aggregate composes multiple plugins under one tree with
    // namespaced ("plugin/id") node IDs, while activation socket/session stay
    // exact. The viewer must parse this and preserve the unmodified tmux target.
    const AGGREGATE: &str = r#"{"render_api":1,"revision":7,"ttl_ms":1000,"target":"left-nav","content":{"kind":"tree","id":"root","children":[{"kind":"branch","id":"golem/root","label":"golem","children":[{"kind":"branch","id":"golem/b","label":"alpha","children":[{"kind":"item","id":"golem/i","label":"one","status":"running","activation":{"type":"terminal","socket":"/run/g.sock","session":"worker-a"}}]}]},{"kind":"branch","id":"second/root","label":"second","children":[{"kind":"branch","id":"second/b","label":"beta","children":[{"kind":"item","id":"second/i","label":"two","status":"running","activation":{"type":"terminal","socket":"/run/s.sock","session":"worker-b"}}]}]}]}}"#;
    #[test]
    fn aggregate_multiple_plugins_parse_with_namespaced_ids_and_exact_targets() {
        let m = parse_render(AGGREGATE.as_bytes()).unwrap();
        assert_eq!(m.items.len(), 2);
        assert_eq!(m.items[0].id, "golem/i");
        assert_eq!(m.items[1].id, "second/i");
        // The exact same-host tmux target survives namespacing.
        match m.items[1].target().unwrap() {
            ViewerTarget::Terminal {
                id,
                socket,
                session,
            } => {
                assert_eq!(id, "second/i");
                assert_eq!(socket, "/run/s.sock");
                assert_eq!(session, "worker-b");
            }
            other => panic!("unexpected target {other:?}"),
        }
    }

    #[test]
    fn plan_activation_switches_to_exact_unmodified_target() {
        let target = ViewerTarget::Terminal {
            id: "golem/i".into(),
            socket: "/run/g.sock".into(),
            session: "worker-a".into(),
        };
        let plan = plan_activation(Some(target.clone()), &ViewerTarget::Presence, |s, sess| {
            // Actionable: the exact target is live at click time.
            s == "/run/g.sock" && sess == "worker-a"
        });
        assert_eq!(plan, ActivationPlan::Switch(target));
    }

    #[test]
    fn plan_activation_dead_terminal_yields_visible_notice() {
        let target = ViewerTarget::Terminal {
            id: "golem/i".into(),
            socket: "/run/g.sock".into(),
            session: "worker-a".into(),
        };
        // The terminal is gone at click time: a bounded, non-secret notice, not
        // a silent no-op.
        let plan = plan_activation(Some(target), &ViewerTarget::Presence, |_, _| false);
        match plan {
            ActivationPlan::Notice(message) => {
                assert!(!message.is_empty());
                assert!(
                    !message.contains("/run/g.sock"),
                    "notice must not leak paths"
                );
            }
            other => panic!("expected a visible notice, got {other:?}"),
        }
    }

    #[test]
    fn plan_activation_ignores_dead_row_and_current_target() {
        assert_eq!(
            plan_activation(None, &ViewerTarget::Presence, |_, _| true),
            ActivationPlan::Ignore
        );
        let current = ViewerTarget::Terminal {
            id: "golem/i".into(),
            socket: "/run/g.sock".into(),
            session: "worker-a".into(),
        };
        assert_eq!(
            plan_activation(Some(current.clone()), &current, |_, _| true),
            ActivationPlan::Ignore
        );
    }

    fn item(id: &str, status: &str, activation: bool) -> Item {
        Item {
            id: id.into(),
            workspace: "alpha".into(),
            label: "task".into(),
            status: status.into(),
            activation: activation.then(|| Activation {
                kind: "terminal".into(),
                socket: "/run/g.sock".into(),
                session: format!("worker-{id}"),
                action: String::new(),
            }),
        }
    }

    fn model(items: Vec<Item>) -> SidebarModel {
        SidebarModel {
            label: Some("agents".into()),
            items,
            available: true,
        }
    }

    // A running job with a live terminal is visible, clickable, and visually
    // active (its bright state color, no DIM).
    #[test]
    fn running_live_row_is_active_and_clickable() {
        let m = model(vec![item("j", "running", true)]);
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 40);
        let row = &r.rows[2];
        assert!(matches!(row.kind, FrameRowKind::Item { target: Some(_) }));
        assert!(!row.style.add_modifier.contains(Modifier::DIM));
    }

    // A settled job whose retained tmux session is still live keeps its
    // activation: it must remain visible and clickable, but faded (DIM) to read
    // as inactive.
    #[test]
    fn settled_retained_row_is_faded_but_clickable() {
        let m = model(vec![item("j", "done", true)]);
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 40);
        let row = &r.rows[2];
        assert!(matches!(row.kind, FrameRowKind::Item { target: Some(_) }));
        assert!(r.target_for_row(2).is_some());
        assert!(row.style.add_modifier.contains(Modifier::DIM));
    }

    // Settled jobs remain inspectable for the renderer's 24-hour retention even
    // after their tmux session is reaped; the row is dim and non-clickable.
    #[test]
    fn reaped_settled_row_remains_inspectable() {
        let m = model(vec![item("j", "done", false)]);
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 40);
        let row = r
            .rows
            .iter()
            .find(|row| matches!(row.kind, FrameRowKind::Item { .. }))
            .expect("settled row retained");
        assert!(matches!(row.kind, FrameRowKind::Item { target: None }));
        assert!(row.style.add_modifier.contains(Modifier::DIM));
        assert!(row.text.contains("(reaped)"));
    }

    #[test]
    fn settled_jobs_add_box_drawing_bordered_retire_action() {
        let mut m = model(vec![item("j", "done", false)]);
        m.items.push(Item {
            id: "retire".into(),
            workspace: String::new(),
            label: "Retire Golems".into(),
            status: String::new(),
            activation: Some(Activation {
                kind: "action".into(),
                socket: String::new(),
                session: String::new(),
                action: "golem/retire-settled".into(),
            }),
        });
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 28);
        let index = r
            .rows
            .iter()
            .position(|row| matches!(row.kind, FrameRowKind::Action { .. }))
            .unwrap();
        assert!(r.rows[index - 1].text.starts_with('┌'));
        assert!(r.rows[index - 1].text.contains('─'));
        assert!(r.rows[index].text.starts_with('│'));
        assert!(r.rows[index].text.ends_with('│'));
        assert!(r.rows[index].text.contains("Retire Golems"));
        assert!(r.rows[index + 1].text.starts_with('└'));
        assert_eq!(r.hit(index), SidebarHit::ActionRow(index));
        assert_eq!(r.action_for_row(index), Some("golem/retire-settled"));
    }

    #[test]
    fn live_jobs_are_projected_ahead_of_settled_history_before_truncation() {
        let mut items = Vec::new();
        for n in 0..8 {
            let mut settled = item(&format!("old-{n}"), "done", false);
            settled.workspace = "familiar".into();
            settled.label = format!("settled {n}");
            items.push(settled);
        }
        let mut fort = item("live-fort", "running", true);
        fort.workspace = "fort-nix".into();
        fort.label = "repair apple site".into();
        items.push(fort);
        let mut stuff = item("live-stuff", "running", true);
        stuff.workspace = "stuff".into();
        stuff.label = "generic mutations".into();
        items.push(stuff);
        let mut m = model(items);
        m.items.push(Item {
            id: "retire".into(),
            workspace: String::new(),
            label: "Retire Golems".into(),
            status: String::new(),
            activation: Some(Activation {
                kind: "action".into(),
                socket: String::new(),
                session: String::new(),
                action: "golem/retire-settled".into(),
            }),
        });

        // A 24-row terminal leaves 12 sidebar rows below the mark and the
        // action reserves three. Both later-workspace live jobs must fit in the
        // remaining projection despite the earlier retained history.
        let r = rows_for(&m, &ViewerTarget::Presence, 12, 28);
        let text: Vec<_> = r.rows.iter().map(|row| row.text.as_str()).collect();
        assert!(text.iter().any(|row| row.contains("repair apple site")));
        assert!(text.iter().any(|row| row.contains("generic mutations")));
        assert!(text.iter().any(|row| row.contains("Retire Golems")));
    }

    // A running job that never has a live terminal stays visible but is not
    // clickable, and is dimmed.
    #[test]
    fn running_without_terminal_visible_nonclickable() {
        let m = model(vec![item("j", "running", false)]);
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 40);
        let row = r
            .rows
            .iter()
            .find(|row| matches!(row.kind, FrameRowKind::Item { .. }))
            .expect("running row stays visible");
        assert!(matches!(row.kind, FrameRowKind::Item { target: None }));
        assert!(row.style.add_modifier.contains(Modifier::DIM));
    }

    // Failure and cancel keep their distinct treatment even when faded.
    #[test]
    fn terminal_states_keep_failure_distinction() {
        let failed = state_style("failed");
        let cancelled = state_style("cancelled");
        assert_eq!(failed.fg, Some(Color::Indexed(1)));
        assert_ne!(failed.fg, cancelled.fg);
    }

    // The colored dot conveys running/done, so their textual labels vanish;
    // ambiguous or actionable states (failure flavors, cancelled, blocked)
    // keep their text.
    #[test]
    fn dot_conveyed_statuses_drop_redundant_text() {
        let m = model(vec![
            item("a", "running", true),
            item("b", "done", true),
            item("c", "failed", true),
            item("d", "cancelled", true),
            item("e", "blocked", true),
        ]);
        let r = rows_for(&m, &ViewerTarget::Presence, 20, 60);
        let texts: Vec<&str> = r
            .rows
            .iter()
            .filter(|row| matches!(row.kind, FrameRowKind::Item { .. }))
            .map(|row| row.text.as_str())
            .collect();
        assert_eq!(texts.len(), 5);
        assert_eq!(status_suffix("running"), None);
        assert_eq!(status_suffix("done"), None);
        assert!(texts.iter().all(|text| !text.contains("running")));
        assert!(texts.iter().all(|text| !text.contains("done")));
        assert!(texts.iter().any(|text| text.contains("failed")));
        assert!(texts.iter().any(|text| text.contains("cancelled")));
        assert!(texts.iter().any(|text| text.contains("blocked")));
    }
}
