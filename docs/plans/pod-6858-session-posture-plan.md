# Session Posture Implementation Plan

Revision 2, 2026-11-12. Follows revision 3 of the spec. Task 8 (an engine-side
auto-approval) was removed; task numbers are otherwise unchanged.

> **For agentic workers:** this plan is filed as Podium tasks under one phase of
> POD-6858. Each task below is one task issue with its own worktree and agent.
> Your brief repeats the part you need. When a brief and the spec disagree, the
> spec wins; mail POD-6858 so the brief gets fixed. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Every harness process Podium starts runs on stated terms (trusted
folder, Podium CLI pre-approved, one mode in every view, quiet startup), and
product code states those terms in Podium's words only.

**Architecture:** Product code puts a harness-neutral `SessionPosture` on the
session spec. Each adapter gains one pure section, `posture(launch, request)`,
that adds to a launch for one of four launch modes. `harnessCommand`, the one
constructor of a launchable harness command, takes the terms as a required third
argument, so no harness process can be built without them.

**Tech Stack:** TypeScript, Bun, Vitest, zod (`@podium/protocol`),
`@podium/harness`, `apps/daemon`, `apps/server`.

**Spec:** `docs/design/harness-session-posture.md`, on the integration branch
beside this plan (`docs/plans/pod-6858-session-posture-plan.md`). It builds on
`docs/design/harness-access-contract.md`; read that first.

## Global Constraints

- Base and landing branch: `integrate/6858-harness-launch-configuration`, cut
  from `dev/mw`. Branch from it, land back onto it, never onto `dev/mw`.
- File paths and line numbers are from `dev/mw` at `760a7b1007`. Search by symbol.
- Default posture, exact: `{ mode: 'autonomous' }`.
- Requirement names, exact: `workspace-trust`, `podium-cli`, `autonomy`,
  `quiet-start`, `podium-material`.
- Launch modes, exact: `terminal`, `engine`, `turn`, `client`.
- Everything is decided before the process starts. Nothing in this work reads a
  terminal screen, waits for a harness to become ready, polls, or types a key.
- Everything that touches a harness runs in the daemon, on the harness's own
  machine. The server sends one value inside the frame that already starts the
  session or turn, and receives one report. No loop and no extra round trip.
- A harness has a minimum version only. Choose version-dependent spellings from
  `context.installation.version`. Do not add a verified-version gate.
- Adapters stay pure: no `process.env`, no `homedir()`, no file reads, no child
  processes in a posture section. The `harness-ambient-access` ratchet in
  `scripts/check-boundaries.ts` must not rise.
- No harness name, flag or folder literal outside `packages/harness/src/adapters/`
  and `packages/harness/src/driver/families/` (vendor-literal lint).
- Home edits: only a vendor-documented key or a file Podium names as its own.
  Never vendor-private state. Paths come from `context.roots` or `context.home`.
- `configure({ permissionMode })` and `toolPolicy: 'none'` are not changed.
- Managed installs are out of scope for this phase (spec section 9).
- Validation follows `AGENTS.md`: focused `bun run test:file -- <paths>` while
  working, one lean gate (`bun run test`) at the end. On a shared agent host,
  run tests, typecheck and builds on a separate test host, not locally.
- A regression test counts only if it fails on the base and passes after. Paste
  the base failure into the handoff.
- Commit trailer on every commit: `Podium-Issue: <your task ref>`.

## Review Focus

1. **A tool-less turn gains a tool flag.** A `toolPolicy: 'none'` turn must be
   built with `noAgentTerms`, never with an adapter's posture. Test in Task 2.
2. **A home edit loses a race.** Claude Code rewrites `~/.claude.json` while
   running, and two sessions can start together. The edit must leave every other
   key intact and must not replace a newer file with an older copy. Test in Task 3.
3. **A posture section deletes or reorders what the builder produced**, such as
   the `--` prompt boundary or a resume id. Test in Task 1.
4. **A folder path with a quote, a space or a non-ASCII character** breaks an
   inline config value (Codex TOML, OpenCode JSON). Tests in Tasks 5 and 6.
