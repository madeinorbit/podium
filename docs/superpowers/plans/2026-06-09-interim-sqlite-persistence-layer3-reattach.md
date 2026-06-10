# Interim SQLite Persistence — Layer 3 (boot reattach + input-fidelity dogfood) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After a backend restart, the daemon re-binds to the still-running tmux agents (Layer 2) so **clients see live terminals again automatically** — not stopped panels. Persisted live sessions reload as `reconnecting`; on daemon connect the daemon `has-session`-checks each and either re-binds (→ `live`) or reports it dead (→ `exited`).

**Architecture:** Three additive protocol messages — `reattach` (server→daemon, carries the tmux label + the metadata needed to re-emit `bind`), success reuses the existing `bind`, and `reattachFailed` (daemon→server). The server's `loadFromStore` stops collapsing survivors to `exited` and marks them `reconnecting`; `attachDaemon` fires a `reattach` per `reconnecting` session when the daemon link comes up. The daemon's new `reattach` handler attaches a node-pty to the existing tmux session via `attachTmuxAgent` (NOT a fresh spawn) and `bind`s, or `reattachFailed`s when the tmux session is gone.

**Tech stack:** TypeScript ESM (no semicolons, single quotes — Biome), zod (protocol), Vitest, real tmux. Server/daemon under Node via `tsx`.

