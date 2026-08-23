#![cfg(unix)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;
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
        socket.to_str().unwrap(),
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

    let _ = Command::new("tmux")
        .args(["-S", socket.to_str().unwrap(), "kill-server"])
        .status();
    assert!(
        wait_for(&rx, &mut output, b"tmux session ended"),
        "child-death notice was not rendered: {:?}",
        String::from_utf8_lossy(&output)
    );

    assert!(
        !output.windows(3).any(|window| window == b"\x1b_G"),
        "text mode leaked Kitty APC bytes"
    );

    let _ = viewer.kill();
    let _ = viewer.wait();
    let _ = fs::remove_dir_all(directory);
}