5. **An old daemon or an old server.** A frame without `posture`, and a frame
   whose `posture` the peer strips, must both start a session on today's
   behaviour. Test in Task 9.

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/messages/posture.ts` (new) | `SessionPostureSchema` and its type. Wire data only. |
| `packages/harness/src/posture-types.ts` (new) | `PodiumGrants`, `LaunchMode`, `PostureRequest`, `PostureLaunch`, `PostureResult`, `HomeEdit`, `LaunchTerms`, `AppliedTerms`, requirement names. Plain data. |
| `packages/harness/src/posture.ts` (new) | `applyTerms`, `launchTerms`, `noAgentTerms`, `optionArgs`, `unchangedPosture`. |
| `packages/harness/src/adapters/<harness>/posture.ts` (new, seven) | That harness's section. |
| `packages/harness/src/bound-command.ts` | `harnessCommand` takes the terms. |
| `apps/daemon/src/session-posture.ts` (new) | Builds `PodiumGrants` and the `PostureRequest` for a session; `prepareLaunch`. |
| `apps/daemon/src/harness-home-edits.ts` (new) | Applies `HomeEdit`s. |
| `apps/server/src/modules/sessions/session-posture.ts` (new) | The one place product code chooses a posture. |

---

### Task 0: Posture spike

Measurement only. No product code. Runs alongside Tasks 1 to 3.

**Files:**
- Create: `scripts/posture-probe.ts`
- Modify: `docs/design/harness-session-posture.md` (section 4.8 and section 2 only)

**Interfaces:**
- Produces: section 4.8 of the spec with no `?` cell. Tasks 4 to 7 read it; where
  it differs from this plan's values, the spec wins.
- Produces: `bun scripts/posture-probe.ts --harness <kind> --home <dir> --cwd <dir> [-- <extra args>]`
  printing one JSON line `{ "screenTail": string }`. It starts the harness in a
  PTY with a scrubbed environment (no `PODIUM_*`, no `CLAUDE_CODE_*`, no
  `CLAUDECODE`), captures what is drawn for a fixed time, and never sends a key.
  It is a measuring tool for this task and Task 12, not product code.

- [ ] **Step 1:** Write `scripts/posture-probe.ts` on the PTY layer in `packages/pty`.
- [ ] **Step 2:** For each installed harness, in a fresh home and a fresh
  `git init` folder, record what is on screen with no extra flags. Install Cursor
  (`cursor-agent`) for this. Sign in where a prompt hides behind sign-in.
- [ ] **Step 3:** Measure each open cell. The list:
  - Claude: does the `json-key` trust edit take effect in a fresh home; does a
    Claude session already running in another folder undo it when it next saves
    its config; does `--allowedTools` apply in an interactive session; the rule
    form that allows reading one absolute folder; under `--permission-mode auto`
    in a fresh home, does the auto-mode notice or `/auto-mode-setup` appear and
    which settings key stops it; what mode the session reports when auto mode is
    not available to it.
  - Codex: is `rules/podium.rules` loaded from the Codex home by the TUI and by
    the app-server, and with it in place does the automatic reviewer still flag
    `podium` commands; is there any way to load a rule for one session only;
    does `resume --remote` accept `-c projects={…}` and
    `-c check_for_update_on_startup=false`; do `--approve-for-me` and
    `approvals_reviewer` exist at the minimum version (0.147); does `git commit`
    succeed in a worktree under `workspace-write`.
  - OpenCode 1.18: the allow-rule syntax its inline config accepts; any update
    or first-run menu in a fresh home; what `--auto` changes against the default.
  - Grok: is there a folder prompt when signed in; the `--allow` rule grammar;
    whether `grok agent stdio` accepts `--allow`, and if not, whether its engine
    asks before running `podium`.
  - Pi: any first-run menu in a fresh home.
  - Cursor: the terminal trust prompt; `--trust`; whether an allow rule can be
    given for one launch; `--approve-mcps`; any first-run menu.
- [ ] **Step 4:** Write the results into the spec: section 4.8 with every cell
  filled as a mechanism or `unmet: <reason>`, and the evidence tags in section 2
  updated to **live** with the version measured.
- [ ] **Step 5:** Attach the raw probe output to the task
  (`podium issue artifact <task> --add`), commit, mail POD-6858 the list of cells
  that differ from the plan.

---

### Task 1: Posture contract

**Files:**
- Create: `packages/protocol/src/messages/posture.ts`, `packages/harness/src/posture-types.ts`,
  `packages/harness/src/posture.ts`, `packages/harness/src/posture.test.ts`,
  `packages/harness/src/posture.conformance.test.ts`,
  `packages/harness/src/adapters/{claude-code,codex,opencode,grok,pi,cursor,fixture}/posture.ts`
- Modify: `packages/harness/src/manifest.ts` (`AgentManifest`), each adapter's `index.ts`,
  `packages/harness/src/index.ts`, `packages/protocol/src/index.ts`

**Interfaces:**
- Produces, in `@podium/protocol`:

```ts
export const SessionPostureSchema = z.object({
  mode: z.union([z.enum(['supervised', 'autonomous']), z.object({ native: z.string().min(1) })]),
})
export type SessionPosture = z.infer<typeof SessionPostureSchema>
export const DEFAULT_SESSION_POSTURE: SessionPosture = { mode: 'autonomous' }
```

- Produces, in `@podium/harness` (`posture-types.ts`):

```ts
export interface PodiumGrants {
  readonly podiumCli: { name: string; path: string }
  readonly uploadsDir: string
  readonly mcpServers: readonly string[]
}
export type LaunchMode = 'terminal' | 'engine' | 'turn' | 'client'
export const POSTURE_REQUIREMENTS =
  ['workspace-trust', 'podium-cli', 'autonomy', 'quiet-start', 'podium-material'] as const
