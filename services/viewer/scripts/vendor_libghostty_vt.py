#!/usr/bin/env python3
"""Refresh the pinned libghostty-vt dist from a clean Ghostty checkout."""
import argparse
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def output(*args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="clean Ghostty checkout at the desired commit")
    args = parser.parse_args()
    source = args.source.resolve()
    if output("git", "status", "--porcelain", cwd=source):
        raise SystemExit("source checkout must be clean")
    commit = output("git", "rev-parse", "HEAD", cwd=source)
    subprocess.run(
        ["zig", "build", "dist", "-Demit-lib-vt", "-Doptimize=ReleaseFast"],
        cwd=source,
        check=True,
    )
    archives = sorted((source / "zig-out/dist").glob(f"libghostty-vt-*+{commit[:9]}.tar.gz"))
    if not archives:
        raise SystemExit("Zig did not produce the expected libghostty-vt archive")
    archive = archives[-1]
    root = Path(__file__).resolve().parent.parent
    destination = root / "vendor/libghostty-vt"
    with tempfile.TemporaryDirectory() as temporary:
        with tarfile.open(archive, "r:gz") as bundle:
            names = {item.name.split("/", 1)[0] for item in bundle.getmembers() if item.name}
            if len(names) != 1:
                raise SystemExit("archive must have exactly one root directory")
            bundle.extractall(temporary, filter="data")
        extracted = Path(temporary) / names.pop()
        shutil.rmtree(destination)
        shutil.copytree(extracted, destination)
    metadata = {
        "source_commit": commit,
        "dist_archive": archive.name,
        "extracted_dir": extracted.name,
    }
    (root / "vendor/libghostty-vt.vendor.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
