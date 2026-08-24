use std::{ffi::OsString, fmt, path::PathBuf};

pub const HELP: &str = r#"familiar-viewer — per-client Familiar terminal viewer

USAGE:
    familiar-viewer --presence-socket <ABSOLUTE_PATH> [OPTIONS]

OPTIONS:
    --presence-socket <ABSOLUTE_PATH>
    --presence-session <NAME>
    --render-url <HTTP_URL>   Familiar-owned semantic chrome endpoint.
    -h, --help

The viewer owns rendering and input. Selectable semantic items may carry a
same-host terminal {socket,session}; plugin code never paints viewer pixels.
"#;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub presence_socket: PathBuf,
    pub presence_session: String,
    pub render_url: Option<String>,
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
        let (mut socket, mut session, mut render) = (None, None, None);
        let mut args = args.into_iter().map(Into::into);
        let _ = args.next();
        while let Some(arg) = args.next() {
            let text = arg
                .to_str()
                .ok_or_else(|| CliError("arguments must be valid UTF-8".into()))?;
            if text == "-h" || text == "--help" {
                return Ok(ParseOutcome::Help);
            }
            let value = args
                .next()
                .ok_or_else(|| CliError(format!("missing value for {text}")))?;
            match text {
                "--presence-socket" => socket = Some(PathBuf::from(value)),
                "--presence-session" => session = Some(os_text(value, text)?),
                "--render-url" => render = Some(os_text(value, text)?),
                _ => return Err(CliError(format!("unknown option {text}; use --help"))),
            }
        }
        let presence_socket = socket
            .or_else(|| env("FAMILIAR_PRESENCE_SOCKET").map(PathBuf::from))
            .ok_or_else(|| {
                CliError("--presence-socket or FAMILIAR_PRESENCE_SOCKET is required".into())
            })?;
        if !presence_socket.is_absolute() {
            return Err(CliError(format!(
                "presence socket path must be absolute: {}",
                presence_socket.display()
            )));
        }
        Ok(ParseOutcome::Run(Config {
            presence_socket,
            presence_session: session
                .or_else(|| env("FAMILIAR_PRESENCE_SESSION").and_then(|v| v.into_string().ok()))
                .unwrap_or_else(|| "presence".into()),
            render_url: render
                .or_else(|| env("FAMILIAR_RENDER_URL").and_then(|v| v.into_string().ok())),
        }))
    }
}
fn os_text(v: OsString, o: &str) -> Result<String, CliError> {
    v.into_string()
        .map_err(|_| CliError(format!("value for {o} must be valid UTF-8")))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    fn parse(a: &[&str], v: &[(&str, &str)]) -> Result<ParseOutcome, CliError> {
        let m: HashMap<_, _> = v.iter().copied().collect();
        Config::parse_from(a, |k| m.get(k).map(OsString::from))
    }
    #[test]
    fn no_plugin_is_valid() {
        let ParseOutcome::Run(c) = parse(&["viewer", "--presence-socket", "/p"], &[]).unwrap()
        else {
            panic!()
        };
        assert_eq!(c.render_url, None)
    }
    #[test]
    fn render_env_is_loaded() {
        let ParseOutcome::Run(c) = parse(
            &["viewer"],
            &[
                ("FAMILIAR_PRESENCE_SOCKET", "/p"),
                (
                    "FAMILIAR_RENDER_URL",
                    "http://127.0.0.1:9940/v1/render/golem",
                ),
            ],
        )
        .unwrap() else {
            panic!()
        };
        assert!(c.render_url.is_some())
    }
    #[test]
    fn relative_socket_refused() {
        assert!(parse(&["viewer", "--presence-socket", "p"], &[]).is_err())
    }
}
