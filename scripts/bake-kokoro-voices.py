#!/usr/bin/env python3
"""Inject local Kokoro voice packs into an existing Kokoro GGUF.

    bake-kokoro-voices.py <base.gguf> <out.gguf> <voice.pt> [<voice.pt> ...]

Each pack is added as tensor `kokoro.voice_tensors.<name>` (name = filename
minus .pt) and appended to the `kokoro.voices` metadata array, which is how
TTS.cpp discovers selectable voices (`--voice` selects among embedded voices;
it never loads from disk). Everything else is copied verbatim, following the
copy pattern of llama.cpp's gguf_new_metadata.py.

Deps (from nix, .#bake devshell): python3Packages.gguf, python3Packages.torch.
"""
import sys
from pathlib import Path

import gguf
import torch

VOICES_KEY = "kokoro.voices"
TENSOR_PREFIX = "kokoro.voice_tensors."


def die(msg: str) -> None:
    print(f"bake-kokoro-voices: {msg}", file=sys.stderr)
    sys.exit(1)


def main(argv: list[str]) -> None:
    if len(argv) < 4:
        die(f"usage: {Path(argv[0]).name} <base.gguf> <out.gguf> <voice.pt> [...]")
    base, out, packs = argv[1], argv[2], argv[3:]

    names = []
    for p in packs:
        name = Path(p).name
        if not name.endswith(".pt"):
            die(f"voice pack must be a .pt file: {p}")
        name = name.removesuffix(".pt")
        if name in names:
            die(f"duplicate voice name: {name}")
        names.append(name)

    reader = gguf.GGUFReader(base, "r")
    arch = reader.get_field("general.architecture").contents()
    voices_field = reader.get_field(VOICES_KEY)
    if voices_field is None:
        die(f"{base} has no {VOICES_KEY} array; not a Kokoro gguf?")
    voices = list(voices_field.contents())
    for name in names:
        if name in voices:
            die(f"voice '{name}' already embedded in {base}")

    writer = gguf.GGUFWriter(out, arch=arch, endianess=reader.endianess)
    alignment = reader.get_field("general.alignment")
    if alignment is not None:
        writer.data_alignment = alignment.contents()

    # Metadata: copy everything except virtual/writer-owned fields; extend
    # the voices array with the new names.
    for field in reader.fields.values():
        if field.name == "general.architecture" or field.name.startswith("GGUF."):
            continue
        if field.name == VOICES_KEY:
            writer.add_array(VOICES_KEY, voices + names)
            continue
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        writer.add_key_value(field.name, field.contents(), val_type, sub_type=sub_type)

    # Tensor info: existing first, then the new voice packs. Data writes below
    # must follow the same order.
    for tensor in reader.tensors:
        writer.add_tensor_info(
            tensor.name, tensor.data.shape, tensor.data.dtype,
            tensor.data.nbytes, tensor.tensor_type,
        )
    new_tensors = []
    for name, pack_path in zip(names, packs):
        pack = torch.load(pack_path, weights_only=True, map_location="cpu")
        # Upstream packs are (510, 1, 256); squeeze to (510, 256). squeeze(1)
        # is a no-op if the pack is already squeezed.
        data = pack.squeeze(1).to(torch.float32).numpy()
        writer.add_tensor_info(TENSOR_PREFIX + name, data.shape, data.dtype, data.nbytes)
        new_tensors.append(data)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()
    for tensor in reader.tensors:
        writer.write_tensor_data(tensor.data)
    for data in new_tensors:
        writer.write_tensor_data(data)
    writer.close()

    total = ", ".join(voices + names)
    print(f"bake-kokoro-voices: wrote {out} with voices: {total}")


if __name__ == "__main__":
    main(sys.argv)
