use familiar_viewer::cli::{Config, ParseOutcome, HELP};

fn main() {
    match Config::parse_from(std::env::args_os(), |key| std::env::var_os(key)) {
        Ok(ParseOutcome::Help) => print!("{HELP}"),
        Ok(ParseOutcome::Run(config)) => {
            if let Err(error) = familiar_viewer::runtime::run(config) {
                eprintln!("familiar-viewer: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("familiar-viewer: {error}");
            eprintln!("Try 'familiar-viewer --help' for usage.");
            std::process::exit(2);
        }
    }
}
