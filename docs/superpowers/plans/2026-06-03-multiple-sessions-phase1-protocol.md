# Multiple Sessions — Phase 1: Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every hot-path wire message session-routed and add the attach / spawn / kill / scan verbs and registry/discovery payloads, so the rest of the multi-session work has a typed foundation.

**Architecture:** A single zod discriminated-union-on-`type` protocol carried as inspectable JSON, split into four unions (`ClientMessage`, `ServerMessage`, `DaemonMessage`, `ControlMessage`) plus shared schemas. This phase only touches `@podium/protocol`; consumers are updated in later phases.

**Tech Stack:** TypeScript (ESM, strict), `zod`, Vitest. Package: `packages/protocol`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §4.

---

## Sequencing note (read first)

This is a **foundational change on a shared package**. Updating these schemas will make
`@podium/server`, `@podium/daemon`, and `@podium/terminal-client` fail typecheck until their
phases (3–5) land. That is expected.

- All work happens on **one feature branch** (e.g. `feat/multiple-sessions`), branched from
  `main`. Phases are commit milestones on that branch; the branch is merged to `main` only when
  the **whole workspace** is green again (after phase 6).
- **This phase verifies against the protocol package only:**
  `bun run --filter @podium/protocol test` and `bun run --filter @podium/protocol typecheck`.
  Do **not** run workspace-wide `bun run typecheck` as a phase-1 gate — it will be red by design.

---

## File structure

- `packages/protocol/src/messages.ts` — all schemas + unions + codecs (rewrite/extend).
- `packages/protocol/src/messages.test.ts` — round-trip + rejection tests (rewrite to new shapes).
- `packages/protocol/src/index.ts` — re-export surface (verify it exposes the new symbols).

Existing `messages.test.ts` asserts the *old* single-session shapes (e.g. `welcome` with
`sessionId`, `input` without `sessionId`). It is rewritten here; that is intended.

---

### Task 1: Shared schemas (agent kind, resume ref, session meta, discovery wire)

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Write failing tests for the shared schemas**

Add to `messages.test.ts` (keep existing imports; add new ones as schemas are introduced):

```ts
import { describe, expect, it } from 'vitest'
import {
  AgentKind,
  ConversationSummaryWire,
  ResumeRef,
  SessionMeta,
} from './messages'

describe('shared schemas', () => {
  it('round-trips a SessionMeta (spawn origin)', () => {
    const meta = {
      sessionId: 's1',
      agentKind: 'claude-code' as const,
      title: 'fix the bug',
      cwd: '/home/u/proj',
      status: 'live' as const,
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('round-trips a SessionMeta (resume origin, exited)', () => {
    const meta = {
      sessionId: 's2',
      agentKind: 'codex' as const,
      title: 'old thread',
      cwd: '/w',
      status: 'exited' as const,
      exitCode: 0,
      controllerId: null,
      geometry: { cols: 100, rows: 30 },
      epoch: 2,
      clientCount: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'resume' as const, conversationId: 'conv-9' },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('parses AgentKind and ResumeRef', () => {
    expect(AgentKind.parse('codex')).toBe('codex')
    expect(ResumeRef.parse({ kind: 'claude-session', value: 'abc' })).toEqual({
      kind: 'claude-session',
      value: 'abc',
    })
  })

  it('round-trips a ConversationSummaryWire with optional fields omitted', () => {
    const min = { id: 'x', agentKind: 'claude-code' as const, providerId: 'claude-code-jsonl' }
    expect(ConversationSummaryWire.parse(min)).toEqual(min)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run --filter @podium/protocol test`
Expected: FAIL — `SessionMeta` / `AgentKind` / `ResumeRef` / `ConversationSummaryWire` are not exported.

- [ ] **Step 3: Implement the shared schemas**

In `messages.ts`, below the existing `Viewport` block, add:

