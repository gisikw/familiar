//! Diagnostic capture tap for the host-bound byte stream.
//!
//! When `FAMILIAR_VIEWER_CAPTURE` names a file path, every byte the viewer
//! writes to the host terminal is appended to it, exactly as written
//! (frames, graphics APCs, probe queries, teardown sequences). Host stdin
//! bytes that the raw probe reads — the query/response path — are appended to
//! the same path with a `.in` suffix. Capture is best-effort: a write failure
//! warns once to stderr and is thereafter ignored, and never blocks or crashes
//! the viewer. Zero behavior change when the variable is unset.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

struct Sinks {
    out: Option<Mutex<std::fs::File>>,
    input: Option<Mutex<std::fs::File>>,
}

static SINKS: OnceLock<Sinks> = OnceLock::new();
static WARNED: AtomicBool = AtomicBool::new(false);

fn warn_once(context: &str, error: &io::Error) {
    if !WARNED.swap(true, Ordering::SeqCst) {
        eprintln!("familiar-viewer: capture {context} failed, further errors suppressed: {error}");
    }
}

/// Initialize the capture sinks from the environment. Idempotent; call once
/// before any host-bound bytes are written so nothing is missed.
pub fn init() {
    SINKS.get_or_init(|| {
        let Some(path) = std::env::var_os("FAMILIAR_VIEWER_CAPTURE") else {
            return Sinks {
                out: None,
                input: None,
            };
        };
        if path.is_empty() {
            return Sinks {
                out: None,
                input: None,
            };
        }
        let open = |p: &std::path::Path, context: &str| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .map(Mutex::new)
                .map_err(|error| warn_once(context, &error))
                .ok()
        };
        let out_path = std::path::PathBuf::from(&path);
        let mut in_path = path;
        in_path.push(".in");
        let in_path = std::path::PathBuf::from(in_path);
        Sinks {
            out: open(&out_path, "open output"),
            input: open(&in_path, "open input"),
        }
    });
}

fn append(sink: &Option<Mutex<std::fs::File>>, bytes: &[u8], context: &str) {
    let Some(sink) = sink else { return };
    let Ok(mut file) = sink.lock() else { return };
    if let Err(error) = file.write_all(bytes) {
        warn_once(context, &error);
    }
}

/// Append host-bound output bytes, exactly as written to the host terminal.
pub fn tap_out(bytes: &[u8]) {
    if let Some(sinks) = SINKS.get() {
        append(&sinks.out, bytes, "write output");
    }
}

/// Append host stdin bytes read during the raw probe (query/response path).
pub fn tap_in(bytes: &[u8]) {
    if let Some(sinks) = SINKS.get() {
        append(&sinks.input, bytes, "write input");
    }
}

/// A `Write` that tees everything written to the host through the capture tap.
/// This is the single choke point wrapped around the process stdout so no
/// host-bound bytes bypass the capture.
pub struct HostWriter<W: Write> {
    inner: W,
}

impl HostWriter<io::Stdout> {
    /// Wrap the process stdout — the sole host-bound sink.
    pub fn stdout() -> Self {
        HostWriter {
            inner: io::stdout(),
        }
    }
}

impl<W: Write> HostWriter<W> {
    #[cfg(test)]
    pub fn new(inner: W) -> Self {
        HostWriter { inner }
    }
}

impl<W: Write> Write for HostWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        // Tap exactly what reached the host, not what was offered.
        tap_out(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_writer_tees_written_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "familiar-capture-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let capture = dir.join("out.cap");
        std::env::set_var("FAMILIAR_VIEWER_CAPTURE", &capture);
        // Fresh statics per test binary; init reads the env we just set.
        init();

        let mut sink: Vec<u8> = Vec::new();
        {
            let mut writer = HostWriter::new(&mut sink);
            writer.write_all(b"\x1b[?2026h").unwrap();
            let bytes = b"\x1b_Ga=T,f=100;AAAA\x1b\\";
            writer.write_all(bytes).unwrap();
            writer.flush().unwrap();
        }

        let captured = std::fs::read(&capture).unwrap();
        assert_eq!(
            captured, sink,
            "capture file must be byte-identical to what the host writer emitted"
        );
        std::env::remove_var("FAMILIAR_VIEWER_CAPTURE");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
