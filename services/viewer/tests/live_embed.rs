#![cfg(unix)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, output: &mut Vec<u8>, needle: &[u8]) -> bool {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if output.windows(needle.len()).any(|window| window == needle) {
            return true;
        }
        if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(100)) {
            output.extend(bytes);
        }
    }
    false
}

#[test]
fn embeds_tmux_and_tracks_outer_resize() {
    if Command::new("tmux").arg("-V").output().is_err() {
        eprintln!("skipping live_embed: tmux is not available");
        return;
    }

    let directory = std::env::temp_dir().join(format!(
        "familiar-viewer-live-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("sock");
    let agents_socket = directory.join("agents.sock");
    let presence_config =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../presence/tmux.conf");
    let started = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "-f",
            presence_config.to_str().unwrap(),
            "new-session",
            "-d",
            "-s",
            "presence",
            "-x",
            "80",
            "-y",
            "24",
            "sh",
            "-c",
            "for i in $(seq 1 100); do printf 'history-%03d\\n' \"$i\"; done; printf smoketext; exec bash --noprofile --norc",
        ])
        .status()
        .unwrap();
    assert!(started.success());
    assert!(Command::new("tmux")
        .args([
            "-S",
            agents_socket.to_str().unwrap(),
            "new-session",
            "-d",
            "-s",
            "worker-job-active",
            "sh",
            "-c",
            "while :; do printf agent-visible; sleep 1; done",
        ])
        .status()
        .unwrap()
        .success());

    let fixture = format!(r#"{{"render_api":1,"revision":1,"ttl_ms":1000,"target":"left-nav","content":{{"kind":"tree","id":"root","label":"agents","children":[{{"kind":"branch","id":"workspace:alpha","label":"alpha","children":[{{"kind":"item","id":"job-active","label":"Fix sidebar","status":"running","activation":{{"type":"terminal","socket":"{}","session":"worker-job-active"}}}}]}}]}}}}"#, agents_socket.display()).into_bytes();
    familiar_viewer::sidebar::parse_render(&fixture).expect("semantic render fixture");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let serving = Arc::new(AtomicBool::new(true));
    let server_flag = Arc::clone(&serving);
    let server = thread::spawn(move || {
        while server_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    let mut request = [0_u8; 1024];
                    let _ = stream.read(&mut request);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        fixture.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&fixture);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let mouse_marker = directory.join("mouse-clicked");
    assert!(Command::new("tmux")
        .args(["-S", socket.to_str().unwrap(), "set", "-g", "mouse", "on"])
        .status()
        .unwrap()
        .success());
    assert!(Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "bind-key",
            "-n",
            "MouseDown1Pane",
            "run-shell",
            &format!("touch {}", mouse_marker.display()),
        ])
        .status()
        .unwrap()
        .success());

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (tx, rx) = mpsc::channel();
    // A never-cleared accumulator of the entire host-bound stream. The steady
    // `output` buffer below is drained per assertion; this mirrors exactly what
    // the PTY harness saw so it can be compared to the capture tap's file.
    let full = Arc::new(Mutex::new(Vec::new()));
    let full_reader = Arc::clone(&full);
    let reader_handle = thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while let Ok(length) = reader.read(&mut buffer) {
            if length == 0 {
                break;
            }
            full_reader
                .lock()
                .unwrap()
                .extend_from_slice(&buffer[..length]);
            if tx.send(buffer[..length].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_familiar-viewer"));
    command.args([
        "--presence-socket",
        socket.to_str().unwrap(),
        "--render-url",
        &endpoint,
    ]);
    command.env("TERM", "xterm-256color");
    command.env("FAMILIAR_GRAPHICS_MODE", "text");
    // Diagnostic capture tap: the file must end up byte-identical to the host
    // stream this harness reads back.
    let capture = directory.join("host.cap");
    command.env("FAMILIAR_VIEWER_CAPTURE", &capture);
    let mut viewer = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    // Crossterm asks the host terminal for its cursor position during ratatui setup.
    writer.write_all(b"\x1b[1;1R").unwrap();
    writer.flush().unwrap();

    let mut output = Vec::new();
    assert!(
        wait_for(&rx, &mut output, b"FAMILIAR"),
        "sidebar was not rendered: {:?}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        wait_for(&rx, &mut output, b"smoketext"),
        "child terminal was not rendered: {:?}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        wait_for(&rx, &mut output, b"Fix sidebar"),
        "jobs sidebar was not rendered: {:?}",
        String::from_utf8_lossy(&output)
    );

    // The fixture renders heading, workspace, then its live job at sidebar
    // relative row 2 (host one-based row 15). It switches to a read-only attach.
    output.clear();
    writer.write_all(b"\x1b[<0;5;15M\x1b[1;1R").unwrap();
    writer.flush().unwrap();
    assert!(
        wait_for(&rx, &mut output, b"agent-visible"),
        "live sidebar click did not switch to worker: {:?}",
        String::from_utf8_lossy(&output)
    );
    // Clicking the mark returns to Presence.
    output.clear();
    writer.write_all(b"\x1b[<0;5;2M\x1b[1;1R").unwrap();
    writer.flush().unwrap();
    assert!(
        wait_for(&rx, &mut output, b"smoketext"),
        "mark click did not return to Presence: {:?}",
        String::from_utf8_lossy(&output)
    );

    // Host cell (30,5), one-based, is inside main and becomes child cell
    // (2,5). The inner tmux's mouse binding is a deterministic end-to-end
    // assertion that the viewer translated and SGR-encoded the press.
    writer.write_all(b"\x1b[<0;30;5M").unwrap();
    writer.flush().unwrap();
    let mouse_deadline = Instant::now() + Duration::from_secs(8);
    while !mouse_marker.exists() && Instant::now() < mouse_deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        mouse_marker.exists(),
        "inner tmux did not receive mouse press"
    );

    let termfeatures = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "display-message",
            "-p",
            "-t",
            "presence",
            "#{client_termfeatures}",
        ])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&termfeatures.stdout).contains("extkeys"),
        "viewer tmux client did not negotiate extkeys: {:?}",
        String::from_utf8_lossy(&termfeatures.stdout)
    );

    // tmux mouse mode, not viewer-side socket injection, owns history. Wheel
    // reports forwarded through the viewer enter copy mode on this bash pane.
    output.clear();
    for _ in 0..12 {
        writer.write_all(b"\x1b[<64;30;5M").unwrap();
    }
    writer.flush().unwrap();
    assert!(
        wait_for(&rx, &mut output, b"history-0"),
        "wheel copy mode did not render earlier history: {:?}",
        String::from_utf8_lossy(&output)
    );
    let mode_deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < mode_deadline {
        let mode = Command::new("tmux")
            .args([
                "-S",
                socket.to_str().unwrap(),
                "display-message",
                "-p",
                "-t",
                "presence",
                "#{pane_in_mode}",
            ])
            .output()
            .unwrap();
        if mode.stdout.starts_with(b"1") {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let mode = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "display-message",
            "-p",
            "-t",
            "presence",
            "#{pane_in_mode}",
        ])
        .output()
        .unwrap();
    assert!(
        mode.stdout.starts_with(b"1"),
        "wheel did not enter copy mode"
    );

    // Actual tmux behavior is that a copy-mode-bound printable key remains in
    // copy mode; the viewer no longer races a control-client cancellation.
    writer.write_all(b"z").unwrap();
    writer.flush().unwrap();
    thread::sleep(Duration::from_millis(100));
    let mode = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "display-message",
            "-p",
            "-t",
            "presence",
            "#{pane_in_mode}",
        ])
        .output()
        .unwrap();
    assert!(mode.stdout.starts_with(b"1"));
    assert!(Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "send-keys",
            "-X",
            "-t",
            "presence",
            "cancel",
        ])
        .status()
        .unwrap()
        .success());

    // The config-level PageUp binding sees the inner pane's primary screen.
    writer.write_all(b"\x1b[5~").unwrap();
    writer.flush().unwrap();
    thread::sleep(Duration::from_millis(100));
    let mode = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "display-message",
            "-p",
            "-t",
            "presence",
            "#{pane_in_mode}",
        ])
        .output()
        .unwrap();
    assert!(
        mode.stdout.starts_with(b"1"),
        "PageUp did not enter copy mode"
    );
    assert!(Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "send-keys",
            "-X",
            "-t",
            "presence",
            "cancel",
        ])
        .status()
        .unwrap()
        .success());

    pair.master
        .resize(PtySize {
            rows: 26,
            cols: 90,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut resized = false;
    while Instant::now() < deadline {
        let clients = Command::new("tmux")
            .args([
                "-S",
                socket.to_str().unwrap(),
                "list-clients",
                "-F",
                "#{client_width}x#{client_height}",
            ])
            .output()
            .unwrap();
        let dimensions = String::from_utf8_lossy(&clients.stdout);
        if dimensions.lines().any(|line| line == "62x26") {
            resized = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        resized,
        "inner tmux client did not follow the 90x26 outer resize"
    );

    // An alternate-screen raw observer proves PageUp bytes are not swallowed:
    // tmux's root binding passes them through to the pane program.
    let pageup_bytes = directory.join("pageup-bytes");
    let observer = format!(
        "printf '\\033[?1049h'; stty raw -echo; dd bs=1 count=4 2>/dev/null | od -An -tx1 > {}; sleep 30",
        pageup_bytes.display()
    );
    assert!(Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "respawn-pane",
            "-k",
            "-t",
            "presence",
            &observer,
        ])
        .status()
        .unwrap()
        .success());
    let alternate_deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < alternate_deadline {
        let alternate = Command::new("tmux")
            .args([
                "-S",
                socket.to_str().unwrap(),
                "display-message",
                "-p",
                "-t",
                "presence",
                "#{alternate_on}",
            ])
            .output()
            .unwrap();
        if alternate.stdout.starts_with(b"1") {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    writer.write_all(b"\x1b[5~").unwrap();
    writer.flush().unwrap();
    let bytes_deadline = Instant::now() + Duration::from_secs(8);
    while fs::metadata(&pageup_bytes).map_or(0, |metadata| metadata.len()) == 0
        && Instant::now() < bytes_deadline
    {
        thread::sleep(Duration::from_millis(50));
    }
    let observed = fs::read_to_string(&pageup_bytes).unwrap_or_default();
    assert!(
        observed.contains("1b 5b 35 7e"),
        "alternate-screen PageUp bytes were not delivered: {observed:?}"
    );

    assert!(Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
            "detach-client",
            "-s",
            "presence"
        ])
        .status()
        .unwrap()
        .success());
    // An explicit inner detach makes tmux attach return 0, so the viewer's
    // clean-child policy exits rather than rendering the death notice.
    let exit_deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        if let Some(status) = viewer.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < exit_deadline,
            "viewer did not exit after clean tmux attach completion"
        );
        thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "viewer clean-child exit was not successful: {status:?}"
    );

    assert!(
        !output.windows(3).any(|window| window == b"\x1b_G"),
        "text mode leaked Kitty APC bytes"
    );

    // Drain the reader to EOF (the child has exited) so the accumulator holds
    // every host-bound byte, then assert the capture tap recorded exactly that.
    // Two byte sequences legitimately appear in the host stream but not in the
    // tap, and neither is viewer frame/graphics emission:
    //   * `\x1b[1;1R` — the harness injects this fake cursor-position *reply* as
    //     viewer input; the PTY line discipline echoes it. It is not a viewer
    //     write at all.
    //   * `\x1b[6n` — ratatui's `get_cursor_position` calls
    //     `crossterm::cursor::position()`, which crossterm hardcodes to its own
    //     `io::stdout()` handle, structurally bypassing any wrapper around the
    //     ratatui backend. It is a library-internal capability probe.
    // With those removed, the capture is byte-identical to the observed stream:
    // proof the tap sees every byte the viewer itself emits.
    reader_handle.join().unwrap();
    let captured = fs::read(&capture).unwrap();
    let seen = full.lock().unwrap().clone();
    fn strip_non_viewer_writes(bytes: &[u8]) -> Vec<u8> {
        // Remove every `\x1b[1;1R` (harness-injected fake CPR reply, echoed by
        // the PTY before raw mode) and every `\x1b[6n` (crossterm's internal
        // cursor-position probe on its own stdout handle). Their counts are
        // render-timing dependent, so strip from both streams.
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i..].starts_with(b"\x1b[6n") {
                i += 4;
                continue;
            }
            if bytes[i..].starts_with(b"\x1b[1;1R") {
                i += 7;
                continue;
            }
            // Before the viewer enables raw mode the PTY line discipline echoes
            // the harness's injected ESC in caret notation, so the same fake CPR
            // also appears as the literal bytes `^[[1;1R`.
            if bytes[i..].starts_with(b"^[[1;1R") {
                i += 7;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        }
        out
    }
    let expected = strip_non_viewer_writes(&seen);
    let captured = strip_non_viewer_writes(&captured);
    assert_eq!(
        captured.len(),
        expected.len(),
        "capture length {} diverged from viewer-emitted host stream length {}",
        captured.len(),
        expected.len()
    );
    assert!(
        captured == expected,
        "capture file diverged from the observed viewer-emitted host byte stream"
    );

    let _ = Command::new("tmux")
        .args(["-S", agents_socket.to_str().unwrap(), "kill-server"])
        .status();
    let _ = Command::new("tmux")
        .args(["-S", socket.to_str().unwrap(), "kill-server"])
        .status();
    serving.store(false, Ordering::Relaxed);
    server.join().unwrap();
    let _ = fs::remove_dir_all(directory);
}