```ts
export const AgentKind = z.enum(['claude-code', 'codex'])
export type AgentKind = z.infer<typeof AgentKind>

export const ResumeRef = z.object({ kind: z.string(), value: z.string() })
export type ResumeRef = z.infer<typeof ResumeRef>

export const SessionStatus = z.enum(['starting', 'live', 'exited'])
export type SessionStatus = z.infer<typeof SessionStatus>

export const SessionOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn') }),
  z.object({ kind: z.literal('resume'), conversationId: z.string() }),
])
export type SessionOrigin = z.infer<typeof SessionOrigin>

export const SessionMeta = z.object({
  sessionId: z.string(),
  agentKind: AgentKind,
  title: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().optional(),
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO 8601
  origin: SessionOrigin,
})
export type SessionMeta = z.infer<typeof SessionMeta>

// Discovery payloads on the wire — dates are ISO strings (Date is not JSON-safe).
export const ConversationGit = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  originUrl: z.string().optional(),
})
export const ConversationSummaryWire = z.object({
  id: z.string(),
  agentKind: AgentKind,
  title: z.string().optional(),
  projectPath: z.string().optional(),
  parentConversationId: z.string().optional(),
  statusHint: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  git: ConversationGit.optional(),
  resume: ResumeRef.optional(),
  providerId: z.string(),
})
export type ConversationSummaryWire = z.infer<typeof ConversationSummaryWire>

export const ConversationDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  providerId: z.string().optional(),
  root: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
})
export type ConversationDiagnosticWire = z.infer<typeof ConversationDiagnosticWire>
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run --filter @podium/protocol test`
Expected: PASS for the `shared schemas` describe block (pre-existing tests may still fail — they are rewritten in Tasks 2–4).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): shared session + discovery wire schemas"
```

---

### Task 2: Client → server messages (session-routed + attach/detach)

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Rewrite the client-message tests to the new shapes**

Replace any existing `ClientMessage` tests with:

```ts
import { type ClientMessage, parseClientMessage, encode } from './messages'

describe('ClientMessage', () => {
  const cases: ClientMessage[] = [
    { type: 'hello', clientId: 'c1', viewport: { cols: 80, rows: 24, dpr: 2 } },
    { type: 'attach', sessionId: 's1' },
    { type: 'detach', sessionId: 's1' },
    { type: 'input', sessionId: 's1', data: 'aGk=' },
    { type: 'resize', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'requestControl', sessionId: 's1' },
    { type: 'redrawRequest', sessionId: 's1' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })
  it('rejects input without sessionId', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'input', data: 'x' }))).toThrow()
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run --filter @podium/protocol test`
Expected: FAIL — `attach`/`detach` unknown; `input`/`resize`/etc. lack `sessionId`.

- [ ] **Step 3: Implement the client→server schemas**

Replace the existing client-message definitions + `ClientMessage` union with:

```ts
// ---- Browser client -> server ----
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
})
export const AttachMessage = z.object({ type: z.literal('attach'), sessionId: z.string() })
export const DetachMessage = z.object({ type: z.literal('detach'), sessionId: z.string() })
export const InputMessage = z.object({
  type: z.literal('input'),
  sessionId: z.string(),
  data: z.string(),
})
export const ResizeMessage = z.object({
  type: z.literal('resize'),
  sessionId: z.string(),
  ...Geometry.shape,
})
export const RequestControlMessage = z.object({
  type: z.literal('requestControl'),
  sessionId: z.string(),
})
export const RedrawRequestMessage = z.object({
  type: z.literal('redrawRequest'),
  sessionId: z.string(),
})

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run --filter @podium/protocol test`
Expected: PASS for `ClientMessage` + `shared schemas`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): session-routed client messages + attach/detach"
```

---

### Task 3: Server → client messages (welcome split, attached, session-routed frames, sessionsChanged)

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Rewrite the server-message tests**

```ts
import { type ServerMessage, parseServerMessage } from './messages'

describe('ServerMessage', () => {
  const geometry = { cols: 80, rows: 24 }
  const sessionMeta = {
    sessionId: 's1', agentKind: 'claude-code' as const, title: 't', cwd: '/w',
    status: 'live' as const, controllerId: 'c0', geometry, epoch: 0, clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z', origin: { kind: 'spawn' as const },
  }
  const cases: ServerMessage[] = [
    { type: 'welcome', clientId: 'c0' },
    { type: 'attached', sessionId: 's1', controllerId: 'c0', geometry, epoch: 0 },
    { type: 'outputFrame', sessionId: 's1', seq: 3, epoch: 1, data: 'eA==' },
    { type: 'controllerChanged', sessionId: 's1', controllerId: 'c1', geometry },
    { type: 'geometry', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'agentExit', sessionId: 's1', code: 0 },
    { type: 'sessionsChanged', sessions: [sessionMeta] },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run --filter @podium/protocol test`
