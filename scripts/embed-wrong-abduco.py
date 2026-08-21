#!/usr/bin/env python3
"""Overwrite the abduco helper embedded in a compiled binary with another platform's.

Builds the negative control for the check the matrix collapse most threatens: a
perfectly good Darwin Mach-O that carries the LINUX abduco. No format check can
see that — only comparing the embedded bytes against the reference helper can.

Rebuilding a whole bundle with a poisoned helper cache would prove the same thing
and costs a full compile; this finds the helper embedded verbatim and overwrites
exactly its bytes, so nothing else about the Mach-O shifts.

Usage: embed-wrong-abduco.py <binary> <expected-helper> <replacement-helper>
"""
import sys


def main() -> int:
    binary, expected, replacement = sys.argv[1], sys.argv[2], sys.argv[3]
    data = bytearray(open(binary, "rb").read())
    helper = open(expected, "rb").read()
    at = data.find(helper)
    if at < 0:
        print(
            f"{expected} is not embedded in {binary}; cannot build the mutation",
            file=sys.stderr,
        )
        return 1
    other = open(replacement, "rb").read()
    # Same length, so only the helper's own bytes change and every offset survives.
    padded = (other * (len(helper) // len(other) + 1))[: len(helper)]
    data[at : at + len(helper)] = padded
    open(binary, "wb").write(data)
    print(f"overwrote the embedded helper at offset {at} ({len(helper)} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
