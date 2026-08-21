#!/usr/bin/env python3
"""Remove the code signature from a thin 64-bit Mach-O (POD-2501 spike).

Why this exists: `bun build --compile --target=bun-darwin-*` ALREADY emits an
ad-hoc, linker-signed Mach-O (CodeSignatureFlags(ADHOC | LINKER_SIGNED),
identifier `a.out`). So the spike's original "podium.unsigned" copy was never
unsigned, and the brief's "unsigned should fail, ad-hoc should pass" failure
mode could not be probed with it. This strips the signature for real:

  * drops the LC_CODE_SIGNATURE load command,
  * shrinks the __LINKEDIT segment to the signature's start offset,
  * truncates the file there.

macOS on arm64 refuses to execute a Mach-O with no signature at all, so the
result is a valid negative control both for the on-Mac probe and for the Linux
assertion script's signature checks.

Usage: macho-strip-signature.py <in> <out>
"""
import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
MH_CIGAM_64 = 0xCFFAEDFE
LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D
PAGE = 0x4000


def die(msg: str) -> None:
    print(f"macho-strip-signature: {msg}", file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    if len(sys.argv) != 3:
        die("usage: macho-strip-signature.py <in> <out>")
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as fh:
        buf = bytearray(fh.read())

    (magic,) = struct.unpack_from("<I", buf, 0)
    if magic == MH_CIGAM_64:
        die("big-endian Mach-O not supported")
    if magic != MH_MAGIC_64:
        die(f"not a thin 64-bit Mach-O (magic {magic:#x}); fat binaries unsupported")

    ncmds, sizeofcmds = struct.unpack_from("<II", buf, 16)
    hdr = 32

    sig_off = sig_cmd_off = sig_dataoff = sig_datasize = None
    linkedit_cmd_off = None
    off = hdr
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", buf, off)
        if cmd == LC_CODE_SIGNATURE:
            sig_cmd_off = off
            sig_dataoff, sig_datasize = struct.unpack_from("<II", buf, off + 8)
        elif cmd == LC_SEGMENT_64:
            name = buf[off + 8 : off + 24].split(b"\0")[0]
            if name == b"__LINKEDIT":
                linkedit_cmd_off = off
        off += cmdsize
    del sig_off

    if sig_cmd_off is None:
        die("binary has no LC_CODE_SIGNATURE — nothing to strip (already unsigned?)")
    if linkedit_cmd_off is None:
        die("binary has no __LINKEDIT segment")

    (sig_cmdsize,) = struct.unpack_from("<I", buf, sig_cmd_off + 4)

    # 1) drop the LC_CODE_SIGNATURE load command, compacting the ones after it.
    lc_end = hdr + sizeofcmds
    tail = bytes(buf[sig_cmd_off + sig_cmdsize : lc_end])
    buf[sig_cmd_off : sig_cmd_off + len(tail)] = tail
    for i in range(sig_cmd_off + len(tail), lc_end):
        buf[i] = 0
    struct.pack_into("<II", buf, 16, ncmds - 1, sizeofcmds - sig_cmdsize)
    if linkedit_cmd_off > sig_cmd_off:
        linkedit_cmd_off -= sig_cmdsize

    # 2) shrink __LINKEDIT to end where the signature began.
    le_vmaddr, le_vmsize, le_fileoff, le_filesize = struct.unpack_from(
        "<QQQQ", buf, linkedit_cmd_off + 24
    )
    new_filesize = sig_dataoff - le_fileoff
    if new_filesize <= 0:
        die("computed a non-positive __LINKEDIT filesize; refusing to write")
    new_vmsize = (new_filesize + PAGE - 1) & ~(PAGE - 1)
    struct.pack_into(
        "<QQQQ", buf, linkedit_cmd_off + 24, le_vmaddr, new_vmsize, le_fileoff, new_filesize
    )

    # 3) truncate the file at the signature offset.
    out = bytes(buf[:sig_dataoff])
    with open(dst, "wb") as fh:
        fh.write(out)

    print(
        f"stripped LC_CODE_SIGNATURE: dataoff={sig_dataoff} datasize={sig_datasize} "
        f"__LINKEDIT filesize {le_filesize} -> {new_filesize}; {len(buf)} -> {len(out)} bytes"
    )


if __name__ == "__main__":
    main()
