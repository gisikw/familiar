use std::env;
use std::path::PathBuf;
use std::process::Command;

fn zig_target(target: &str) -> &'static str {
    match target {
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        _ => panic!("libghostty-vt is supported only on x86_64/aarch64 Linux GNU targets"),
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt.vendor.json");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt/build.zig");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt/build.zig.zon");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt/include");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt/pkg");
    println!("cargo:rerun-if-changed=vendor/libghostty-vt/src");
    println!("cargo:rerun-if-env-changed=ZIG");

    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let vendor = root.join("vendor/libghostty-vt");
    let target = env::var("TARGET").unwrap();
    let zig = env::var_os("ZIG").unwrap_or_else(|| "zig".into());
    let status = Command::new(zig)
        .current_dir(&vendor)
        .args([
            "build",
            "-Demit-lib-vt",
            "-Doptimize=ReleaseFast",
            "-Demit-xcframework=false",
            &format!("-Dtarget={}", zig_target(&target)),
        ])
        .status()
        .expect("failed to run Zig 0.15; install zig or set ZIG");
    assert!(status.success(), "vendored libghostty-vt Zig build failed");

    println!(
        "cargo:rustc-link-search=native={}",
        vendor.join("zig-out/lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");
}
