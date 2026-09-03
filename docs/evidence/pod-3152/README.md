# POD-3152 Grok paired final-tip instrument

Static preflight instrument for journey `grok-paired-final-tip`. Product, server, and daemon are pinned to `0d180cc0455832ffe93edf2ac450a47f5f7c8137`; the web artifact is stamped `5d7eb60`, the current harness commit whose non-doc product bytes are required by the rig to match that exact product pin. Grok is pinned to `grok 0.2.118 (1e1687c1cf) [stable]`, binary SHA-256 `c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6`.
Product dependency provenance: `bun.lock` SHA-256 `a1acc741d62d99b4146d5989a06a50ce494a9e93219b59e49af3ac4307430791`; launch requires root `node_modules` to be a real checkout-local topology directory and verifies the server and daemon package-local `@podium` links actually consumed at launch resolve inside this checkout.

The web artifact was rebuilt at `2026-08-31T06:33:01+02:00` from clean harness checkout `5d7eb604b94b8efdc9bb3bc101e733ef558bbcad`. The build stamp and manifest both name `5d7eb60`; all 659 manifested payload hashes passed, and the complete 660-file tree totals 38,595,752 bytes. The lexically sorted complete-tree per-file SHA-256 inventory, with paths normalized relative to `apps/web/dist` and lines formatted as `<hash>  <relative-path>`, hashes to `a62cf7c77d47ddfa82ca14eb7f281b22d9e9ecde602b76bc37d348e1f1574436`. The initially inspected integration/32090 source was rejected without modification because its stamp endpoint was absent. The exact build held `test:heavy` while installing checkout-local dependencies and building; the lease was released immediately after the artifact was verified.

This commit contains no live readings. Do not run it until POD-1761 explicitly releases a live slot. Grok is the sole provider column; Claude refused before launch because its credential was expired.

## Isolation and arm contract

The current named instance is `p3152-grok-reply-0d180cc-r10`; the product-derived tuple `37325/37326/37327` is frozen as part of that rig identity, while the state root, agent home, and canonical socket root remain product-derived. The prior POD-3110 r9 state root and run files are retained unchanged as refusal evidence and are never reused. The launch path inherits `HOME` and assigns none of `HOME`, `PODIUM_STATE_DIR`, `ABDUCO_SOCKET_DIR`, or `PODIUM_RUNTIME_DRIVER`. It scrubs inherited relay/default-instance variables, asserts the exact frozen tuple, separately requires all three ports free and pairwise distinct, refuses ports 19797 and 32090, and uses a unique cwd per cell.

The headed terminal arm creates each session with explicit `runtimeContract: 'generic-pty'` and refuses unless requested and observed driver are both `generic-pty` / `terminal`. The experimental arm creates each session with explicit `runtimeContract: 'grok-acp'` and refuses unless requested and observed driver are both `grok-acp` / `server`.

Credential posture is an eventual symlink from the inherited operator home into the named instance's product-derived agent home. No token is copied or printed. The logged-out probe temporarily moves only that named-instance symlink and restores it.

## Live sequence after release

Run arms sequentially, never concurrently. Before launch, run `bun run setup:worktree` in this checkout and require its checkout-local dependency graph. Never share, copy, symlink, or bind-mount a complete `node_modules` tree, and never use the historical `link-node-modules.sh` pattern.


1. Source `rig-env.sh`; confirm the derived tuple is exactly `37325/37326/37327`, pairwise unique, free, and not 19797/32090.
2. Revalidate the prepared child's exact web stamp and manifest; do not rebuild during launch.
3. For a released headed A1a cell, set `P3152_CELLS=A1a` and run `run-headed-a1a.sh`. This atomic wrapper keeps server, daemon, drive, and targeted teardown inside one shell/tool lifetime; it independently derives and requires the exact fresh named whole-state root, refuses reserved or missing derived listeners, and never accesses operator/default `instance.json`.
4. Never split `rig.sh up`, the headed drive, and `rig.sh down` across tool invocations: the tool boundary reaps those children when the `up` shell returns. Never use `setsid` or detached children as proof.
5. The headless sequence requires its own explicit live release and equivalent atomic wrapper; it is not authorized by the headed wrapper.
6. Validate candidate rows with `awk -F'\t' 'NF != 8 { print NR ":" NF; bad=1 } END { exit bad }'` before appending them once to the epic ledger.

`rig.sh verify ARM CELL` gates every cell on checkout HEAD, server and daemon spawn stamps/PIDs/cwds/environments, served web stamp, declared provider-binary hash, instance identity, inherited HOME, absent forbidden variables, and available memory. After the session starts but before any prompt is sent, the runner skips every owned PID whose `/proc/<pid>/exe` realpath is not the declared Grok binary, then hashes only the exact match without executing a second provider. It requires the provider PID's `HOME` and `GROK_HOME` to equal the product-derived named-instance agent locations and `ABDUCO_SOCKET_DIR` to equal the canonical short root derived by the exported `instanceSocketRuntimeDir` source helper; legacy and traversal aliases are refused by literal equality. Ambient credential-home overrides must be absent, and the receipt records the declared version as derived from those exact bytes. A missing positive control records BLOCKED rather than inventing a product verdict.

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

The rig stops only server/daemon PIDs written beneath `/tmp/pod-3152-grok-reply-0d180cc-r10`, after pin checks identify their exact cwd and instance environment. The runner kills only session UUIDs it created. It never enumerates or stops the operator/default daemon, never uses substring `pgrep -f`, never accesses the default `instance.json`, and retains the isolated derived state for evidence review.
