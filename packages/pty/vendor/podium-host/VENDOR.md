# podium-host

Podium's own durable process host — not a third-party import. `host.c` is
written and maintained in this repository (POD-3190 stage 6, SPEC-6) and is
licensed with the rest of Podium (see `LICENSE`). It replaces the vendored,
patched abduco under `../abduco`, which stays as the second adapter until every
machine runs the host.

Build: `packages/pty/src/host-bin.ts` compiles this single translation unit
with the system C compiler into `$PODIUM_STATE_DIR/bin/podium-host-v<features>/`.
Protocol and command line: SPEC-6 (POD-3190 artifact #31).
