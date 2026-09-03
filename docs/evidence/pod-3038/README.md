# POD-3038 — stale-pin acceptance redrive

Date of redrive: 2026-08-28 (CEST)

This evidence re-drives the four acceptance cells named by POD-3038 against the
current epic tip. The old readings were A6b/codex and A6b/opencode at pin
`7b7afc98`, and A3/codex and A8/opencode at pin `6685c59`; none of those pins is
the current product under test.

The required order was followed:

1. A6b chat↔CLI twice — Codex
2. A6b chat↔CLI twice — OpenCode
3. A3 interrupt mid-turn — Codex
4. A8 logged-out spawn — OpenCode

No `docs/plans/pod-1761-results.tsv` file was edited.

## Pins and rig

The current epic branch was clean at the time of each scored epic run:

| item | exact value |
|---|---|
| epic branch | `issue/3038-stale-pin-acceptance-redrive` |
| epic tip / product pin | `38a2d1a7ab9aa75550aff089cb632ce3f1aee368` |
| epic tip commit time | `2026-08-28 13:11:16 +0200` |
| epic tip subject | `docs(ledger): FOREST — 53 PASS, no cell known worse than main` |
| epic drive/spawn commit | `38a2d1a7ab9aa75550aff089cb632ce3f1aee368` |
| epic server | pid `390992`, cwd this worktree, spawn SHA `38a2d1a` |
| epic daemon during the four readings | pid `412120`, cwd this worktree, spawn SHA `38a2d1a` |
| epic served web bundle | `sourceSha=38a2d1a` |
| epic named instance | `p3038-redrive-b` |
| epic port | `19860` (hook `46860`, relay `46861`) |
| epic derived state root | `/home/mgw/.local/state/podium/p3038-redrive-b` |

The pin guard reported, immediately before each epic drive, one daemon on the
named instance, a clean product tree, the named non-operator port, served web
`38a2d1a`, `CONTRACT=1`, and `STREAMING=1`. The rig used
`PODIUM_ADOPT_STATE=1` only to adopt the `runtime/tmux` and `runtime/abduco`
directories created by the product's own instance preflight. It did not set
`PODIUM_STATE_DIR`, `PODIUM_AGENT_HOME`, `ABDUCO_SOCKET_DIR`, or `TMUX_TMPDIR`.

The exact-main comparisons used a separate named instance, not the operator's
default:

| item | exact value |
|---|---|
| local main comparison pin | `0bd90092c3a926b9305da34547fcc51b1e19b0a7` |
| main commit time | `2026-08-26 12:21:26 +0200` |
| main commit subject | `Test rigs use named instances` |
| main drive/spawn commit | `0bd90092c3a926b9305da34547fcc51b1e19b0a7` |
| main named instance | `p3038-main-b` |
| main product checkout | `/tmp/pod-2876-main` (clean, exact local main) |
| main server | pid `461244`, spawn SHA `0bd9009` |
| main daemon for A6b comparison | pid `461423`, spawn SHA `0bd9009` |
| main daemon for A3 comparison | pid `544615`, spawn SHA `0bd9009` |
| main served web bundle | `sourceSha=0bd9009` |
| main port | `19863` (hook `46863`, relay `46864`) |
| main derived state root | `/home/mgw/.local/state/podium/p3038-main-b` |

The final post-drive pin check restarted the epic daemon once, from the clean
product tree, at the same exact tip with pid `531635` and the supported Codex
binary. That restart was a provenance check only; it was not substituted for
any of the four readings above.

### Agent binaries

| binary | path | version used for the scored run |
|---|---|---|
| Bun | `/home/mgw/.bun/bin/bun` | `1.3.14` |
| Codex | `/home/mgw/.codex/packages/standalone/releases/0.149.1-x86_64-unknown-linux-musl/bin/codex` | `codex-cli 0.149.1` |
| OpenCode | `/home/mgw/.opencode/bin/opencode` | `1.18.16` |

The default `/home/mgw/.local/bin/codex` reports `codex-cli 0.150.1` and was
not used for a scored Codex run. The Codex daemon was explicitly restarted with
the supported `0.149.1` binary before A6b/codex and remained on that binary for
A3/codex. The main A6b OpenCode comparison used OpenCode `1.18.16`; the main
A3 comparison was then run after its daemon was restarted with Codex `0.149.1`.

