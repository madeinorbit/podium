# PTY backend abstraction + behavioral derisking suite

**Date:** 2026-06-21
**Branch:** `worktree-feat+pty-backend-abstraction` (off `main` @ `8676d4a`)
**Status:** approved design

## Goal

Move Podium toward running on Bun with `bun build --compile` for releases. The hardest
`bun build --compile` blocker is the `node-pty` native addon. Bun 1.3.5+ ships a built-in
`Bun.Terminal` PTY API that removes the native addon entirely — but it is brand-new and
unproven, and Podium's whole value proposition is durable, correct terminals.

This work **derisks the swap** by:

1. Introducing **our own thin PTY abstraction** that both `node-pty` and `Bun.Terminal`
   implement, so the backend is swappable behind one interface.
2. Writing a **behavioral test suite that runs real processes under real PTYs** (keyecho
   and tiny fixtures, plus an opt-in real-`claude` smoke tier) and asserting the behaviors
   that actually matter to Podium — not mocked integration tests.
3. Running that **same suite against both backends**: `node-pty` under Node/vitest, and
   `Bun.Terminal` under `bun test` in isolation. Both must be green.

Because Bun 1.3.13 is already installed locally, the `Bun.Terminal` adapter can be proven
green **now, in isolation**, without first fixing the app-level Bun blockers — those only
block running the *whole app* on Bun, not unit-testing the PTY wrapper.

## Scope

**In scope (this task):**
- PTY abstraction interface + `node-pty` adapter + `Bun.Terminal` adapter.
- Refactor `wrapPty` / `spawnAgent` / `abduco.ts` spawn sites onto the abstraction.
- Backend-parameterized behavioral suite + fixtures + keyecho driver refactor.
- Green under **both** runners: vitest/Node (node-pty) and `bun test` (Bun.Terminal).
- Opt-in real-`claude` smoke tier, gated on the binary + auth being present.

**Out of scope (explicit follow-ups, NOT this task):**
- `node:sqlite` → `bun:sqlite` migration (app-level Bun blocker).
- Embedding/prebuilding `abduco` for `bun build --compile`.
- Flipping the **default** backend to `Bun.Terminal` app-wide (default stays `node-pty`
  until a stability soak; under `bun` it auto-selects, but the live app runs on Node today).

## Background: how Podium drives node-pty today

The entire PTY surface lives in two files:

- `packages/agent-bridge/src/session.ts` — `spawnAgent()` calls `node-pty`'s `spawn`,
  `wrapPty(proc: IPty)` adapts it to the `AgentSession` contract (frames, title, exit,
  write, resize, redraw, dispose).
- `packages/agent-bridge/src/abduco.ts` — `attachAbducoAgent()` `ptySpawn`s an
  `abduco -a` client in a PTY; `stripAttachChrome` filters the alt-screen chrome.

The subset of `node-pty` actually used: `spawn(file,args,{name,cols,rows,cwd,env})`,
`onData(str)`, `onExit({exitCode})`, `write(string|Buffer)`, `resize(cols,rows)`,
`kill(signal?)`, `pid`/`cols`/`rows`. Everything else clever in agent-bridge — abduco
durability, systemd `--scope` survival, the detach-key byte remap, alt-screen stripping —
is `node:child_process` / child-argv level and **does not touch the PTY library**.

### Behavioral differences that matter (node-pty vs Bun.Terminal)

| Aspect | node-pty | Bun.Terminal |
|---|---|---|
| `data` payload | decoded UTF-8 **string** (internal StringDecoder, cross-chunk safe) | raw **`Uint8Array`** bytes |
| `write` input | `string \| Buffer` | `string \| BufferSource` (byte-safe) |
| exit | `onExit({exitCode,signal})` event, multi-listener | `await proc.exited` + `proc.exitCode`/`signalCode` |
| `TERM` | `name` option writes it | no option — set via `env.TERM` |
| platform | Linux/macOS/Windows | POSIX only (Linux/macOS) — fine, Podium is Linux |

The string-vs-bytes split is the load-bearing difference. node-pty hands you whole strings
even when a multi-byte char/escape is split across two kernel reads; Bun hands you raw
bytes. Podium's OSC title scanner and base64 framing currently assume strings.

## Design

### 1. The abstraction: `PtyBackend` / `PtyProcess` (bytes-canonical)

New module `packages/agent-bridge/src/pty/`:

