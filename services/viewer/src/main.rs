use familiar_viewer::cli::{Config, ParseOutcome, HELP};

/// Placeholder for the future crossterm alternate-screen/raw-mode RAII guard.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Self {
        Self
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {}
}

fn event_loop(_config: Config) {
    let _guard = TerminalGuard::enter();
    // Chunk 0 intentionally has no production caller or child PTY event loop.
}

fn main() {
    match Config::parse_from(std::env::args_os(), |key| std::env::var_os(key)) {
        Ok(ParseOutcome::Help) => print!("{HELP}"),
        Ok(ParseOutcome::Run(config)) => event_loop(config),
        Err(error) => {
            eprintln!("familiar-viewer: {error}");
            eprintln!("Try 'familiar-viewer --help' for usage.");
            std::process::exit(2);
        }
    }
}