export type PostureRequirement = (typeof POSTURE_REQUIREMENTS)[number]
export interface PostureRequest {
  readonly mode: LaunchMode
  readonly posture: SessionPosture
  readonly grants: PodiumGrants
  readonly workdir: string
  readonly repoRoot?: string
  readonly runtimeDir: string
  readonly context: HarnessContext
}
export interface PostureLaunch {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly files: readonly LaunchFile[]
}
/** `serves`: the requirement that becomes unmet when the edit cannot be made. */
export type HomeEdit =
  | { kind: 'owned-file'; file: string; contents: string; serves: PostureRequirement }
  | { kind: 'json-key'; file: string; path: readonly string[]; value: JsonValue; serves: PostureRequirement }
export interface UnmetRequirement { requirement: PostureRequirement; reason: string }
export interface PostureResult {
  readonly launch: PostureLaunch
  readonly homeEdits: readonly HomeEdit[]
  readonly requestedMode: string | null
  readonly unmet: readonly UnmetRequirement[]
}
export type LaunchTerms =
  | { posture: (launch: PostureLaunch, request: PostureRequest) => PostureResult; request: PostureRequest }
  | { noAgent: string }
export interface AppliedTerms {
  readonly homeEdits: readonly HomeEdit[]
  readonly requestedMode: string | null
  readonly unmet: readonly UnmetRequirement[]
}
```

- Produces, on `AgentManifest`: `posture(launch: PostureLaunch, request: PostureRequest): PostureResult`
  (required, not `Declared`).
- Produces, in `posture.ts`:

```ts
export function launchTerms(manifest: Pick<AgentManifest, 'posture'>, request: PostureRequest): LaunchTerms
export function noAgentTerms(reason: string): LaunchTerms
export function applyTerms(launch: PostureLaunch, terms: LaunchTerms): { launch: PostureLaunch; applied: AppliedTerms }
/** Insert option tokens before a `--` boundary, or at the end when there is none. */
export function optionArgs(args: readonly string[], extra: readonly string[]): string[]
/** The identity section: launch unchanged, nothing unmet, no mode. */
export function unchangedPosture(launch: PostureLaunch): PostureResult
```

- [ ] **Step 1: Write the failing tests** in `posture.test.ts`:

```ts
const base: PostureLaunch = { args: ['--resume', 'id', '--', 'hello'], env: { A: '1' }, files: [] }
const terms = (posture) => ({ posture, request })

it('returns the launch with the section\'s additions', () => {
  const out = applyTerms(base, terms((l) => ({ ...unchangedPosture(l), launch: { ...l, args: optionArgs(l.args, ['--x']) } })))
  expect(out.launch.args).toEqual(['--resume', 'id', '--x', '--', 'hello'])
})
it('refuses a section that drops or reorders a builder argument', () => {
  expect(() => applyTerms(base, terms((l) => ({ ...unchangedPosture(l), launch: { ...l, args: ['--', 'hello'] } }))))
    .toThrow(/removed or reordered/)
  expect(() => applyTerms(base, terms((l) => ({ ...unchangedPosture(l), launch: { ...l, args: ['id', '--resume', '--', 'hello'] } }))))
    .toThrow(/removed or reordered/)
})
it('refuses a generated file outside the runtime folder', () => {
  expect(() => applyTerms(base, terms((l) => ({ ...unchangedPosture(l), launch: { ...l, files: [{ path: '/etc/x', contents: '' }] } }))))
    .toThrow(/outside the session runtime folder/)
})
it('refuses a home edit outside the context home and roots', () => {
  expect(() => applyTerms(base, terms((l) => ({ ...unchangedPosture(l), homeEdits: [{ kind: 'owned-file', file: '/etc/x', contents: '', serves: 'podium-cli' }] }))))
    .toThrow(/outside the harness home/)
})
it('refuses an unmet entry with a placeholder reason', () => {
  expect(() => applyTerms(base, terms((l) => ({ ...unchangedPosture(l), unmet: [{ requirement: 'autonomy', reason: 'n/a' }] }))))
    .toThrow(/reason/)
})
it('leaves a no-agent launch untouched', () => {
  const out = applyTerms(base, noAgentTerms('native login pane: runs no agent'))
  expect(out.launch).toEqual(base)
  expect(out.applied).toEqual({ homeEdits: [], requestedMode: null, unmet: [] })
})
it('refuses an empty no-agent reason', () => {
  expect(() => noAgentTerms('')).toThrow(/reason/)
})
it('inserts options before the prompt boundary', () => {
  expect(optionArgs(['--model', 'm', '--', '-p'], ['--x'])).toEqual(['--model', 'm', '--x', '--', '-p'])
  expect(optionArgs(['--model', 'm'], ['--x'])).toEqual(['--model', 'm', '--x'])
})
```

- [ ] **Step 2:** Run `bun run test:file -- packages/harness/src/posture.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement the types and `posture.ts`. "Survives in order" means
  the builder's args are a subsequence of the result's. Files the builder
  already had are exempt from the runtime-folder check. The reason check reuses
  `declinedReasonIsValid` from `manifest.ts`.
