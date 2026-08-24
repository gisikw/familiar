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
    /// Converts the argv contract to portable-pty without involving a shell.
    pub fn portable_pty_builder(&self) -> CommandBuilder {
        let mut command = CommandBuilder::new(&self.program);
        for arg in &self.args {
            command.arg(arg);
        }
        for (name, value) in &self.set_env {
            command.env(name, value);
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
        // Advertise truecolor to the inner tmux for this attach client. The
        // vendored ghostty-vt engine (and both restty and Ghostty on the outer
        // host) render truecolor unconditionally, so inner tmux must not
        // downgrade or drop RGB SGR. Without this, inner tmux falls back to the
        // attach client's terminfo color capability: on a color-less TERM it
        // emits NO color SGR at all and RGB foregrounds render as default
        // (grey) instead of the theme accent. COLORTERM=truecolor forces RGB
        // passthrough for every TERM the client may present.
        set_env: vec![("COLORTERM".into(), "truecolor".into())],
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
        // Truecolor must be advertised to the inner tmux so RGB SGR (theme
        // accent) is not downgraded or dropped on the attach client.
        assert_eq!(
            command.set_env,
            [(OsString::from("COLORTERM"), OsString::from("truecolor"))]
        );
    }

    #[test]
    fn agent_is_writable_and_sanitized_like_sidebar() {
        let command = child_command(&config(), &ViewerTarget::Agent("a b/c.é_$".into()));
        assert_eq!(
            command.args,
            [
                "-S",
                "/run/a.sock",
                "attach-session",
                "-t",
                "worker-a-b-c--_-"
            ]
        );
        // Agent workers are interactive TUIs; the read-only attach is gone.
        assert!(!command.args.iter().any(|arg| arg == "-r"));
    }

    #[test]
    fn sanitization_replaces_each_non_ascii_allowed_character() {
        assert_eq!(sanitize_agent_id("AZaz09_-"), "AZaz09_-");
        assert_eq!(sanitize_agent_id("a::b"), "a--b");
        assert_eq!(sanitize_agent_id("💥"), "-");
        assert_eq!(sanitize_agent_id(""), "");
    }
}
