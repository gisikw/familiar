use std::{ffi::OsString, fmt, path::PathBuf};

pub const HELP: &str = r#"familiar-viewer — per-client Familiar terminal viewer

USAGE:
    familiar-viewer --presence-socket <ABSOLUTE_PATH> [OPTIONS]

OPTIONS:
    --presence-socket <ABSOLUTE_PATH>
        Inner presence tmux socket. Defaults to FAMILIAR_PRESENCE_SOCKET.
    --presence-session <NAME>
        Inner presence tmux session. Defaults to FAMILIAR_PRESENCE_SESSION, then "presence".
    --agents-socket <ABSOLUTE_PATH>
        Agents supervisor tmux socket. Defaults to FAMILIAR_AGENTS_SOCKET.
    --agents-endpoint <HTTP_URL>
        Jobs API base URL. Defaults to FAMILIAR_AGENTS_ENDPOINT, then
        "http://127.0.0.1:7337"; jobs are read from GET /v1/jobs.
    -h, --help
        Print help.

VIEWER KEY:
    Ctrl-\\
        Quit the viewer. All other keys are forwarded to the embedded child.

PATH AND ENV CONTRACT:
    Socket paths must be absolute whether supplied by a flag or environment.
    The viewer attaches to presence with: tmux -S SOCKET attach-session -t SESSION.
    Agent targets use FAMILIAR_AGENTS_SOCKET and a writable worker session attach
    (workers are interactive TUIs by design).
    Child commands are direct argv (never shell text), and TMUX is removed from
    their environment. Familiar-owned chrome lists jobs from the endpoint above.
"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub presence_socket: PathBuf,
    pub presence_session: String,
    pub agents_socket: PathBuf,
    pub agents_endpoint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParseOutcome {
    Run(Config),
    Help,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliError(pub String);

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CliError {}

impl Config {
    pub fn parse_from<I, S, F>(args: I, env: F) -> Result<ParseOutcome, CliError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
        F: Fn(&str) -> Option<OsString>,
    {
        let mut presence_socket = None;
        let mut presence_session = None;
        let mut agents_socket = None;
        let mut agents_endpoint = None;
        let mut args = args.into_iter().map(Into::into);
        let _program = args.next();

        while let Some(arg) = args.next() {
            let text = arg
                .to_str()
                .ok_or_else(|| CliError("arguments must be valid UTF-8".into()))?;
            if text == "-h" || text == "--help" {
                return Ok(ParseOutcome::Help);
            }
            let value = args.next().ok_or_else(|| {
                CliError(format!("missing value for {text}; use --help for usage"))
            })?;
            match text {
                "--presence-socket" => presence_socket = Some(PathBuf::from(value)),
                "--presence-session" => presence_session = Some(os_text(value, text)?),
                "--agents-socket" => agents_socket = Some(PathBuf::from(value)),
                "--agents-endpoint" => agents_endpoint = Some(os_text(value, text)?),
                _ => return Err(CliError(format!("unknown option {text}; use --help"))),
            }
        }

        let presence_socket = presence_socket
            .or_else(|| env("FAMILIAR_PRESENCE_SOCKET").map(PathBuf::from))
            .ok_or_else(|| {
                CliError("--presence-socket or FAMILIAR_PRESENCE_SOCKET is required".into())
            })?;
        let agents_socket = agents_socket
            .or_else(|| env("FAMILIAR_AGENTS_SOCKET").map(PathBuf::from))
            .ok_or_else(|| {
                CliError("--agents-socket or FAMILIAR_AGENTS_SOCKET is required".into())
            })?;
        require_absolute("presence socket", &presence_socket)?;
        require_absolute("agents socket", &agents_socket)?;

        Ok(ParseOutcome::Run(Self {
            presence_socket,
            presence_session: presence_session
                .or_else(|| env("FAMILIAR_PRESENCE_SESSION").and_then(|v| v.into_string().ok()))
                .unwrap_or_else(|| "presence".into()),
            agents_socket,
            agents_endpoint: agents_endpoint
                .or_else(|| env("FAMILIAR_AGENTS_ENDPOINT").and_then(|v| v.into_string().ok()))
                .unwrap_or_else(|| "http://127.0.0.1:7337".into()),
        }))
    }
}

fn os_text(value: OsString, option: &str) -> Result<String, CliError> {
    value
        .into_string()
        .map_err(|_| CliError(format!("value for {option} must be valid UTF-8")))
}

fn require_absolute(label: &str, path: &std::path::Path) -> Result<(), CliError> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(CliError(format!(
            "{label} path must be absolute: {}",
            path.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn parse(args: &[&str], vars: &[(&str, &str)]) -> Result<ParseOutcome, CliError> {
        let vars: HashMap<_, _> = vars.iter().copied().collect();
        Config::parse_from(args, |key| vars.get(key).map(OsString::from))
    }

    #[test]
    fn flags_define_contract() {
        let result = parse(
            &[
                "viewer",
                "--presence-socket",
                "/p.sock",
                "--presence-session",
                "p",
                "--agents-socket",
                "/a.sock",
                "--agents-endpoint",
                "http://agents",
            ],
            &[],
        )
        .unwrap();
        assert_eq!(
            result,
            ParseOutcome::Run(Config {
                presence_socket: "/p.sock".into(),
                presence_session: "p".into(),
                agents_socket: "/a.sock".into(),
                agents_endpoint: "http://agents".into(),
            })
        );
    }

    #[test]
    fn environment_and_literal_defaults_define_contract() {
        let result = parse(
            &["viewer"],
            &[
                ("FAMILIAR_PRESENCE_SOCKET", "/env/p"),
                ("FAMILIAR_PRESENCE_SESSION", "inside"),
                ("FAMILIAR_AGENTS_SOCKET", "/env/a"),
                ("FAMILIAR_AGENTS_ENDPOINT", "http://env-agents"),
            ],
        )
        .unwrap();
        let ParseOutcome::Run(config) = result else {
            panic!()
        };
        assert_eq!(config.presence_socket, PathBuf::from("/env/p"));
        assert_eq!(config.presence_session, "inside");
        assert_eq!(config.agents_socket, PathBuf::from("/env/a"));
        assert_eq!(config.agents_endpoint, "http://env-agents");
    }

    #[test]
    fn session_and_endpoint_have_literal_defaults() {
        let result = parse(
            &["viewer", "--presence-socket", "/p", "--agents-socket", "/a"],
            &[],
        )
        .unwrap();
        let ParseOutcome::Run(config) = result else {
            panic!()
        };
        assert_eq!(config.presence_session, "presence");
        assert_eq!(config.agents_endpoint, "http://127.0.0.1:7337");
    }

    #[test]
    fn socket_paths_are_absolute() {
        let error = parse(
            &[
                "viewer",
                "--presence-socket",
                "relative",
                "--agents-socket",
                "/a",
            ],
            &[],
        )
        .unwrap_err();
        assert!(error.to_string().contains("must be absolute"));
    }
}
