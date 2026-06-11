# Vendored abduco

Upstream: https://github.com/martanne/abduco @ 8c32909 (v0.6, ISC license — see LICENSE).

abduco provides session {at,de}tach support: a daemonized master holds the
application's PTY and pipes bytes transparently (no grid, no copy-mode, no status
chrome). podium uses it as the durable PTY backend so agent sessions survive
daemon restarts while xterm.js stays the only terminal emulator in the stack.

The build is a single translation unit (abduco.c #includes the rest);
src/abduco-bin.ts compiles it on demand with the same flags as the upstream
Makefile and caches the binary under $PODIUM_STATE_DIR/bin (else ~/.podium/bin).
config.h is upstream's config.def.h verbatim.

Local changes: none.