The first epic daemon startup carrying the four readings reported the runtime
metadata `dev+38a2d1a-dirty` because a temporary, docs-only restart helper was
present while that process started. Its recorded server/daemon spawn SHA was
nevertheless the full `38a2d1a`, and the product tree was clean at every pin
guard. The helper was moved out of the worktree and the final same-tip restart
reported clean metadata `dev+38a2d1a`.

## A6b — Codex

Observed daemon session interval in the pinned epic log:
`2026-08-28 13:26:32–13:28:39 CEST`.

Session: `25a64822-aea4-49f4-bb6d-49101ee60694`.

- Bound driver: `codex-app-server`, family `server`.
- Positive controls fired before any switch: the chat answer arrived, the TUI
  painted the chat marker into scrollback, and the CLI nonce echoed.
- Baseline geometry: `120x40`; the agent census was `[420245, 420324]`.
- The exact sequence was `chat → CLI → chat → CLI`.

Switch observations:

| step | view | epoch | geometry | marker present | marker count | order | nonblank lines | terminal bytes | view processes |
|---|---|---:|---|---|---:|---|---:|---:|---:|
| 1 | chat | 0 | `120x40` | true | 2 | true | 21 | 15698 | 0 |
| 2 | CLI | 0 | `120x40` | true | 4 | false | 23 | 26529 | 3 |
| 3 | chat | 0 | `120x40` | true | 4 | false | 23 | 26529 | 0 |
| 4 | CLI | 0 | `120x40` | true | 4 | false | 23 | 37219 | 3 |

- No-restart witnesses passed: epoch stayed `0` and the agent pid set stayed
  unchanged. The appearing attach-client processes were recorded, not counted
  as agent restarts.
- After the switches, chat answered (`CHATAFTER-CTGPQE`) and CLI typing echoed
  (`+11109` terminal bytes).
- The probe printed aggregate `A6b PASS`, but its own text says the scrollback
  corruption check is `UNMEASURED`: marker presence is necessary but not
  sufficient, marker count growth can be a repaint, and the line-order test is
  too strict for a terminal repaint/reflow.

Clause and plane scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| both directions twice | chat/CLI switching | four declared switches completed in the required order | PASS |
| no restart | session/terminal | epoch `0` throughout; agent pids unchanged | PASS |
| no scrollback corruption | terminal scrollback | calibrated instrument explicitly cannot distinguish corruption from repaint | UNMEASURED |
| correct size | terminal | geometry stayed `120x40` | PASS |
| chat still answers after switching | chat | `true`, nonce received | PASS |
| CLI still echoes after switching | CLI | `true`, `+11109` bytes | PASS |

VERDICT — A6b/codex: **PARTIAL, not green** — the positive control fired; no-restart, correct-size, both-view functionality, and both post-switch actions passed, but the no-scrollback-corruption clause remains unmeasured by the probe.

## A6b — OpenCode

Observed daemon session interval in the pinned epic log:
`2026-08-28 13:29:49–13:31:53 CEST`.

Session: `b1bbfbd4-f3d0-4493-957a-1dd90ddf8d2e`.

- Bound driver: `opencode-server`, family `server`.
- Positive controls fired before any switch: chat answered, the TUI painted the
  marker, and the CLI nonce echoed.
- Baseline geometry: `120x40`; the agent census was `[439304, 439541]`.
- The exact sequence was `chat → CLI → chat → CLI`.

Switch observations:

| step | view | epoch | geometry | marker present | marker count | order | nonblank lines | terminal bytes | view processes |
|---|---|---:|---|---|---:|---|---:|---:|---:|
| 1 | chat | 0 | `120x40` | true | 2 | true | 1 | 45953 | 0 |
| 2 | CLI | 0 | `120x40` | true | 4 | false | 1 | 78133 | 3 |
| 3 | chat | 0 | `120x40` | true | 4 | false | 1 | 78133 | 0 |
| 4 | CLI | 0 | `120x40` | true | 4 | false | 1 | 110120 | 3 |

- No-restart witnesses passed: epoch stayed `0` and the agent pid set stayed
  unchanged.
- After the switches, chat answered (`CHATAFTER-SW8SH1`).
- After the switches, CLI typing did not echo (`false`, although the terminal
  accumulated `+32735` bytes).