Expected: FAIL — `attached`/`sessionsChanged` unknown; `welcome` still requires the old fields; frames lack `sessionId`.

- [ ] **Step 3: Implement the server→client schemas**

Replace the existing server-message definitions + `ServerMessage` union with:

```ts
// ---- Server -> browser client ----
export const WelcomeMessage = z.object({ type: z.literal('welcome'), clientId: z.string() })
export const AttachedMessage = z.object({
  type: z.literal('attached'),
  sessionId: z.string(),
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
})
export const OutputFrameMessage = z.object({
  type: z.literal('outputFrame'),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  data: z.string(),
})
export const ControllerChangedMessage = z.object({
  type: z.literal('controllerChanged'),
  sessionId: z.string(),
  controllerId: z.string().nullable(),
  geometry: Geometry,
})
export const GeometryMessage = z.object({
  type: z.literal('geometry'),
  sessionId: z.string(),
  ...Geometry.shape,
})
export const AgentExitMessage = z.object({
  type: z.literal('agentExit'),
  sessionId: z.string(),
  code: z.number().int(),
})
export const SessionsChangedMessage = z.object({
  type: z.literal('sessionsChanged'),
  sessions: z.array(SessionMeta),
})

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  AttachedMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
  SessionsChangedMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>
```

Note: `AgentExitMessage` is shared with the daemon→server union (Task 4) — define it once here.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run --filter @podium/protocol test`
Expected: PASS for `ServerMessage` (+ prior blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): session-routed server frames, attached, sessionsChanged"
```

---

### Task 4: Daemon ↔ server messages (spawn/kill/scan + session-routed control & frames)

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Rewrite the daemon/control tests**

```ts
import {
  type ControlMessage,
  type DaemonMessage,
  parseControlMessage,
  parseDaemonMessage,
} from './messages'

describe('ControlMessage (server -> daemon)', () => {
  const geometry = { cols: 80, rows: 24 }
  const cases: ControlMessage[] = [
    { type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/w', geometry },
    {
      type: 'spawn', sessionId: 's2', agentKind: 'codex', cwd: '/w',
      resume: { kind: 'codex-thread', value: 'id9' }, geometry,
    },
    { type: 'kill', sessionId: 's1' },
    { type: 'scanRequest', requestId: 'r1' },
    { type: 'input', sessionId: 's1', data: 'aGk=' },
    { type: 'resize', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'redraw', sessionId: 's1' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })
})

describe('DaemonMessage (daemon -> server)', () => {
  const geometry = { cols: 80, rows: 24 }
  const cases: DaemonMessage[] = [
    { type: 'bind', sessionId: 's1', cmd: 'claude', cwd: '/w', agentKind: 'claude-code', geometry },
    { type: 'agentFrame', sessionId: 's1', seq: 0, data: 'eA==' },
    { type: 'agentExit', sessionId: 's1', code: 0 },
    { type: 'spawnError', sessionId: 's1', message: 'enoent' },
    { type: 'scanResult', requestId: 'r1', conversations: [], diagnostics: [] },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run --filter @podium/protocol test`
Expected: FAIL — `spawn`/`kill`/`scanRequest`/`bind`(new shape)/`spawnError`/`scanResult` not defined; `redraw` lacks `sessionId`.

- [ ] **Step 3: Implement the daemon↔server schemas**

Replace the existing daemon/control definitions + both unions with:

