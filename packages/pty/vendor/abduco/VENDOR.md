# Vendored abduco

Upstream: https://github.com/martanne/abduco @ 8c32909 (v0.6, ISC license — see LICENSE).

abduco provides session {at,de}tach support: a daemonized master holds the
application's PTY and pipes bytes transparently (no grid, no copy-mode, no status
chrome). Every podium release before POD-4986 ran its sessions in abduco masters.
Nothing starts one any more — new sessions run on podium-host
(`../podium-host`) — and this source is kept ONLY as the attach client for
ADOPTING sessions an older release started: the daemon attaches, lists and
kills those masters through it (`src/abduco.ts`, `abducoAdoptionAdapter` in
`src/durable-process.ts`), so an upgraded machine keeps every running session.
Releases keep shipping the client prebuilt. A later issue replaces it with a
native TypeScript implementation of abduco's socket protocol and then deletes
this directory.

The build is a single translation unit (abduco.c #includes the rest);
src/abduco-bin.ts compiles it on first need with the same flags as the upstream
Makefile and caches the binary under $PODIUM_STATE_DIR/bin (else ~/.podium/bin).
That is the only C a source checkout still compiles.
config.h is upstream's config.def.h verbatim.

Local changes:

- `abduco.c`: a `--podium-features` option that prints the feature level the
  binary was built with (`-DPODIUM_ABDUCO_FEATURES`, stamped by
  `src/abduco-bin.ts`) and exits 0. An upstream abduco rejects the option and
  exits non-zero, which is how the resolver tells a podium build from a distro
  one and refuses to run patched-abduco features on an unpatched binary
  [spec:SP-6144]. Bump `ABDUCO_FEATURES` in `src/abduco-bin.ts` whenever a patch
  changes what callers may rely on.