- The probe printed aggregate `A6b FAIL`. The scrollback clause is still
  `UNMEASURED`, for the same instrument reason as Codex.

Clause and plane scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| both directions twice | chat/CLI switching | four declared switches completed in the required order | PASS |
| no restart | session/terminal | epoch `0` throughout; agent pids unchanged | PASS |
| no scrollback corruption | terminal scrollback | calibrated instrument explicitly cannot distinguish corruption from repaint | UNMEASURED |
| correct size | terminal | geometry stayed `120x40` | PASS |
| chat still answers after switching | chat | `true`, nonce received | PASS |
| CLI still echoes after switching | CLI | `false`, `+32735` bytes arrived but the nonce was not visible | FAIL |

### Required exact-main comparison for the A6b/OpenCode failure

The main comparison ran at pin `0bd90092c3a926b9305da34547fcc51b1e19b0a7` on
`p3038-main-b`, from `2026-08-28 13:38:16` to `13:40:45 CEST`.

Session: `dc8b356c-e256-4ee3-88d8-26e6b5add75d`.

The session never bound a driver: `spawnFailure: /home/mgw/.local/state/podium/p3038-main-b/bin/abduco exited 1: create-session: File name too long`. The positive control did not fire, so this run was discarded as `REFUSED`; it is not a main pass or fail. Main is therefore undriveable for this arm, and the epic OpenCode CLI failure is a valid current-tip failure but cannot be called a regression from this A/B.

VERDICT — A6b/opencode: **FAIL on the current epic tip; regression status unresolved** — the positive control fired, the chat plane passed, the CLI plane failed after the switches, and scrollback corruption is unmeasured. The exact-main comparator was discarded because its control did not fire (`File name too long`), so no worse-than-main claim is made.

## A3 — Codex

Run window: `2026-08-28 13:41:15–13:42:31 CEST`.

Session: `1f399da3-49e8-4d30-8ea9-f92cd3c17646`.

- Pin printed by the probe: server pid `390992` and daemon pid `412120`, both
  spawned at `38a2d1a7a`.
- Bound driver: `codex-app-server`, family `server`.
- Positive control fired: `8` live preview frames arrived while phase was
  `working`; there were `0` durable transcript characters and `0` terminal
  bytes at the control sample, but the token-shaped preview signal was live.
- `sessions.interrupt` returned `{"ok":true,"requested":"protocol"}`.
- The turn left `working` after `536ms`; after the call the session was
  `phase=idle`, `status=live`, `error=none`. One residual preview frame arrived
  after the call, and terminal bytes stayed `0 → +0 → +0` at the 6s and 12s
  samples.
- No transcript item carried `event:'interrupt'`.
- The standalone probe printed `PASS turn stopped 536ms after interrupt, but
  nothing marks it`; its implementation scores the stop/output result while
  recording the marker only as evidence. The matrix score below applies the
  criterion clause by clause.

Clause scoring:

| criterion clause | plane | reading | score |
|---|---|---|---|
| positive control: turn was actually in flight | preview/token plane | `phase=working`, 8 preview frames | FIRED |
| turn stops | turn/state plane | phase left `working` in `536ms`; no continuing terminal output | PASS |
| transcript shows interrupt | transcript plane | no item carried `event:'interrupt'` | UNMET |
| refused interrupt says why | interrupt response plane | not applicable: the call returned `ok:true`, not a refusal | N/A |

### Required exact-main comparison for the A3 partial result

The main comparison ran at pin `0bd90092c3a926b9305da34547fcc51b1e19b0a7` on
`p3038-main-b`, from `2026-08-28 13:52:10` to `13:54:23 CEST`.

Session: `e540f0eb-e67f-4ae9-9f03-d65b1fabe46c`.

The session never bound a driver: `spawnFailure: /home/mgw/.local/state/podium/p3038-main-b/bin/abduco exited 1: create-session: File name too long`. The in-flight positive control did not fire, so this run was discarded as `REFUSED`; it is not a main A3 verdict. Main is undriveable on this named arm, so the missing transcript marker on the current epic run is not called a regression.

VERDICT — A3/codex: **PARTIAL, not a confirmed regression** — the positive control fired and the turn stopped, but the transcript interrupt marker was absent; the refusal clause was not applicable because the call was accepted. The exact-main comparator was discarded without a fired control.