```ts
// ---- Daemon <-> server ----
// server -> daemon
export const SpawnMessage = z.object({
  type: z.literal('spawn'),
  sessionId: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  geometry: Geometry,
})
export const KillMessage = z.object({ type: z.literal('kill'), sessionId: z.string() })
export const ScanRequestMessage = z.object({ type: z.literal('scanRequest'), requestId: z.string() })
export const RedrawMessage = z.object({ type: z.literal('redraw'), sessionId: z.string() })

export const ControlMessage = z.discriminatedUnion('type', [
  SpawnMessage,
  KillMessage,
  ScanRequestMessage,
  InputMessage,
  ResizeMessage,
  RedrawMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>

// daemon -> server
export const BindMessage = z.object({
  type: z.literal('bind'),
  sessionId: z.string(),
  cmd: z.string(),
  cwd: z.string(),
  agentKind: AgentKind,
  geometry: Geometry,
})
export const AgentFrameMessage = z.object({
  type: z.literal('agentFrame'),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string(),
})
export const SpawnErrorMessage = z.object({
  type: z.literal('spawnError'),
  sessionId: z.string(),
  message: z.string(),
})
export const ScanResultMessage = z.object({
  type: z.literal('scanResult'),
  requestId: z.string(),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
})

export const DaemonMessage = z.discriminatedUnion('type', [
  BindMessage,
  AgentFrameMessage,
  AgentExitMessage,
  SpawnErrorMessage,
  ScanResultMessage,
])
export type DaemonMessage = z.infer<typeof DaemonMessage>
```

`InputMessage`/`ResizeMessage` are reused from Task 2 (they now carry `sessionId`), so the
daemon receives the same session-routed input/resize the client sent.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run --filter @podium/protocol test`
Expected: PASS — all four unions.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): daemon spawn/kill/scan verbs + session-routed control/frames"
```

---

### Task 5: Codec + exports + package-green check

**Files:**
- Modify: `packages/protocol/src/messages.ts` (codec `AnyMessage` type)
- Verify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Confirm the codec union covers every message**

The codec section already declares
`type AnyMessage = ClientMessage | ServerMessage | DaemonMessage | ControlMessage`
and `encode`/`parse*` per union. No change needed if every new message is a member of one of
those unions (it is). Leave `encode` and the four `parse*` functions as-is.

- [ ] **Step 2: Add a malformed-input rejection test**

```ts
describe('codec', () => {
  it('throws on malformed JSON', () => {
    expect(() => parseClientMessage('{not json')).toThrow()
  })
  it('throws on unknown type', () => {
    expect(() => parseServerMessage(JSON.stringify({ type: 'nope' }))).toThrow()
  })
})
```

- [ ] **Step 3: Verify the export surface**

Read `packages/protocol/src/index.ts`. If it re-exports with `export * from './messages'`, the
new symbols are already exposed — no change. If it lists explicit re-exports, add the new ones:
`AgentKind`, `ResumeRef`, `SessionStatus`, `SessionOrigin`, `SessionMeta`, `ConversationGit`,
`ConversationSummaryWire`, `ConversationDiagnosticWire`, `AttachMessage`, `DetachMessage`,
`AttachedMessage`, `SessionsChangedMessage`, `SpawnMessage`, `KillMessage`, `ScanRequestMessage`,
`SpawnErrorMessage`, `ScanResultMessage` (and any types).

- [ ] **Step 4: Run the protocol package gates**

Run: `bun run --filter @podium/protocol test`
Expected: PASS (all blocks).

Run: `bun run --filter @podium/protocol typecheck`
Expected: exit 0.

Run: `bun run --filter @podium/protocol build`
Expected: exit 0 (tsup ESM + DTS succeed).

Run: `bun run lint`
Expected: clean for the protocol files (run `bun run format` if Biome reports formatting).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src
git commit -m "test(protocol): codec rejection cases + verify multi-session export surface"
```

---

## Self-review checklist (run after all tasks)

- **Spec coverage:** every message in spec §4 exists — client (hello/attach/detach/input/
  resize/requestControl/redrawRequest), server (welcome/attached/outputFrame/controllerChanged/
  geometry/agentExit/sessionsChanged), control (spawn/kill/scanRequest/input/resize/redraw),
  daemon (bind/agentFrame/agentExit/spawnError/scanResult); shared `SessionMeta`, `ResumeRef`,
  `ConversationSummaryWire`. ✔ check each off.
- **Type consistency:** `sessionId: string` everywhere it appears; `controllerId` is
  `string | null` in both `AttachedMessage` and `ControllerChangedMessage` and `SessionMeta`;
  `agentKind` uses the `AgentKind` enum everywhere; `geometry` uses `Geometry`.
- **No placeholders:** every step above contains the real schema code.
- **Phase gate is package-scoped** (`--filter @podium/protocol`), not workspace-wide — see the
  sequencing note.