- [ ] **Step 4:** Give every adapter and the fixture a `posture.ts` exporting
  `<harness>Posture = unchangedPosture` behind the full signature, and wire it
  into `index.ts`. No behaviour changes in this task.
- [ ] **Step 5: Conformance test** in `posture.conformance.test.ts`: for every
  kind in `HARNESS_KINDS`, every `LaunchMode` and both mode levels,
  `applyTerms(launch, launchTerms(manifestFor(kind), request))` returns without
  throwing. Use `driver/testing/harness-context.ts` for the context.
- [ ] **Step 6:** Run both test files. Expected: PASS. Commit.

---

### Task 2: Launch terms required

After Tasks 1 and 3. Makes the terms mandatory. Still no behaviour change.

**Files:**
- Modify: `packages/harness/src/bound-command.ts` (`harnessCommand`, `BoundCommand`)
- Modify (the twelve `harnessCommand` call sites): `packages/harness/src/launch.ts:53`,
  `apps/daemon/src/control/session.ts:801`, `apps/daemon/src/buffered-harness.ts:187`,
  `apps/daemon/src/runtime/opencode-attach.ts:474`, `families/claude-sdk/exec.ts:84`,
  `families/claude-sdk/protocol.ts:150`, `families/codex/engine-host.ts:651`,
  `families/codex/exec-turn.ts:36`, `families/grok-acp/engine-host.ts:375`,
  `families/headless/invocation.ts:61,120`, `families/opencode/engine-host.ts:789`
- Modify: `packages/harness/src/driver/session-spec.ts`, `apps/daemon/src/runtime/handlers.ts:215-230`,
  `apps/daemon/src/host-runtime.ts` (beside each `harnessContextFor`),
  `apps/daemon/src/session/harness-spawn.ts`, the daemon's implementation of the
  engine owner's start (search `startEngine`), `apps/daemon/src/buffered-harness.ts`
- Create: `apps/daemon/src/session-posture.ts`, `apps/daemon/src/session-posture.test.ts`

**Interfaces:**
- Consumes: Task 1; `applyHomeEdits` from Task 3.
- Produces: `harnessCommand<I extends HarnessArgv>(context, invocation: I, terms: LaunchTerms): BoundCommand<I>`.
  It runs `applyTerms` over the invocation's args, env and files. `BoundCommand`
  gains `readonly terms: AppliedTerms` and always carries `env` and `files`.
  `withArgs`, `withTrailingArgs` and `throughLauncher` keep `terms`.
- Produces, on `SessionSpec`: `posture: SessionPosture` (required, stored with the
  spec; a stored spec without it reads as `DEFAULT_SESSION_POSTURE`) and
  `grants: PodiumGrants` (required; omitted from `EngineSessionSpec` exactly as
  `harnessContext` is).
- Produces, on each engine host's ports: `podiumGrantsFor(sessionId): Promise<PodiumGrants>`,
  beside `harnessContextFor`.
- Produces, in `apps/daemon/src/session-posture.ts`:

```ts
export function podiumGrantsFor(ctx: DaemonContext, sessionId: SessionId, spec: Pick<SessionSpec, 'mcpServers'>): PodiumGrants
export function postureRequestFor(input: {
  mode: LaunchMode; spec: Pick<SessionSpec, 'posture' | 'grants' | 'workdir'>
  context: HarnessContext; runtimeDir: string; repoRoot?: string
}): PostureRequest
/** The three generic steps before a harness process is created. */
export function prepareLaunch(command: BoundCommand, ports: PrepareLaunchPorts): Promise<AppliedTerms>
```

  `podiumCli` is `{ name: 'podium', path: <the CLI path harnessChildEnv puts on PATH> }`.
  `uploadsDir` is this session's own folder under the state root's `uploads`
  (`session-uploads.ts`). `mcpServers` is the server names in `spec.mcpServers`.
  `repoRoot` comes from `apps/daemon/src/worktree-resolve.ts` (the checkout that
  owns the common git dir); absent when the folder is not a worktree.
  `prepareLaunch` writes `command.files`, applies `command.terms.homeEdits`,
  turns each failed edit into an `unmet` entry, and returns the terms with those
  added. The session PTY spawn, the engine start and the buffered exec each call
  it once. Its result is logged in this task; Task 11 puts it on the wire.
