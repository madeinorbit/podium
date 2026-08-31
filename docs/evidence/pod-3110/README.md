# POD-3110 Grok paired final-tip instrument

Static preflight instrument for journey `grok-paired-final-tip`. Product/server/daemon are pinned to `a4a209cc6d902db2c65db0e240a0dbb21aa9b014`; the web artifact remains at `057755c77a6bdfdf01aa526d968562b0316e78df` because `git diff 057755c77..a4a209cc -- apps/web` is empty. Grok is pinned to `grok 0.2.118 (1e1687c1cf) [stable]`, binary SHA-256 `c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6`.
Product dependency provenance: `bun.lock` SHA-256 `a1acc741d62d99b4146d5989a06a50ce494a9e93219b59e49af3ac4307430791`; launch requires root `node_modules` to be a real checkout-local topology directory and verifies the server and daemon package-local `@podium` links actually consumed at launch resolve inside this checkout.

The web artifact was prepared at `2026-08-31T01:06:47+02:00` from detached immutable checkout `057755c77a6bdfdf01aa526d968562b0316e78df`. The build stamp and manifest both name `057755c`; all 659 manifested payload hashes passed, and the complete 660-file, 38,601,248-byte copied tree matched the source tree byte-for-byte. The sorted complete-tree SHA-256 inventory digest is `7295f6c213957bf76c9fcc2dc2429a2e715c92d2c6a5c43434ceba02c059b952`. The initially inspected integration/32090 source was rejected without modification because its existing stamp named stale source `70fa13c`. The exact build held `test:heavy` only while installing checkout-local dependencies and building; its EXIT trap released the lease, which was confirmed free afterward.

This commit contains no live readings. Do not run it until POD-1761 explicitly releases a live slot. Grok is the sole provider column; Claude refused before launch because its credential was expired.

## Isolation and arm contract

The current named instance is `p3110-grok-paired-a4a209c-r6`; the product derives its isolated state root, agent home, and ports. The prior r1/r2/r3/r4/r5 state roots and run files are retained unchanged as refusal evidence and are never reused. The launch path inherits `HOME` and assigns none of `HOME`, `PODIUM_STATE_DIR`, `ABDUCO_SOCKET_DIR`, or `PODIUM_RUNTIME_DRIVER`. It scrubs inherited relay/default-instance variables, refuses ports 19797 and 32090 through the product-derived port check, and uses a unique cwd per cell.

The terminal arm creates sessions without a runtime selection and refuses unless the observed binding is `generic-pty` / `terminal` with no requested driver. The experimental arm creates each session with explicit `runtimeContract: 'grok-acp'` and refuses unless requested and observed driver are both `grok-acp` / `server`.

Credential posture is an eventual symlink from the inherited operator home into the named instance's product-derived agent home. No token is copied or printed. The logged-out probe temporarily moves only that named-instance symlink and restores it.

## Live sequence after release

Run arms sequentially, never concurrently. Before launch, run `bun run setup:worktree` in this checkout and require its checkout-local dependency graph. Never share, copy, symlink, or bind-mount a complete `node_modules` tree, and never use the historical `link-node-modules.sh` pattern.


1. Source `rig-env.sh`; confirm derived ports are unique and not 19797/32090.
2. Revalidate the prepared child's exact web stamp and manifest; do not rebuild during launch.
3. For a released headed A1a cell, set `P3110_CELLS=A1a` and run `run-headed-a1a.sh`. This atomic wrapper keeps server, daemon, drive, and targeted teardown inside one shell/tool lifetime; it refuses dead child PIDs or missing derived listeners and proves the inherited-home operator marker's hash, size, inode, and mtime unchanged after its EXIT-trap teardown.
4. Never split `rig.sh up`, the headed drive, and `rig.sh down` across tool invocations: the tool boundary reaps those children when the `up` shell returns. Never use `setsid` or detached children as proof.
5. The headless sequence requires its own explicit live release and equivalent atomic wrapper; it is not authorized by the headed wrapper.
6. Validate candidate rows with `awk -F'\t' 'NF != 8 { print NR ":" NF; bad=1 } END { exit bad }'` before appending them once to the epic ledger.

`rig.sh verify ARM CELL` gates every cell on checkout HEAD, server and daemon spawn stamps/PIDs/cwds/environments, served web stamp, declared provider-binary hash, instance identity, inherited HOME, absent forbidden variables, and available memory. After the session starts but before any prompt is sent, the runner skips every owned PID whose `/proc/<pid>/exe` realpath is not the declared Grok binary, then hashes only the exact match without executing a second provider. It requires the provider PID's `HOME` and `GROK_HOME` to equal the product-derived named-instance agent locations, `ABDUCO_SOCKET_DIR` to equal the derived isolated runtime socket directory, and ambient credential-home overrides to be absent; the receipt records the declared version as derived from those exact bytes. A missing positive control records BLOCKED rather than inventing a product verdict.

## Covered journeys

The serial runner covers:

- A1a/A1b/A1c first, subsequent, and exact-dead-session sends;
- A2a/A2b working status and launch/readiness;
- A3 durable interrupt with an in-flight growth control;
- A4a/A4b allow-once permission plus typed duplicate refusal and one side effect;
- A5 tool call/result persistence after transcript reload;
- A6a/A6b live native bytes and Chat/Native switching;
- A7a/A7b daemon restart and park/wake durability;
- A8 logged-out/login/error visibility and post-login recovery;
- A9 exact stamped child kill plus the complete 300-second no-rebound census;
- `CLI-sync`, a CLI-originated provider reply synchronized into Chat exactly once before and after replay;
- A11 repeated typed model/effort refusal with no immediate, reload, or restart mutation;
- A10 readiness/reconnect, plus provider-error and OOM-classification spot checks.

Every JSON result carries an ISO timestamp, measured latency, pin transcript, cell-specific positive control, cwd, session IDs, and raw evidence. Candidate TSV rows are exactly eight non-empty tab-separated fields and are deduplicated byte-for-byte; they are not appended to the shared ledger automatically.

## Targeted cleanup

The rig stops only server/daemon PIDs written beneath `/tmp/pod-3110-grok-paired-a4a209c-r6`, after pin checks identify their exact cwd and instance environment. The runner kills only session UUIDs it created. It never enumerates or stops the operator/default daemon, never uses substring `pgrep -f`, never accesses the default `instance.json`, and retains the isolated derived state for evidence review.
The atomic headed wrapper is the sole exception to the no-access statement: it reads only `$HOME/.podium/instance.json` metadata and bytes before and after the isolated run, never writes that marker, and refuses a missing or changed marker.
