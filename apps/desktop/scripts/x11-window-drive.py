#!/usr/bin/env python3
"""Tiny X11 boundary driver used by the native desktop runtime harnesses."""

from __future__ import annotations

import ctypes
import os
import sys
import time


X11 = ctypes.cdll.LoadLibrary("libX11.so.6")
XTST = ctypes.cdll.LoadLibrary("libXtst.so.6")
DISPLAY = ctypes.c_void_p
WINDOW = ctypes.c_ulong

X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XOpenDisplay.restype = DISPLAY
X11.XDefaultRootWindow.argtypes = [DISPLAY]
X11.XDefaultRootWindow.restype = WINDOW
X11.XQueryTree.argtypes = [
    DISPLAY,
    WINDOW,
    ctypes.POINTER(WINDOW),
    ctypes.POINTER(WINDOW),
    ctypes.POINTER(ctypes.POINTER(WINDOW)),
    ctypes.POINTER(ctypes.c_uint),
]
X11.XQueryTree.restype = ctypes.c_int
X11.XFetchName.argtypes = [DISPLAY, WINDOW, ctypes.POINTER(ctypes.c_char_p)]
X11.XFetchName.restype = ctypes.c_int
X11.XFree.argtypes = [ctypes.c_void_p]
X11.XSetInputFocus.argtypes = [DISPLAY, WINDOW, ctypes.c_int, ctypes.c_ulong]
X11.XRaiseWindow.argtypes = [DISPLAY, WINDOW]
X11.XStringToKeysym.argtypes = [ctypes.c_char_p]
X11.XStringToKeysym.restype = ctypes.c_ulong
X11.XKeysymToKeycode.argtypes = [DISPLAY, ctypes.c_ulong]
X11.XKeysymToKeycode.restype = ctypes.c_ubyte
X11.XFlush.argtypes = [DISPLAY]
X11.XCloseDisplay.argtypes = [DISPLAY]
XTST.XTestFakeKeyEvent.argtypes = [DISPLAY, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
XTST.XTestFakeKeyEvent.restype = ctypes.c_int


def window_name(display: DISPLAY, window: int) -> str:
    raw = ctypes.c_char_p()
    if not X11.XFetchName(display, WINDOW(window), ctypes.byref(raw)) or not raw.value:
        return ""
    try:
        return raw.value.decode("utf-8", errors="replace")
    finally:
        X11.XFree(raw)


def find_window(display: DISPLAY, needle: str) -> tuple[int, str] | None:
    pending = [int(X11.XDefaultRootWindow(display))]
    while pending:
        current = pending.pop()
        name = window_name(display, current)
        if needle in name:
            return current, name
        root = WINDOW()
        parent = WINDOW()
        children = ctypes.POINTER(WINDOW)()
        count = ctypes.c_uint()
        if X11.XQueryTree(
            display,
            WINDOW(current),
            ctypes.byref(root),
            ctypes.byref(parent),
            ctypes.byref(children),
            ctypes.byref(count),
        ):
            try:
                pending.extend(int(children[index]) for index in range(count.value))
            finally:
                if children:
                    X11.XFree(children)
    return None


def wait_window(display: DISPLAY, needle: str, timeout: float) -> tuple[int, str]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = find_window(display, needle)
        if found:
            return found
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for an X11 window titled {needle!r}")


KEYSYM_NAMES = {
    "-": "minus",
    "_": "underscore",
    ".": "period",
    "@": "at",
    "/": "slash",
    " ": "space",
}


def tap(display: DISPLAY, name: str, shifted: bool = False) -> None:
    keysym = X11.XStringToKeysym(name.encode())
    keycode = int(X11.XKeysymToKeycode(display, keysym))
    if keycode == 0:
        raise RuntimeError(f"X11 has no keycode for {name!r}")
    shift = int(X11.XKeysymToKeycode(display, X11.XStringToKeysym(b"Shift_L")))
    if shifted:
        XTST.XTestFakeKeyEvent(display, shift, 1, 0)
    XTST.XTestFakeKeyEvent(display, keycode, 1, 0)
    XTST.XTestFakeKeyEvent(display, keycode, 0, 0)
    if shifted:
        XTST.XTestFakeKeyEvent(display, shift, 0, 0)
    X11.XFlush(display)
    time.sleep(0.018)


def type_text(display: DISPLAY, text: str) -> None:
    for character in text:
        shifted = character.isalpha() and character.isupper()
        name = KEYSYM_NAMES.get(character, character.lower() if shifted else character)
        tap(display, name, shifted)


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in {"title", "type"}:
        print(
            "usage: x11-window-drive.py title|type <title-substring> [timeout-seconds]",
            file=sys.stderr,
        )
        return 2
    display_name = os.environ.get("DISPLAY")
    display = X11.XOpenDisplay(display_name.encode() if display_name else None)
    if not display:
        raise RuntimeError(f"cannot open X display {display_name!r}")
    try:
        timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 15.0
        window, title = wait_window(display, sys.argv[2], timeout)
        if sys.argv[1] == "title":
            print(title)
            return 0
        secret = sys.stdin.read().rstrip("\n")
        if not secret:
            raise RuntimeError("refusing to type an empty secret")
        X11.XRaiseWindow(display, WINDOW(window))
        # RevertToParent=2, CurrentTime=0. The login input autofocuses; this chooses the
        # real WebKitGTK window before sending hardware-shaped keyboard events.
        X11.XSetInputFocus(display, WINDOW(window), 2, 0)
        X11.XFlush(display)
        time.sleep(0.25)
        type_text(display, secret)
        tap(display, "Return")
        return 0
    finally:
        X11.XCloseDisplay(display)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"x11-window-drive: {error}", file=sys.stderr)
        raise SystemExit(1)
