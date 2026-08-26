use crate::{app::ViewerTarget, cli::Config};
use portable_pty::{CommandBuilder, PtySize};
use std::ffi::{OsStr, OsString};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChildCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub set_env: Vec<(OsString, OsString)>,
    pub remove_env: Vec<OsString>,
}
impl ChildCommand {
    pub fn portable_pty_builder(&self) -> CommandBuilder {
        let mut c = CommandBuilder::new(&self.program);
        for a in &self.args {
            c.arg(a);
        }
        for (n, v) in &self.set_env {
            c.env(n, v);
        }
        for n in &self.remove_env {
            c.env_remove(n);
        }
        c
    }
}
pub fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}
pub fn child_command(config: &Config, target: &ViewerTarget) -> ChildCommand {
    let (socket, args): (&OsStr, Vec<OsString>) = match target {
        ViewerTarget::Presence => (
            config.presence_socket.as_os_str(),
            vec![
                "attach-session".into(),
                "-t".into(),
                config.presence_session.clone().into(),
            ],
        ),
        ViewerTarget::Terminal {
            socket, session, ..
        } => (
            OsStr::new(socket),
            vec![
                "attach-session".into(),
                "-t".into(),
                format!("={session}").into(),
            ],
        ),
    };
    let mut full = vec!["-S".into(), socket.into()];
    full.extend(args);
    ChildCommand {
        program: "tmux".into(),
        args: full,
        set_env: vec![("COLORTERM".into(), "truecolor".into())],
        remove_env: vec!["TMUX".into()],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn c() -> Config {
        Config {
            presence_socket: "/p".into(),
            presence_session: "presence".into(),
            render_url: None,
        }
    }
    #[test]
    fn presence_is_writable() {
        assert!(!child_command(&c(), &ViewerTarget::Presence)
            .args
            .iter()
            .any(|x| x == "-r"))
    }
    #[test]
    fn semantic_terminal_is_exact_and_writable() {
        let x = child_command(
            &c(),
            &ViewerTarget::Terminal {
                id: "i".into(),
                socket: "/run/g.sock".into(),
                session: "worker-1".into(),
            },
        );
        assert_eq!(
            x.args,
            ["-S", "/run/g.sock", "attach-session", "-t", "=worker-1"]
        );
        assert!(!x.args.iter().any(|x| x == "-r"))
    }
}
