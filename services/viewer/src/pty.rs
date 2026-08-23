use crate::{app::ViewerTarget, cli::Config};
use portable_pty::{CommandBuilder, PtySize};
use std::ffi::{OsStr, OsString};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChildCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub remove_env: Vec<OsString>,
}

impl ChildCommand {
    /// Converts the argv contract to portable-pty without involving a shell.
    pub fn portable_pty_builder(&self) -> CommandBuilder {
        let mut command = CommandBuilder::new(&self.program);
        for arg in &self.args {
            command.arg(arg);
        }
        for name in &self.remove_env {
            command.env_remove(name);
        }
        command
    }
}

/// Initial geometry passed to a future portable-pty lifecycle owner.
pub fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn child_command(config: &Config, target: &ViewerTarget) -> ChildCommand {
    let (socket, mut args): (&OsStr, Vec<OsString>) = match target {
        ViewerTarget::Presence => (
            config.presence_socket.as_os_str(),
            vec![
                "attach-session".into(),
                "-t".into(),
                config.presence_session.clone().into(),
            ],
        ),
        ViewerTarget::Agent(id) => (
            config.agents_socket.as_os_str(),
            vec![
                "attach-session".into(),
                "-r".into(),
                "-t".into(),
                format!("worker-{}", sanitize_agent_id(id)).into(),
            ],
        ),
    };
    let mut full_args = vec!["-S".into(), socket.into()];
    full_args.append(&mut args);
    ChildCommand {
        program: "tmux".into(),
        args: full_args,
        remove_env: vec!["TMUX".into()],
    }
}

pub fn sanitize_agent_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            presence_socket: "/run/p.sock".into(),
            presence_session: "presence".into(),
            agents_socket: "/run/a.sock".into(),
            agents_endpoint: "http://127.0.0.1:7337".into(),
        }
    }

    #[test]
    fn presence_is_writable_direct_argv() {
        let command = child_command(&config(), &ViewerTarget::Presence);
        assert_eq!(
            command.args,
            ["-S", "/run/p.sock", "attach-session", "-t", "presence"]
        );
        assert!(!command.args.iter().any(|arg| arg == "-r"));
        assert_eq!(command.remove_env, ["TMUX"]);
    }

    #[test]
    fn agent_is_read_only_and_sanitized_like_sidebar() {
        let command = child_command(&config(), &ViewerTarget::Agent("a b/c.é_$".into()));
        assert_eq!(
            command.args,
            [
                "-S",
                "/run/a.sock",
                "attach-session",
                "-r",
                "-t",
                "worker-a-b-c--_-"
            ]
        );
    }

    #[test]
    fn sanitization_replaces_each_non_ascii_allowed_character() {
        assert_eq!(sanitize_agent_id("AZaz09_-"), "AZaz09_-");
        assert_eq!(sanitize_agent_id("a::b"), "a--b");
        assert_eq!(sanitize_agent_id("💥"), "-");
        assert_eq!(sanitize_agent_id(""), "");
    }
}