```ts
// types.ts
export interface PtySpawnOptions {
  file: string
  args: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

export interface PtyProcess {
  readonly pid: number
  /** Canonical data form is BYTES. */
  onData(cb: (bytes: Uint8Array) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtyBackend {
  readonly name: 'node-pty' | 'bun-terminal'
  spawn(opts: PtySpawnOptions): PtyProcess
}
```

**Why bytes are canonical.** Bun.Terminal natively emits bytes; node-pty can too via
`encoding: null` (Buffers). So both adapters emit bytes with no lossy round-trip. The
base64 framing becomes `base64(bytes)` — strictly more correct than today's
`Buffer.from(str,'utf8')`. The single consumer that needs a *string* — the OSC title
scanner — gets a **shared `StringDecoder`** (`node:string_decoder`, supported on Bun)
inside `wrapPty`, which correctly handles multi-byte chars split across reads. This fixes
a latent bug: today the scanner silently relies on node-pty's internal decoding; under
Bun's raw bytes it would corrupt multi-byte titles. Centralizing the decode makes the two
backends truly interchangeable.

### 2. Adapters

- `node-pty-backend.ts`: `pty.spawn(file,args,{name:'xterm-256color',cols,rows,cwd,env,encoding:null})`.
  Maps `onData(Buffer)`→bytes, `onExit({exitCode,signal})` passthrough, `write`→`Buffer.from(u8)`,
  `resize`/`kill`/`pid` passthrough.
- `bun-terminal-backend.ts`: `Bun.spawn([file,...args],{cwd,env:{...,TERM:'xterm-256color'},
  terminal:{cols,rows,data:(_t,bytes)=>cb(bytes)}})`. `onExit` via `proc.exited.then(()=>cb({
  exitCode: proc.exitCode ?? 0, signal: signalNumber(proc.signalCode)}))`, `write`→
  `proc.terminal.write(u8)`, `resize`→`proc.terminal.resize`, `kill`→`proc.kill(signal)`
  plus `proc.terminal.close()` on teardown, `pid`→`proc.pid`. All `Bun.*` references live
  **inside functions** so the module loads (but is never selected) under Node.

### 3. Backend selection

```ts
// index.ts
export function defaultPtyBackend(): PtyBackend {
  const forced = process.env.PODIUM_PTY_BACKEND // 'node-pty' | 'bun-terminal'
  if (forced === 'bun-terminal') return bunTerminalBackend()
  if (forced === 'node-pty') return nodePtyBackend()
  // auto: Bun.Terminal when running under Bun with the API present, else node-pty
  return hasBunTerminal() ? bunTerminalBackend() : nodePtyBackend()
}
```

`spawnAgent` / `spawnAbducoAgent` / `attachAbducoAgent` gain an optional trailing
`backend` parameter (defaults to `defaultPtyBackend()`) so tests inject a specific backend.
Forcing `bun-terminal` under Node throws a clear error.

### 4. Changes to existing code (small, contained)

- `session.ts`: `wrapPty(proc: PtyProcess, init: {cols; rows})` — same logic; data is
  bytes; `\x0c` becomes `Uint8Array([0x0c])`; a shared `StringDecoder` feeds the title
  scanner. Initial geometry comes from `init` (passed by the spawn site) rather than
  reading `proc.cols/rows`, keeping the interface minimal. `spawnAgent` calls
  `backend.spawn(...)`.
- `abduco.ts`: `ptySpawn` → `backend.spawn`; `createAltScreenStripper` / `stripAttachChrome`
  operate on **bytes** (the `\x1b[?1049h\x1b[H` prefix is pure ASCII). Public signatures
  unchanged apart from the optional `backend` arg — nothing else in the app moves.

The `AgentSession` contract (the public interface consumed by the daemon) is **unchanged**.

### 5. Behavioral suite — one spec, both runners, real PTYs

A single runner-neutral spec function receives its test primitives by injection and runs
against a supplied backend:

```ts
// test/pty-behavior/spec.ts
export function ptyBehaviorSpec(
  t: { describe; it; expect; },
  makeBackend: () => PtyBackend,
): void { /* all behaviors */ }
```

Executed twice:
- `pty-behavior.vitest.test.ts` → `node-pty` backend, run by vitest under Node.
- `pty-behavior.bun.test.ts` → `bun-terminal` backend, run by `bun test`.

Both import the spec; each supplies its own `{describe,it,expect}` (vitest vs `bun:test`)
and `waitFor`. Assertions stay in the common Jest-like subset (`toBe`, `toContain`,
`toEqual`, `toBeGreaterThan`). The bun test file imports **only** the narrow PTY modules
(not the agent-bridge index) so it never drags in `node:sqlite`.