## A8 — OpenCode

Run window: `2026-08-28 13:42:47–13:43:52 CEST`.

Session: `82926d69-6b45-487d-8672-5efdad142518`.

- The isolated named agent home initially contained the OpenCode credential at
  `/home/mgw/.local/state/podium/p3038-redrive-b/agent-home/.local/share/opencode/auth.json`.
- Positive control with the credential present fired: the session bound
  `opencode-server`, family `server`, status `live`.
- The credential was moved aside to the `.a8-parked` path for the logged-out
  half and restored to its original path after the drive. No credential was
  minted, rotated, or taken from the operator home.
- With the credential absent, the session reported
  `requestedDriverId=opencode-server`, actual `driverId=generic-pty`, family
  `terminal`, status `live`.
- The logged-out account readout reported `accounts.list loginRequired=true`.
  `interactions.list` offered no login interaction. The emitted condition was
  `(none)`/`undefined`, not a typed `logged-out` condition.
- The probe classified the driven first half as `PARTIAL` and intentionally did
  not perform the post-login OAuth half, because doing so could mint or rotate
  live credentials.

Clause scoring:

| criterion clause | plane | reading | score |
|---|---|---|---|
| positive control: authenticated spawn works | server-driver plane | credential-present session bound `opencode-server` | FIRED |
| gets a working login path | logged-out/session plane | declared requested-vs-actual demotion and `loginRequired=true`, but no login interaction was offered | PARTIAL |
| after login, next session lands on server driver | post-login server plane | not driven; OAuth credential safety prevented login | NOT DRIVEN |

VERDICT — A8/opencode: **PARTIAL** — the credential-present control fired; the logged-out demotion was observable and requested-vs-actual plus `loginRequired` were reported, but no working login affordance was exposed and the post-login server-binding half was not driven.

## Discarded runs and interpretation

- A6b/OpenCode on exact main: discarded as `REFUSED` because no session could be
  created and its positive control did not fire (`File name too long`).
- A3/Codex on exact main: discarded as `REFUSED` for the same no-session,
  no-control reason.
- The one-shot clean daemon restart after the epic readings connected, then its
  background process was reaped when the launcher exited; no acceptance probe
  used that process. It was relaunched under a held named rig and fully
  re-pinned at the same SHA before this README was written.

The current epic A6b/OpenCode failure and A3/Codex partial are therefore not
silently converted into passes, but neither is labelled a regression where the
exact-main arm could not produce a fired-control reading. Undriveable is a
measurement gap, not a pass.

This is evidence for coordinator transcription under POD-1761; the coordinator
should update the matrix rather than this README.

## Current-tip redrive — 2026-08-28 CEST

This appendix is the fresh redrive requested after POD-3036 stopped. It does
not replace the earlier `38a2d1a` readings and it does not edit
`docs/plans/pod-1761-results.tsv`. All four current-tip runs used the named
instance `p3038-redrive-c` and followed the required order again:

1. A6b chat↔CLI twice — Codex
2. A6b chat↔CLI twice — OpenCode
3. A3 interrupt mid-turn — Codex
4. A8 logged-out spawn — OpenCode

### Exact current pin and product tree

| item | exact value |
|---|---|
| coordinator epic tip / product pin | `5fe951f2fe5ff3300330d64a3a5b0a4df3a76fe2` |
| current-tip commit time | `2026-08-28 14:15:15 +0200` |
| current-tip subject | `Restore no-copy rig teardown scripts after rebase.` |
| source checkout | `/tmp/pod-3038-current-tip` (detached, clean) |
| epic drive/spawn commit | `5fe951f2fe5ff3300330d64a3a5b0a4df3a76fe2` |
| named instance | `p3038-redrive-c` |
| port / hook / relay | `19866` / `46866` / `46867` |
| state root | `/home/mgw/.local/state/podium/p3038-redrive-c` |
| server | pid `691538`, cwd `/tmp/pod-3038-current-tip`, spawn SHA `5fe951f2f` |
| daemon used for all four scored runs | pid `699026`, cwd `/tmp/pod-3038-current-tip`, spawn SHA `5fe951f2f` |
| served web bundle | `sourceSha=5fe951f` |

