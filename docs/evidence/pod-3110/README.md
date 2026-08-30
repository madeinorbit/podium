# POD-3110 Grok paired final-tip instrument

Static preflight instrument for journey `grok-paired-final-tip`. It is pinned to product/server/daemon/web source `057755c77a6bdfdf01aa526d968562b0316e78df` and Grok `0.2.118 (1e1687c1cf) [stable]`, binary SHA-256 `c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6`.
Product dependency provenance: `bun.lock` SHA-256 `a1acc741d62d99b4146d5989a06a50ce494a9e93219b59e49af3ac4307430791`; launch refuses unless root `node_modules` is a real directory and `@podium/runtime` plus `@podium/model` resolve inside this checkout. The exact `057755c` web bundle is not currently present and must be built later under an explicitly granted `test:heavy` lease.

This commit contains no live readings. Do not run it until POD-1761 explicitly releases a live slot. OpenCode owns that sole future provider drive.

## Isolation and arm contract

The named instance is `p3110-grok-paired-057755c`; the product derives its state root, agent home, and ports. The launch path inherits `HOME` and assigns none of `HOME`, `PODIUM_STATE_DIR`, `ABDUCO_SOCKET_DIR`, or `PODIUM_RUNTIME_DRIVER`. It scrubs inherited relay/default-instance variables, refuses ports 19797 and 32090 through the product-derived port check, and uses a unique cwd per cell.

The terminal arm creates sessions without a runtime selection and refuses unless the observed binding is `generic-pty` / `terminal` with no requested driver. The experimental arm creates each session with explicit `runtimeContract: 'grok-acp'` and refuses unless requested and observed driver are both `grok-acp` / `server`.

Credential posture is an eventual symlink from the inherited operator home into the named instance's product-derived agent home. No token is copied or printed. The logged-out probe temporarily moves only that named-instance symlink and restores it.

## Live sequence after release

Run arms sequentially, never concurrently:
Before any build, run `bun run setup:worktree` and require its checkout-local dependency graph. Never share, copy, symlink, or bind-mount a complete `node_modules` tree, and never use the historical `link-node-modules.sh` pattern.


1. Source `rig-env.sh`; confirm derived ports are unique and not 19797/32090.
2. Build once only while holding an explicitly granted heavy slot; release it immediately afterward.
3. `rig.sh up terminal`, then `drive.ts terminal`, then `rig.sh down`.
4. `rig.sh up headless`, then `drive.ts headless`, then `rig.sh down`.
5. Validate candidate rows with `awk -F'\t' 'NF != 8 { print NR ":" NF; bad=1 } END { exit bad }'` before appending them once to the epic ledger.

`rig.sh verify ARM CELL` gates every cell on checkout HEAD, server and daemon spawn stamps/PIDs/cwds/environments, served web stamp, provider-binary hash, instance identity, inherited HOME, absent forbidden variables, and available memory. A missing positive control records BLOCKED rather than inventing a product verdict.

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

The rig stops only server/daemon PIDs written beneath `/tmp/pod-3110-grok-paired-057755c`, after pin checks identify their exact cwd and instance environment. The runner kills only session UUIDs it created. It never enumerates or stops the operator/default daemon, never uses substring `pgrep -f`, never accesses the default `instance.json`, and retains the isolated derived state for evidence review.