- `agentLaunchCommand` (`launch.ts`) takes `posture: Omit<PostureRequest, 'mode' | 'context'>`
  in its options for every harness kind. `DaemonHarnessRuntime.launch` passes it through.
- Posture's env is wiring env. A site that hands env to `harnessChildEnv` or to
  the engine start merges `command.env` into the wiring layer it passes.
- Terms per call site:

| Site | Terms |
|---|---|
| `launch.ts:53` | `launchTerms(manifest, …)` with mode `terminal` |
| `control/session.ts:801` | `noAgentTerms('native login pane: runs no agent')` |
| `buffered-harness.ts:187`, `claude-sdk/exec.ts:84`, `codex/exec-turn.ts:36`, `headless/invocation.ts:61` | mode `turn` |
| `headless/invocation.ts:120` | `noAgentTerms('allocates a chat id: runs no agent')` |
| `claude-sdk/protocol.ts:150`, `codex/engine-host.ts:651`, `grok-acp/engine-host.ts:375`, `opencode/engine-host.ts:789` | mode `engine` |
| `runtime/opencode-attach.ts:474` | mode `client` |
| any site, when `toolPolicy === 'none'` | `noAgentTerms('tool-less turn: no tools to govern')` |

- Until Task 9 the daemon derives the posture from today's frame:
  `msg.permissionMode ? { mode: { native: msg.permissionMode } } : DEFAULT_SESSION_POSTURE`.

- [ ] **Step 1: Write the failing tests.**
  - `session-posture.test.ts`: `podiumGrantsFor` returns the CLI path and the
    session's own uploads folder, never another session's or the parent folder.
  - `bound-command` test: `// @ts-expect-error` on `harnessCommand(context, argv)`
    with two arguments; a command built with `noAgentTerms` has empty terms.
  - In the test that covers tool-less turns (search `toolPolicy: 'none'` in
    `families/claude-sdk/protocol.test.ts`): with a manifest whose posture adds
    `--marker`, the tool-less argv does not contain `--marker`.
  - `prepareLaunch`: a failed home edit yields one `unmet` entry with the edit's
    `serves` requirement, and the function still resolves.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Change `harnessCommand` and let the compiler list the sites.
  Fix each per the table.
- [ ] **Step 4:** Add `posture` and `grants` to `SessionSpec`, build them in
  `handlers.ts`, add `podiumGrantsFor` to the five engine host port objects in
  `host-runtime.ts`, call `prepareLaunch` in the three process-creating functions.
- [ ] **Step 5:** Run `bun run test:file` on the touched test files, then
  `bun run test:integration`. Expected: PASS with no snapshot change in any
  argv test, since every section is still the identity.
- [ ] **Step 6:** Commit.

---

### Task 3: Harness home edits

After Task 1.

**Files:**
- Create: `apps/daemon/src/harness-home-edits.ts`, `apps/daemon/src/harness-home-edits.test.ts`

**Interfaces:**
- Produces:

```ts
export type HomeEditOutcome =
  | { edit: HomeEdit; status: 'already' | 'applied' }
  | { edit: HomeEdit; status: 'failed'; reason: string }
export function applyHomeEdits(edits: readonly HomeEdit[], ports: HomeEditPorts): Promise<HomeEditOutcome[]>
export interface HomeEditPorts {
  readFile(path: string): Promise<string | undefined>
  writeFileAtomic(path: string, contents: string): Promise<void>   // write beside, rename over
  log(message: string, fields: Record<string, unknown>): void
}
```

  Edits to one file run one at a time across the whole daemon. There is no
  ledger and no undo.

- [ ] **Step 1: Write the failing tests:**

```ts
it('sets one key and leaves every other key and its order', async () => {
  fs.set(F, '{"a":1,"projects":{"/x":{"k":2}},"z":[3]}')
  const out = await applyHomeEdits([{ kind: 'json-key', file: F, path: ['projects', '/r', 'hasTrustDialogAccepted'], value: true, serves: 'workspace-trust' }], ports)
  expect(out[0].status).toBe('applied')
  expect(JSON.parse(fs.get(F))).toEqual({ a: 1, projects: { '/x': { k: 2 }, '/r': { hasTrustDialogAccepted: true } }, z: [3] })
  expect(Object.keys(JSON.parse(fs.get(F)))).toEqual(['a', 'projects', 'z'])
})
it('writes nothing when the value is already there', async () => { /* status 'already', zero writes, no log line */ })
it('runs two edits to one file one after the other, and both keys end up set', async () => { /* start both without awaiting the first */ })
it('retries once when the file changed between read and write, then fails', async () => {
  // readFile returns a different body on each call; expect status 'failed', a reason naming another writer, and no write of a stale body
})
it('fails on a JSON file that does not exist yet and creates nothing', async () => { /* reason: the harness has not created this file yet */ })
it('fails on a file that is not JSON and leaves it untouched', async () => {})
it('creates an owned file with its folder, and rewrites it only when its contents differ', async () => {})
it('logs one line per applied edit with the file and the key', async () => {})
```