The pin guard passed immediately before each current-tip drive and again after
the four runs: one daemon on the named instance, clean product tree, named
non-operator port answering, served web `sourceSha=5fe951f`, `CONTRACT=1`,
and `STREAMING=1`. `PODIUM_ADOPT_STATE=1` was used only to adopt the
`runtime/tmux` and `runtime/abduco` directories created by instance
preflight; no state-directory, agent-home, socket-directory, or tmux-directory
override was used. Main was not merged into the epic branch.

The relevant product tree is not identical to the old `38a2d1a` pin. The exact
product diff from `38a2d1a7ab9aa75550aff089cb632ce3f1aee368` to the current tip
is:

- `apps/daemon/src/runtime/claude-sdk-driver.test.ts`
- `packages/agent-runtime/src/drivers/claude-sdk/classify.test.ts`
- `packages/agent-runtime/src/drivers/claude-sdk/classify.ts`
- `packages/agent-runtime/src/drivers/claude-sdk/runtime.test.ts`
- `packages/agent-runtime/src/drivers/claude-sdk/runtime.ts`
- `packages/model/src/entities/session.ts`

The current product changes therefore include Claude SDK runtime/classification
and shared session/model changes, in addition to the later evidence/docs work.

### Agent binaries

| binary | path | version used |
|---|---|---|
| Bun | `/home/mgw/.bun/bin/bun` | `1.3.14` |
| Codex | `/home/mgw/.codex/packages/standalone/releases/0.149.1-x86_64-unknown-linux-musl/bin/codex` | `codex-cli 0.149.1` |
| OpenCode | `/home/mgw/.opencode/bin/opencode` | `1.18.16` |

The default `/home/mgw/.local/bin/codex` reports `codex-cli 0.150.1` and
was not used for a scored Codex reading. The initial default-version daemon
startup was excluded; daemon pid `699026` was explicitly restarted with the
supported grandfathered Codex `0.149.1` before the first scored run and stayed
on that binary for A3/codex.

### A6b — Codex at `5fe951f2f`

Run window: `2026-08-28 14:22:07–14:24:35 CEST`.

Session: `dd3c99b5-2f5d-4491-b455-928532d9f1f5`.

- Bound driver: `codex-app-server`, family `server`.
- Positive controls fired before switching: chat answered, the TUI painted
  its marker, and the CLI nonce echoed (`13226` terminal bytes).
- Baseline epoch was `0`; geometry was `120x40`; agent pids were
  `[702572, 702677]`.
- The exact sequence was `chat → CLI → chat → CLI`.

Switch observations:

| step | view | epoch | geometry | marker | count | order | nonblank lines | terminal bytes | view processes |
|---|---|---:|---|---|---:|---|---:|---:|---:|
| 1 | chat | 0 | `120x40` | true | 2 | true | 21 | 13366 | 0 |
| 2 | CLI | 0 | `120x40` | true | 4 | false | 23 | 24091 | 5 |
| 3 | chat | 0 | `120x40` | true | 4 | false | 23 | 24091 | 0 |
| 4 | CLI | 0 | `120x40` | true | 4 | false | 23 | 34657 | 3 |

- Epoch stayed `0` and the agent pid set stayed unchanged throughout.
- After switching, chat answered with `CHATAFTER-SCINQ9` and CLI typing
  echoed (`+10850` terminal bytes).
- The standalone probe printed aggregate `A6b PASS`, but explicitly marks
  no-scrollback-corruption as `UNMEASURED`: marker presence is necessary but
  insufficient, and marker-count/order observations are not calibrated to
  distinguish terminal repaint/reflow from corruption.

Clause and plane scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| both directions twice | chat/CLI switching | four declared switches completed in order | PASS |
| no restart | session/terminal | epoch `0`; agent pids unchanged | PASS |
| no scrollback corruption | terminal scrollback | instrument cannot distinguish repaint/reflow from corruption | UNMEASURED |
| correct size | terminal | geometry stayed `120x40` | PASS |
| chat still answers after switching | chat | `CHATAFTER-SCINQ9` received | PASS |
| CLI still echoes after switching | CLI | `+10850` bytes; nonce visible | PASS |

VERDICT — A6b/codex at `5fe951f2f`: **PARTIAL, not green** — the positive
control fired; no-restart, correct-size, both-view functionality, and both
post-switch actions passed, while no-scrollback-corruption remains unmeasured.