**Scope:** Layer 3 (final) of `docs/superpowers/specs/2026-06-09-interim-sqlite-persistence-design.md`. Builds on Layers 1+2 (already on `main`). The end of this layer includes a **human-only manual Alt/Option dogfood** (spec §10.1 #3) — the automated work is Tasks 1-3; Task 4 is verification + the dogfood checklist for the user.

---

## Working directory & conventions
- Worktree `/home/user/src/other/podium/.claude/worktrees/persistence-l3-reattach` (off `main`, has Layers 1+2). Run commands from here; FULL worktree-prefixed absolute paths for Write/Edit. `bun install` once if needed.
- Style: no semicolons, single quotes, 2-space indent. `node_modules/.bin/biome check --write <files>` before each commit.
- Tests: `node_modules/.bin/vitest run <file>`. tmux integration tests `describe.skipIf(!isTmuxAvailable())`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure
| File | Change |
|------|--------|
| `packages/protocol/src/messages.ts` | `SessionStatus` += `reconnecting`,`hibernated`; new `ReattachMessage` (→ControlMessage union); new `ReattachFailedMessage` (→DaemonMessage union). |
| `packages/protocol/src/messages.test.ts` | Round-trip tests for the new messages + status values. |
| `apps/server/src/session.ts` | Widen `Session.status` + `SessionInit.status` to include `reconnecting`/`hibernated`; `markLive` promotes `reconnecting`→`live`. |
| `apps/server/src/relay.ts` | `loadFromStore`: survivors → `reconnecting` (not `exited`); `attachDaemon`: send `reattach` per reconnecting session; `onDaemonMessage`: add `reattachFailed` → exited. |
| `apps/server/src/relay.test.ts` | Update the boot-reconcile test (reconnecting, not exited); add reattach-success + reattach-failed tests. |
| `apps/daemon/src/daemon.ts` | Extract `wireBridge`; add `reattach` control handler (attach existing tmux or `reattachFailed`). |
| `apps/daemon/src/daemon.test.ts` | Integration (`skipIf`): reattach to a live tmux session re-binds; reattach to a missing one → `reattachFailed`. |

---

## Task 1: Protocol — reattach/reattachFailed + status values

**Files:** `packages/protocol/src/messages.ts`, `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Write failing round-trip tests**

Append to `packages/protocol/src/messages.test.ts` (match the file's existing test style — it round-trips via `encode`/`parse*`):
```ts
import {
  parseControlMessage,
  parseDaemonMessage,
  encode,
  SessionStatus,
} from './messages'

describe('Layer 3 reattach messages', () => {
  it('SessionStatus includes reconnecting + hibernated', () => {
    expect(SessionStatus.options).toContain('reconnecting')
    expect(SessionStatus.options).toContain('hibernated')
  })

  it('round-trips a reattach control message', () => {
    const msg = {
      type: 'reattach' as const,
      sessionId: 's1',
      tmuxLabel: 'podium-s1',
      agentKind: 'claude-code' as const,
      cwd: '/p',
      geometry: { cols: 80, rows: 24 },
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a reattachFailed daemon message', () => {
    const msg = { type: 'reattachFailed' as const, sessionId: 's1', reason: 'no tmux session' }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})
```
(If `messages.test.ts` doesn't exist or uses a different import style, adapt to the existing one — read it first.)

- [ ] **Step 2: Run → fail**

Run: `node_modules/.bin/vitest run packages/protocol`
Expected: FAIL (reattach not in the union; status missing values).

- [ ] **Step 3: Implement in `messages.ts`**

Change `SessionStatus`:
```ts
export const SessionStatus = z.enum(['starting', 'live', 'reconnecting', 'hibernated', 'exited'])
```

Add the control message (near `SpawnMessage`), then add it to the `ControlMessage` discriminated union:
```ts
export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  sessionId: z.string(),
  tmuxLabel: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  geometry: Geometry,
})
```
Add `ReattachMessage` to the `z.discriminatedUnion('type', [ ... ])` for `ControlMessage`.

Add the daemon message (near `SpawnErrorMessage`), then add it to the `DaemonMessage` union:
```ts
export const ReattachFailedMessage = z.object({
  type: z.literal('reattachFailed'),
  sessionId: z.string(),
  reason: z.string(),
})
```
Add `ReattachFailedMessage` to the `DaemonMessage` discriminated union.

- [ ] **Step 4: Format + run → pass**

Run: `node_modules/.bin/biome check --write packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts && node_modules/.bin/vitest run packages/protocol && bun run --filter @podium/protocol typecheck`
Expected: tests pass; typecheck exit 0.

- [ ] **Step 5: Commit**
```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): reattach/reattachFailed messages + reconnecting/hibernated status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Session status widening + markLive

**Files:** `apps/server/src/session.ts`, `apps/server/src/session.test.ts`

- [ ] **Step 1: Failing test**

Append to `apps/server/src/session.test.ts` inside `describe('Session', ...)`:
```ts
  it('markLive promotes a reconnecting session to live', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: geo,
      toDaemon: vi.fn(),
      status: 'reconnecting',
    })
    expect(s.toMeta().status).toBe('reconnecting')
    s.markLive('claude', geo)
    expect(s.toMeta().status).toBe('live')
  })
```
(`geo` + `vi` already exist in the file; if `vi` isn't imported, add it.)

- [ ] **Step 2: Run → fail**

Run: `node_modules/.bin/vitest run apps/server/src/session.test.ts`
Expected: FAIL — `SessionInit.status` doesn't accept `'reconnecting'` (type error) and/or `markLive` doesn't promote it.

- [ ] **Step 3: Implement in `session.ts`**

Widen the status type everywhere it's spelled `'starting' | 'live' | 'exited'`:
- The class field: `status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'`
- `SessionInit.status?:` the same union.

In `markLive(cmd, geometry)`, change the status promotion from:
```ts
    if (this.status === 'starting') this.status = 'live'
```
to:
```ts
    if (this.status === 'starting' || this.status === 'reconnecting') this.status = 'live'
```
(Leave the `lastActiveAt` stamp + geometry adoption as they are. `toMeta().status` returns the widened type, which now matches the protocol `SessionStatus`.)

- [ ] **Step 4: Format + run → pass**

Run: `node_modules/.bin/biome check --write apps/server/src/session.ts apps/server/src/session.test.ts && node_modules/.bin/vitest run apps/server/src/session.test.ts && bun run --filter @podium/server typecheck`
Expected: all Session tests pass; typecheck exit 0.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "feat(server): Session supports reconnecting/hibernated; markLive promotes reconnecting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Server reattach orchestration (relay.ts)

**Files:** `apps/server/src/relay.ts`, `apps/server/src/relay.test.ts`

- [ ] **Step 1: Update the existing boot-reconcile test + add new ones**

In `apps/server/src/relay.test.ts`:

(a) The existing test `boot reconcile: persisted sessions reload as exited (Layer 1, no survival)` now has Layer 3 semantics — survivors reload as `reconnecting`, not `exited`. Rename + rewrite its assertions:
```ts
  it('boot reconcile: persisted live sessions reload as reconnecting and trigger reattach', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()

    // Restart: fresh registry over the same db.
    const store2 = new SessionStore(file)
    const reg2 = new SessionRegistry(store2)
    expect(reg2.listSessions().find((m) => m.sessionId === sessionId)).toMatchObject({
      status: 'reconnecting',
      title: 'old',
      origin: { kind: 'resume', conversationId: 'c9' },
    })
    // Attaching the daemon fires a reattach for the reconnecting session.
    const control: import('@podium/protocol').ControlMessage[] = []
    reg2.attachDaemon((m) => control.push(m))
    expect(control).toContainEqual(
      expect.objectContaining({ type: 'reattach', sessionId, tmuxLabel: `podium-${sessionId}` }),
    )
    store2.close()
  })

  it('reattach success: bind on a reconnecting session makes it live', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.attachDaemon(() => {})
    expect(reg2.listSessions().at(0)?.status).toBe('reconnecting')
    reg2.onDaemonMessage(bind(sessionId))
    expect(reg2.listSessions().at(0)?.status).toBe('live')
  })

  it('reattachFailed marks the session exited', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.attachDaemon(() => {})
    reg2.onDaemonMessage({ type: 'reattachFailed', sessionId, reason: 'no tmux session' })
    expect(reg2.listSessions().at(0)?.status).toBe('exited')
  })
```

- [ ] **Step 2: Run → fail**

Run: `node_modules/.bin/vitest run apps/server/src/relay.test.ts`
Expected: FAIL — survivors currently reload as `exited`; `attachDaemon` doesn't send `reattach`; no `reattachFailed` handler.

- [ ] **Step 3: Implement in `relay.ts`**

(a) In `loadFromStore`, change the status decision. Replace the block that hard-codes `status: 'exited'` so survivors become `reconnecting`:
```ts
      // Layer 3: a previously live/starting session may still be running in its tmux
      // server. Reload it as 'reconnecting' so attachDaemon can re-bind it; exited stays
      // exited, hibernated stays hibernated.
      const reloadStatus =
        r.status === 'live' || r.status === 'starting' ? 'reconnecting' : r.status
      const exitCode = r.status === 'exited' ? r.exitCode : null
```
and in the `new Session({...})` call set `status: reloadStatus,` and `exitCode: exitCode ?? undefined,` (reconnecting sessions have no exit code). Keep the `if (r.status !== reloadStatus) this.persist(session)` correction (persist when we changed live/starting → reconnecting). NOTE: `Session`'s `exitCode` init is `number | undefined`; pass `undefined` for reconnecting.

(b) In `attachDaemon`, after `this.daemonSend = send`, request reattach for every reconnecting session:
```ts
  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
    for (const s of this.sessions.values()) {
      if (s.status === 'reconnecting') {
        this.toDaemon({
          type: 'reattach',
          sessionId: s.sessionId,
          tmuxLabel: s.tmuxLabel,
          agentKind: s.agentKind,
          cwd: s.cwd,
          geometry: s.geometry,
        })
      }
    }
  }
```

(c) In `onDaemonMessage`, add a `reattachFailed` case (after `spawnError`):
```ts
      case 'reattachFailed': {
        const s = this.sessions.get(msg.sessionId)
        if (s) {
          s.onExit(-1) // the surviving tmux session is gone; the agent died with the box
          this.persist(s)
        }
        this.broadcastSessions()
        break
      }
```

- [ ] **Step 4: Format + run → pass**

Run: `node_modules/.bin/biome check --write apps/server/src/relay.ts apps/server/src/relay.test.ts && node_modules/.bin/vitest run apps/server/src/relay.test.ts && bun run --filter @podium/server typecheck`
Expected: all relay tests pass (including the polish `agentKind` test, which still applies); typecheck exit 0.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): reload survivors as reconnecting; reattach on daemon connect; handle reattachFailed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Daemon reattach handler

**Files:** `apps/daemon/src/daemon.ts`, `apps/daemon/src/daemon.test.ts`

- [ ] **Step 1: Failing integration tests**

In `apps/daemon/src/daemon.test.ts`, add to the existing `describe.skipIf(!isTmuxAvailable())` survival suite (or a new one). Import `attachTmuxAgent`? No — drive through the daemon. The test: start a daemon (`tmux:true`) connected to a fake server; spawn a session so a real tmux server exists; capture its `sessionId`/label; then send a `reattach` control message for that label and assert the daemon replies `bind` (re-attached) and frames flow. Then send a `reattach` for a bogus label and assert the daemon replies `reattachFailed`.

Sketch (adapt to the existing fake-server harness in the file):
```ts
  it('reattach re-binds to a live tmux session, and reports failure for a missing one', async () => {
    // ... start daemon with tmux:true against the fake server; spawn 'sX' so podium-sX exists ...
    // success:
    server.send({ type: 'reattach', sessionId: 'sX', tmuxLabel: 'podium-sX', agentKind: 'claude-code', cwd: '/tmp', geometry: { cols: 80, rows: 24 } })
    // expect a 'bind' for 'sX' to arrive from the daemon
    // failure:
    server.send({ type: 'reattach', sessionId: 'gone', tmuxLabel: 'podium-gone-xyz', agentKind: 'claude-code', cwd: '/tmp', geometry: { cols: 80, rows: 24 } })
    // expect a 'reattachFailed' for 'gone'
  })
```
Use the existing harness's mechanism for "daemon → server message arrived" and "server → daemon send". Clean up all tmux servers (`killTmuxServer`) in a finally.

- [ ] **Step 2: Run → fail**

Run: `node_modules/.bin/vitest run apps/daemon`
Expected: FAIL — the daemon ignores unknown `reattach` control messages today.

- [ ] **Step 3: Implement in `daemon.ts`**

Import `attachTmuxAgent, tmuxHasSession` (add to the existing `@podium/agent-bridge` import).

Extract a `wireBridge` helper (DRY the spawn wiring). Where `spawn()` currently does `bridges.set(...)` + `session.onFrame(...)` + `session.onTitle(...)` + `session.onExit(...)`, replace that inline wiring with a call to:
```ts
  const wireBridge = (sessionId: string, session: AgentSession): void => {
    bridges.set(sessionId, session)
    session.onFrame((frame) =>
      send({ type: 'agentFrame', sessionId, seq: frame.seq, data: frame.data }),
    )
    session.onTitle((title) => send({ type: 'title', sessionId, title }))
    session.onExit((code) => {
      bridges.delete(sessionId)
      send({ type: 'agentExit', sessionId, code })
    })
  }
```
(`AgentSession` is exported from `@podium/agent-bridge` — add to the import.) Have `spawn()` call `wireBridge(msg.sessionId, session)` then send its `bind`.

Add a `reattach` case to the `ws.on('message')` switch:
```ts
      case 'reattach': {
        if (!tmuxMode || !tmuxHasSession(msg.tmuxLabel)) {
          send({
            type: 'reattachFailed',
            sessionId: msg.sessionId,
            reason: tmuxMode ? 'tmux session not found' : 'tmux unavailable',
          })
          break
        }
        const session = attachTmuxAgent({
          label: msg.tmuxLabel,
          cols: msg.geometry.cols,
          rows: msg.geometry.rows,
        })
        wireBridge(msg.sessionId, session)
        send({
          type: 'bind',
          sessionId: msg.sessionId,
          cmd: `tmux -L ${msg.tmuxLabel} attach`,
          cwd: msg.cwd,
          agentKind: msg.agentKind,
          geometry: msg.geometry,
        })
        break
      }
```

- [ ] **Step 4: Format + run → pass**

Run: `node_modules/.bin/biome check --write apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts && node_modules/.bin/vitest run apps/daemon && bun run --filter @podium/daemon typecheck`
Expected: all daemon tests pass (existing + reattach); typecheck exit 0.

- [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): handle reattach — re-bind to a live tmux session or report reattachFailed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Verification + manual input-fidelity dogfood

**Files:** none (verification + a human checklist)

- [ ] **Step 1: Repo-wide typecheck + lint + full suite**

Run:
```
bun run typecheck
node_modules/.bin/biome check packages apps   # note: a PRE-EXISTING noTemplateCurlyInString warning in session.test.ts:76 is unrelated
node_modules/.bin/vitest run --testTimeout=30000
```
Expected: typecheck all green; the only biome finding is the pre-existing warning; full suite green (the daemon git-scan test needs the 30s timeout in-sandbox).

- [ ] **Step 2: Programmatic end-to-end reattach (optional, strong)**

A relay+daemon integration test already proves each side. If a full cross-restart test is desired, it requires building dist (`bun run build`) to run the server under `tsx` (the `@podium/source` resolution caveat). The automated server-side + daemon-side tests are the primary proof; this step is optional.

- [ ] **Step 3: MANUAL dogfood (human-only — spec §10.1)** — hand this checklist to the user

This is the irreducible human step. On the dev host (`podium-host:55555`):
1. **Reattach:** start an agent panel, then restart the backend (`tsx watch`/systemd). Confirm the panel comes back **live** (not "exited"), shows the current screen, and you can keep typing — i.e. the daemon re-bound to the surviving tmux agent.
2. **Input fidelity (the load-bearing check):** in a live panel, exercise — especially on a non-US Mac keyboard — **Alt/Option-composed characters**, **Ctrl-combos** (Ctrl-C, Ctrl-R), **arrow keys**, and a **multi-line paste**. Confirm nothing is swallowed, doubled, or delayed vs. pre-tmux behavior. (The automated byte-parity gate already proved Ctrl-C/Alt/arrows/UTF-8 are byte-identical through tmux; this confirms the full browser→agent path.)
3. **Outside attach:** from a shell on the host, `tmux -L podium-<id> attach` and confirm you see/drive the same agent.

Report any discrepancy; per the spec, a real input-fidelity regression is the "reconsider tmux" trigger.

---

## Done criteria (Layer 3)
- `reattach`/`reattachFailed` + `reconnecting`/`hibernated` in the protocol (round-tripped).
- Survivors reload as `reconnecting`; `attachDaemon` fires `reattach`; `bind` → `live`, `reattachFailed` → `exited` (unit-tested).
- Daemon re-binds to a live tmux session via `attachTmuxAgent` or replies `reattachFailed` (integration-tested under tmux).
- Repo typecheck + full suite green.
- Manual dogfood handed to the user (the one human step).

## After Layer 3
The interim-persistence feature is complete: repos + panels survive a backend restart, live agents re-bind automatically, and input fidelity is preserved. Future (separate): the hibernation idle-policy (the substrate is ready), scrollback-history replay, and pushing `main`.