- [ ] **Step 2:** Run. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. `json-key`: read, compare, set, write atomically,
  read again and compare; on mismatch retry the whole sequence once.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit.

---

### Tasks 4 to 7: one adapter each

After Tasks 0 and 2. They touch disjoint adapters and may run together.
Each one follows the same shape:

- [ ] **Step 1:** Write `adapters/<harness>/posture.test.ts`: one test per launch
  mode and mode level asserting the exact args, env, files, home edits,
  `requestedMode` and `unmet` in the tables below, plus the path test from Review
  Focus 4 where the harness has an inline config value.
- [ ] **Step 2:** Run it. Expected: FAIL against the identity section.
- [ ] **Step 3:** Implement the section. Remove the flags it now owns from the
  launch builders and the family (listed per task). Update those builders'
  existing argv tests: each changed expectation is listed in the commit message
  as "moved to posture".
- [ ] **Step 4:** Run the adapter's tests, its family's tests and
  `posture.conformance.test.ts`. Expected: PASS.
- [ ] **Step 5:** Drive it once on an isolated instance
  (`docs/agents/multi-instance.md`) in a never-seen git folder, terminal and
  chat view: no prompt before the first message can be sent, and
  `podium issue prime` runs unasked. Attach the evidence. Commit.

Values below are the plan's. Where the spike's section 4.8 differs, it wins. A
`{ native }` mode is passed through as that harness's own mode word when the
adapter's mode list has it, and is otherwise `unmet: autonomy`.

#### Task 4: Claude Code posture

**Files:** `adapters/claude-code/posture.ts`, `adapters/claude-code/instrumentation.ts`
(`claudeHookSettings`), `families/claude-sdk/protocol.ts:59-135`, `families/claude-sdk/exec.ts`

| Input | Output |
|---|---|
| any mode | home edit `json-key`, file = Claude's `.claude.json` by the adapter's existing rule, path `['projects', repoRoot ?? workdir, 'hasTrustDialogAccepted']`, value `true`, serves `workspace-trust` |
| any mode | `--allowedTools` followed by `Bash(<cli name> *)`, `PowerShell(<cli name> *)`, the read rule for `grants.uploadsDir` in the form the spike measured, and one `mcp__<server>` per MCP server |
| `supervised` / `autonomous` | `--permission-mode default` / `auto`; `requestedMode` the same word |
| mode `terminal` | env `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` |

`--allowedTools` takes every following token up to the next option, so emit
`--permission-mode` first and `--allowedTools` after it; `optionArgs` keeps both
ahead of the `--` prompt boundary. Do not use `--add-dir`: it grants editing.

`claudeHookSettings` gains `skipAutoPermissionPrompt: true` and
`skipDangerousModePermissionPrompt: true` beside the theme seed. The family keeps
`--permission-prompt-tool stdio` (`protocol.ts:133`): routing asks through the
protocol is what an engine is, not a product choice. It also keeps
`--allow-dangerously-skip-permissions` for a native `bypassPermissions` pick.
Remove the family's own `--permission-mode` default and `--allowedTools` handling.

#### Task 5: Codex posture

**Files:** `adapters/codex/posture.ts`, `adapters/codex/index.ts` (`launch`, the
network flag), `families/codex/engine-host.ts:155-198` (`codexAppServerConfigArgs`),
`adapters/codex/state.ts:32-40`

| Input | Output |
|---|---|
| `terminal`, `turn`, `engine` | `-c`, `projects={<toml string of repoRoot ?? workdir>={trust_level="trusted"}}` (inline table form; the dotted form does nothing) |
| `terminal`, `client` | `-c`, `check_for_update_on_startup=false` |
| `terminal`, `engine`, `turn` | `-c`, `sandbox_workspace_write.network_access=true` (now in every mode); `engine` also `-c`, `sandbox_mode="workspace-write"` (moved) |
| any mode | home edit `owned-file`, file `<roots.state>/rules/podium.rules`, serves `podium-cli`, contents: a comment line "Written by Podium. Lets agents run the Podium CLI without asking.", then `prefix_rule(pattern = ["<cli name>"], decision = "allow", justification = "Podium CLI: required for an agent to work inside Podium")` |
| `terminal`: `supervised` / `autonomous` | `-a on-request` / `--approve-for-me`; `requestedMode` `on-request` / `auto-review` |
| `engine`: `supervised` / `autonomous` | nothing (asks reach chat) / `-c approvals_reviewer="auto_review"` |
| `turn`: `supervised` / `autonomous` | `unmet: autonomy`, reason "a one-shot Codex run has nobody to ask" / `--approve-for-me` |
| any mode, below the version that has automatic review | `autonomous` gives the `supervised` output plus `unmet: autonomy` naming the version |
| `client` | no permission flags (Codex refuses them on `resume --remote`) |