### A6b — OpenCode at `5fe951f2f`

Run window: `2026-08-28 14:24:54–14:27:39 CEST`.

Session: `ef3f0cef-4589-4682-a75e-088204120152`.

- Bound driver: `opencode-server`, family `server`.
- Positive controls fired before switching: chat answered, the TUI painted
  its marker, and the CLI nonce echoed (`45652` terminal bytes).
- Baseline epoch was `0`; geometry was `120x40`; agent pids were
  `[720188, 720272]`.
- The exact sequence was `chat → CLI → chat → CLI`.

Switch observations:

| step | view | epoch | geometry | marker | count | order | nonblank lines | terminal bytes | view processes |
|---|---|---:|---|---|---:|---|---:|---:|---:|
| 1 | chat | 0 | `120x40` | true | 2 | true | 1 | 45748 | 0 |
| 2 | CLI | 0 | `120x40` | true | 4 | false | 1 | 77723 | 3 |
| 3 | chat | 0 | `120x40` | true | 4 | false | 1 | 77723 | 0 |
| 4 | CLI | 0 | `120x40` | true | 4 | false | 1 | 109505 | 3 |

- Epoch stayed `0` and the agent pid set stayed unchanged throughout.
- After switching, chat answered with `CHATAFTER-NFL8XO`.
- After switching, CLI typing did not echo (`false`), although the terminal
  accumulated `+32735` bytes.
- The standalone probe printed aggregate `A6b FAIL`; the scrollback clause
  remains `UNMEASURED` for the same instrument limitation as Codex.

Clause and plane scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| both directions twice | chat/CLI switching | four declared switches completed in order | PASS |
| no restart | session/terminal | epoch `0`; agent pids unchanged | PASS |
| no scrollback corruption | terminal scrollback | instrument cannot distinguish repaint/reflow from corruption | UNMEASURED |
| correct size | terminal | geometry stayed `120x40` | PASS |
| chat still answers after switching | chat | `CHATAFTER-NFL8XO` received | PASS |
| CLI still echoes after switching | CLI | `false`; `+32735` bytes arrived but nonce was not visible | FAIL |

VERDICT — A6b/opencode at `5fe951f2f`: **FAIL; regression status unresolved** —
the positive control fired, the chat plane passed, the CLI plane failed after
the switches, and scrollback corruption is unmeasured. The exact-main arm
below was discarded because its positive control did not fire, so this is not
called a regression.

#### Exact-main comparison for the current A6b/OpenCode failure

The exact-main comparison used named instance `p3038-main-c`, source checkout
`/tmp/pod-2876-main`, and clean local-main pin
`0bd90092c3a926b9305da34547fcc51b1e19b0a7`. Run window:
`2026-08-28 14:29:54–14:32:09 CEST`.

Session: `aa4e0480-e6cb-454c-a137-6ee3b8d76cd0`.

- Main server pid was `734492`, daemon pid was `734736`; both spawned at
  `0bd90092c3` and served web reported `sourceSha=0bd9009`.
- The session never bound a driver: `spawnFailure:
  /home/mgw/.local/state/podium/p3038-main-c/bin/abduco exited 1:
  create-session: File name too long`.
- The positive control did not fire. This run is discarded as `REFUSED`, not
  a main pass or fail; main is undriveable for this arm.

### A3 — Codex at `5fe951f2f`

Run window: `2026-08-28 14:32:29–14:33:37 CEST` (daemon session
`14:32:41–14:33:37 CEST`).

Session: `32d38bf0-2c79-4452-9e23-f0af215a91b1`.

- Pin printed by the probe: server pid `691538` and daemon pid `699026`,
  both spawned at `5fe951f2fe5ff3300330d64a3a5b0a4df3a76fe2`.
- Bound driver: `codex-app-server`, family `server`.
- The in-flight positive control fired: `7` preview frames arrived while
  phase was `working`; there were `0` durable transcript characters and
  `0` terminal bytes at the control sample, with a token-shaped preview signal.
- `sessions.interrupt` returned `{"ok":true,"requested":"protocol"}`.
- The turn left `working` after `525ms`; afterward phase was `idle`, status
  was `live`, and error was `none`.
