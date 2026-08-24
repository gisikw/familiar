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
    pub socket: String,
    pub session: String,
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
        self.activation.as_ref().map(|a| ViewerTarget::Terminal {
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
            _ => SidebarHit::Dead,
        }
    }
    pub fn target_for_row(&self, row: usize) -> Option<ViewerTarget> {
        match self.rows.get(row).map(|x| &x.kind) {
            Some(FrameRowKind::Item { target }) => target.clone(),
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
                    if a.kind != "terminal"
                        || !Path::new(&a.socket).is_absolute()
                        || a.session.is_empty()
                        || a.session.len() > 128
                    {
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
                        if i.activation.as_ref().is_some_and(|a| !terminal_live(a)) {
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
    let rev = String::from_utf8_lossy(h)
        .lines()
        .find_map(|x| x.strip_prefix("X-Familiar-Revision: "))
        .and_then(|x| x.trim().parse().ok())
        .unwrap_or(0);
    Ok((r[end + 4..].to_vec(), rev))
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
    let visible: Vec<_> = m
        .items
        .iter()
        .filter(|i| !i.terminal() || i.activation.is_some())
        .collect();
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
        let text = format!("{prefix}{} {}", item.label, item.status);
        let mut style = state_style(&item.status);
        if item.activation.is_none() {
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
}