The TOML string must escape `"` and `\`. Test with the folder
`/tmp/a "b"/c é` and a Windows-style `C:\Users\a b\repo`. Refresh the existing
trust detector in `state.ts` to match both the old copy and the 0.167 copy
("Trust this folder?", "1. Trust and continue"); add no new detector.

#### Task 6: OpenCode posture

**Files:** `adapters/opencode/posture.ts`, `adapters/opencode/index.ts:142` (`--auto`),
`families/opencode/engine-host.ts`

| Input | Output |
|---|---|
| any mode | `workspace-trust` met by default: nothing |
| any mode | one shell allow rule for the CLI merged into `OPENCODE_CONFIG_CONTENT` (read from `launch.env`, then `context.env`, then `{}`), in the syntax the spike measured for the installed major version |
| `terminal`: `supervised` / `autonomous` | shell and edit ask rules in the inline config / `--auto`; `requestedMode` `ask` / `auto` |
| `engine` | no flag; the server's asks go to chat as today |

Malformed existing config throws, as `launch` does today. Test the merge with an
existing `instructions` list and an existing `permission` block: both survive.

#### Task 7: Grok, Pi and Cursor posture

One commit per harness.

**Files:** `adapters/{grok,pi,cursor}/posture.ts`, `adapters/grok/index.ts:311-320`,
`adapters/pi/index.ts:62,283-285`, `adapters/cursor/index.ts:174`,
`families/grok-acp/session.ts` (initial mode)

| Harness | Input | Output |
|---|---|---|
| Grok | `terminal`, `turn`: mode | `--permission-mode default` / `auto`; `requestedMode` the same |
| Grok | `terminal`, `turn` | `--allow <rule>` for the CLI, grammar from the spike |
| Grok | `engine` | no flag; the family sets the initial mode from `requestedMode`. If the spike found that the engine asks before running `podium`: `unmet: podium-cli` with that fact as the reason |
| Pi | any mode | `--approve` |
| Pi | `supervised` | `unmet: autonomy`, reason "Pi has no approval gate: it never asks before it runs a tool" |
| Cursor | `turn` | `--trust` |
| Cursor | `terminal` | `unmet: workspace-trust`, reason "Cursor keeps interactive folder trust in private state that Podium does not write" |
| Cursor | `turn`: mode | nothing / `--auto-review` |
| Cursor | any mode | the per-launch allow rule the spike found, or `unmet: podium-cli`, reason "Cursor takes allow rules only from a settings file shared with every Cursor session, which Podium does not edit" |

Delete `AUTO_PERMISSION_MODES` in the Pi adapter and the `=== 'auto'` checks in
the Grok and Cursor headless builders.

---

### Task 9: Posture on the wire and in product code

After Tasks 4 to 7.

**Files:**
- Create: `apps/server/src/modules/sessions/session-posture.ts` and its test
- Modify: `packages/protocol/src/messages/runtime.ts:680-695`, `packages/protocol/src/messages/headless.ts:96-101`,
  `packages/protocol/src/messages/harness.ts:42`, the golden fixtures beside them,
  `apps/server/src/modules/sessions/runtime-gateway.ts`, `apps/server/src/modules/machines/rpc.ts`,
  `apps/server/src/modules/superagent/{headless,service,tools}.ts`, `apps/server/src/store/types.ts`,
  `apps/daemon/src/runtime/handlers.ts`, `packages/harness/src/driver/session-spec.ts`,
  `packages/harness/src/manifest.ts` (`HeadlessExecOptions.permissionMode`, `HarnessExecOptions.allowedTools`)

**Interfaces:**
- Produces: `posture: SessionPostureSchema.optional()` appended at the END of the
  session-establish frame, the headless turn frame and the buffered exec frame.
  The value rides frames that are sent anyway; this task adds no message.
- Produces: `export function sessionPostureFor(input: { nativeMode?: string }): SessionPosture`
  in the server: the person's picked native mode as `{ mode: { native } }`,
  otherwise `DEFAULT_SESSION_POSTURE`. Every server call site that today sets
  `permissionMode`, `allowedTools` or `structuredPermissions` calls it instead.
- Per turn: `TurnInput.permissionMode` and `TurnInput.allowedTools` become
  `TurnInput.posture`. A turn's posture wins over the session's, as those two do today.
- Mixed versions: the server keeps sending the old fields beside `posture`, each
  under `// LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them`.
  The daemon uses `posture` when present and the Task 2 derivation when absent.