#### Behavior matrix (every case a real process under a real PTY)

| # | Behavior | Mechanism |
|---|---|---|
| 1 | initial frame + geometry | fixture reports `cols×rows` |
| 2 | **input byte-fidelity** | keyecho echoes hex; byte-exact for `a`, Ctrl-C `0x03`, CR, arrows `\x1b[A`, bracketed paste, **`0xff`**, UTF-8 `é`/`🤖` |
| 3 | **output byte-exactness across chunking** | fixture emits a large known blob (all byte values); reassemble frames → byte-exact + length |
| 4 | **multi-byte title split across reads** | fixture emits an OSC title with emoji, bytes straddling chunk boundaries; assert `onTitle` exact |
| 5 | OSC title BEL + ST forms, repeat-dedup | fixture |
| 6 | resize → SIGWINCH → repaint at new geom | fixture |
| 7 | redraw soft (ack-restore) + hard (Ctrl-L) | fixture (real repaint) + keep fake-IPty unit tests for exact bytes |
| 8 | exit code (clean `0`) + SIGKILL mapping | fixture / kill |
| 9 | `TERM` + `COLORTERM` seen by child | `node -e` |
| 10 | frame seq monotonic | fixture |
| 11 | dispose cleanliness (no frames after, pid gone) | fixture |

Plus the **opt-in real-`claude` smoke tier** (`claude-smoke.test.ts`), skipped unless the
`claude` binary + auth are present: spawn real `claude`, wait for its initial render, send a
keystroke, observe echo/title. Tolerant (smoke, not byte-exact).

### 6. keyecho extension

`tests/keyecho/test/driver.ts` (`bootKeyecho`) is refactored to boot through a supplied
`PtyBackend` (default node-pty) so one driver drives keyecho under either backend. keyecho
already echoes input as hex (ideal for #2). New small fixtures `fixture-blob.mjs` and
`fixture-title.mjs` cover #3/#4 (cleaner than overloading keyecho); `fixture-tui.mjs` is
reused for the rest.

## Error handling

- Forced-but-unavailable backend (`PODIUM_PTY_BACKEND=bun-terminal` under Node) → throws a
  clear, actionable error rather than failing deep inside `spawn`.
- `bun-terminal-backend` keeps all `Bun.*` access inside functions, so importing the module
  under Node is safe; only *calling* `spawn` under Node would error (never reached via auto
  selection).
- `dispose()` / `kill()` swallow "already exited" races exactly as today.

## Testing & verification (definition of done)

- `bun run --filter @podium/agent-bridge test` (vitest/Node) green — node-pty behavioral
  tier + **all existing tests**, no regressions. (Pre-existing unrelated failure:
  `src/discovery/providers/opencode.test.ts`, an opencode-discovery sqlite test failing on
  `main` independent of this work — tracked separately, not a regression.)
- `bun test packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts` green —
  Bun.Terminal behavioral tier, identical behaviors.
- workspace `typecheck` green.
- existing `session.test.ts` / `abduco.test.ts` / `osc-title.test.ts` / keyecho tests still
  green.

## File plan

**New:**
- `packages/agent-bridge/src/pty/types.ts`
- `packages/agent-bridge/src/pty/node-pty-backend.ts`
- `packages/agent-bridge/src/pty/bun-terminal-backend.ts`
- `packages/agent-bridge/src/pty/index.ts`
- `packages/agent-bridge/test/pty-behavior/spec.ts`
- `packages/agent-bridge/test/pty-behavior/pty-behavior.vitest.test.ts`
- `packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts`
- `packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts`
- `packages/agent-bridge/test/fixtures/fixture-blob.mjs`
- `packages/agent-bridge/test/fixtures/fixture-title.mjs`

**Modified:**
- `packages/agent-bridge/src/session.ts`
- `packages/agent-bridge/src/abduco.ts`
- `packages/agent-bridge/src/index.ts` (export the pty module)
- `tests/keyecho/test/driver.ts`

## Risks & mitigations

- **Bun.Terminal immaturity** — the dominant risk, addressed by *exactly this work*: the
  behavioral suite is the soak harness. Default stays node-pty until it passes consistently.
- **Runner assertion drift** (vitest vs `bun:test`) — mitigated by injecting primitives and
  staying in the common matcher subset.
- **bun test importing `node:sqlite`** — mitigated by narrow imports in the bun test file.
- **Cross-chunk UTF-8** — the headline correctness risk, made an explicit test (#4) and
  fixed structurally by the shared StringDecoder.
