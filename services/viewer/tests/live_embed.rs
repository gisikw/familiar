#![cfg(unix)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
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
    let started = Command::new("tmux")
        .args([
            "-S",
            socket.to_str().unwrap(),
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
            "printf smoketext; sleep 30",
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

    let fixture = br#"[{"id":"job-active","cwd":"/work/alpha","prompt":"Fix sidebar","state":"running","updated_at":"2026-08-22T07:30:00Z"}]"#.to_vec();
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
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while let Ok(length) = reader.read(&mut buffer) {
            if length == 0 || tx.send(buffer[..length].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_familiar-viewer"));
    command.args([
        "--presence-socket",
        socket.to_str().unwrap(),
        "--agents-socket",
        agents_socket.to_str().unwrap(),
        "--agents-endpoint",
        &endpoint,
    ]);
    command.env("TERM", "xterm-256color");
    command.env("FAMILIAR_GRAPHICS_MODE", "text");
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