- Removes: `permissionMode`, `allowedTools` and `structuredPermissions` from
  `SessionSpec`, `TurnInput`, `HeadlessExecOptions` and `HarnessExecOptions`;
  `harnessAllowedTools` and `HARNESS_BUILTIN_ALLOWED` from `superagent/tools.ts`.

- [ ] **Step 1: Write the failing tests.**
  - Protocol: a frame with `posture` round-trips; a frame without it parses; an
    unknown `mode` value is rejected.
  - Daemon `handlers` test: a frame with `posture: { mode: 'supervised' }` yields
    a spec with that posture; a frame with only `permissionMode: 'plan'` yields
    `{ mode: { native: 'plan' } }`; a frame with neither yields the default.
  - Server: the superagent turn sends `posture` equal to `DEFAULT_SESSION_POSTURE`
    and still sends `permissionMode: 'auto'` under the legacy line.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Regenerate the protocol golden fixtures with the
  repository's generator and format them.
- [ ] **Step 4:** Run the protocol tests, the daemon `handlers` tests,
  `bun run test:integration`. Expected: PASS. Commit.

---

### Task 10: Trust notice where a folder is added

Independent. Copy only.

**Files:** the add-repository dialog in `apps/web` (search the handler that calls
the add-project command), its mobile counterpart if one exists.

- [ ] **Step 1:** Add one line under the folder field, exact copy:
  "Agents can read, change and run files in this folder, and the folder's own
  agent settings and hooks apply. Podium tells each agent the folder is trusted,
  so none of them asks again."
- [ ] **Step 2:** Screenshot from the web layout harness (`apps/web/harness/`),
  light and dark. Attach both. Commit.

---

### Task 11: Posture reporting

After Tasks 4 to 7 and 9.

**Files:**
- Modify: `packages/protocol/src/messages/terminal.ts` (`DriverSelectedMessage`),
  the daemon code that sends it, the server module that turns it into session
  state, the client code that draws the mode chip,
  `scripts/harness-matrix.ts`, `docs/architecture/harness-support-matrix.md`

**Interfaces:**
- Produces: appended at the END of `DriverSelectedMessage`:
  `posture: z.object({ requestedMode: z.string().nullable(), unmet: z.array(z.object({ requirement: z.enum(POSTURE_REQUIREMENTS), reason: z.string() })) }).optional()`,
  filled from `prepareLaunch`'s result. It is data on a message the daemon
  already sends once per spawn.
- Produces: one session notice per `unmet` entry, text
  "`<harness label>` cannot `<requirement in words>` here: `<reason>`".
  Requirement in words: `workspace-trust` "skip its folder trust question",
  `podium-cli` "run the Podium CLI without asking", `autonomy` "run in the chosen
  mode", `quiet-start` "start without a menu", `podium-material` "open chat
  attachments without asking".
- The mode chip shows the mode the harness itself reports when it reports one
  (search how the chip gets Claude's mode from hook data today), and
  `posture.requestedMode` otherwise.
- `scripts/harness-matrix.ts` prints a posture table: for each harness and launch
  mode, the result of applying the default posture, as met / home edit / unmet.
- This task adds no screen detector, no timer and no readiness check.

- [ ] **Step 1: Write the failing tests:** the message round-trips with and
  without `posture`; a spawn with one `unmet` entry produces one notice with the
  exact text; a session whose harness reports mode `default` while
  `requestedMode` is `auto` shows `default`; `bun run docs:harness-matrix:check`
  fails before the matrix is regenerated.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `bun run docs:harness-matrix`. Expected: PASS. Commit.

---

### Task 12: Acceptance run

Last. No product code.

- [ ] **Step 1:** On an isolated instance at the integration branch tip, with a
  fresh agent home and a never-seen git repository, start each installed harness
  in terminal view and in chat view.
- [ ] **Step 2:** For each, record: no prompt appears before the first message;
  a first message sent from chat arrives; the agent runs `podium issue prime`
  with no ask; the mode chip matches the mode the harness is in; the daemon log
  lists exactly the home edits section 4.8 predicts.
- [ ] **Step 3:** Start a second session in a worktree of the same repository.
  Record that no new home edit is made.
- [ ] **Step 4:** Attach the evidence per harness and view. Mail POD-6858 a
  table of pass, fail and unmet.

## Dependency order

```
0 spike ──────────────────────────────┐
1 contract ─► 3 home edits ─► 2 terms ─┼─► 4 Claude ─┐
                                       ├─► 5 Codex  ─┼─► 9 wire ─► 11 reporting ─► 12 acceptance
                                       ├─► 6 OpenCode┤
                                       └─► 7 Grok/Pi/Cursor
10 trust notice (any time, before 12)
```