- One residual preview frame arrived after the call; terminal bytes stayed
  `0 → +0 → +0` at the 6s and 12s samples.
- No transcript item carried `event:'interrupt'`.
- The standalone probe printed `PASS turn stopped 525ms after interrupt, but
  nothing marks it`; the matrix score below applies the criterion clauses
  separately.

Clause scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| positive control: turn was in flight | preview/token | phase `working`, 7 preview frames | FIRED |
| turn stops | turn/state | left `working` in `525ms`; no continuing terminal output | PASS |
| transcript shows interrupt | transcript | no item carried `event:'interrupt'` | UNMET |
| refused interrupt says why | interrupt response | not applicable; call returned `ok:true`, not a refusal | N/A |

VERDICT — A3/codex at `5fe951f2f`: **PARTIAL, not a confirmed regression** —
the positive control fired and the turn stopped, but the transcript interrupt
marker was absent; the refusal clause was not applicable because the call was
accepted.

#### Exact-main comparison for the current A3/Codex partial

The exact-main comparison used the same named main instance and clean local-main
pin `0bd90092c3a926b9305da34547fcc51b1e19b0a7`. Its run window was
`2026-08-28 14:34:51–14:37:06 CEST`.

Session: `87fba650-eabf-4264-ae0a-0e7e71d4f18c`.

- Main daemon was restarted with the supported Codex `0.149.1` binary before
  this comparison; its pid was `759758`, spawn SHA `0bd90092c3`.
- The session never bound a driver: `spawnFailure:
  /home/mgw/.local/state/podium/p3038-main-c/bin/abduco exited 1:
  create-session: File name too long`.
- The in-flight positive control did not fire. This run is discarded as
  `REFUSED`; it is not a main A3 verdict, and no regression claim is made.

The exact-main checkout predates the acceptance-drive scripts. The harness
scripts were read from the issue worktree while `P2777_REPO` pointed at the
clean exact-main checkout; all main server and daemon processes were spawned
from the main checkout.

### A8 — OpenCode at `5fe951f2f`

Run window: `2026-08-28 14:37:25–14:38:35 CEST`.

Session: `d8d5b89e-cd35-43bc-b303-9a13d92a9c9e`.

- The isolated named agent home initially contained the credential at
  `/home/mgw/.local/state/podium/p3038-redrive-c/agent-home/.local/share/opencode/auth.json`.
- Positive control with the credential present fired: the session bound
  `opencode-server`, family `server`, status `live`.
- The credential was moved to `.a8-parked` for the logged-out half and restored
  afterward. No operator credential was minted, rotated, or touched.
- With the credential absent, the requested driver was `opencode-server`,
  actual driver was `generic-pty`, family `terminal`, status `live`.
- `accounts.list` reported `loginRequired=true`.
- `interactions.list` offered no login interaction. The emitted condition was
  `(none)`/`undefined`, not a typed `logged-out` condition.
- The post-login OAuth half was not driven because it could mint or rotate a
  live credential.

Clause scoring:

| criterion clause | named plane | reading | score |
|---|---|---|---|
| positive control: authenticated spawn works | server-driver | credential-present session bound `opencode-server` | FIRED |
| gets a working login path | logged-out/session | demotion and `loginRequired=true` were observable, but no login interaction was offered | PARTIAL |
| after login, next session lands on server driver | post-login server | not driven; OAuth credential safety prevented login | NOT DRIVEN |

VERDICT — A8/opencode at `5fe951f2f`: **PARTIAL** — the positive control
fired; the logged-out demotion and login-required signal were observed, but
no working login affordance was exposed and the post-login server-binding half
was not driven.

### Current-tip discarded runs and interpretation

- A6b/OpenCode exact main was discarded as `REFUSED` because no session could
  be created and its positive control did not fire (`File name too long`).
- A3/Codex exact main was discarded as `REFUSED` for the same no-session,
  no-control reason.
- No current-tip run was discarded: all four current-tip positive controls fired
  before the scored criterion actions.

The current A6b/OpenCode CLI failure and A3/Codex transcript partial are real
current-tip readings, but neither is called a regression because the matching
exact-main arm was undriveable. Undriveable is a measurement gap, not a pass.
The coordinator should transcribe the explicit verdicts above into POD-1761;
this appendix remains evidence only, and `results.tsv` is untouched.
