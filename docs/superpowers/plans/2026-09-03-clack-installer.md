# Bootstrap-and-Handoff Linux Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `install.sh` to a bootstrap that ends by `exec`ing the signature-verified binary, and draw every post-extraction step — plus the whole `podium setup` flow — with `@clack/prompts`, with copy-paste commands in their own box.

**Architecture:** The signature-verified binary is both the trust boundary and the UI boundary. `install.sh` keeps args, platform detection, bootstrap-tool provisioning, download, Ed25519 verification and extraction, then `exec "$BIN/$COMMAND" install-finish … < /dev/tty`. A new `install-finish` subcommand sequences PATH persistence, supervision, agent installs, configuration and the closing report through one clack-backed `SetupIO` that `podium setup` and `podium setup --vps` also use.

**Tech Stack:** TypeScript on Bun, vitest, `@clack/prompts` ^1.7.0, POSIX sh.

**Spec:** `docs/superpowers/specs/2026-09-03-clack-installer-design.md`

## Global Constraints

- `@clack/prompts` version `^1.7.0`; it is a dependency of `apps/cli` only.
- Biome formatting: 2-space indent, single quotes, semicolons as-needed, line width 100. Never run `bunx biome` or `bun run format` across the repo.
- Behavioural requirements R1-R10 come from the spec; tests cite them by number.
- `--managed` / `--shared` stay accepted and inert (POD-3309). Do not wire them up.
- SP-7f2c: every setup surface must make the no-password option an explicit opt-in behind a confirmed warning.
- `install.sh` must keep working on a bare distro image with neither curl nor wget.
- The end-of-task gate is `bun run test` (the lean gate). Focused lane for this work: `bun run test:related -- apps/cli/src/<file>.test.ts`, plus `sh scripts/install-sh.test.sh` for shell changes.
- Commit after every task. Add the trailer `Podium-Issue: POD-3274` only when committing to a shared branch; this work is on `issue-3274-clack-installer`, so no trailer is needed.

---

## Stage 1 — clack in `podium setup`

Ships alone: it redesigns the interactive flow without touching `install.sh`.

### Task 1: The `SetupIO` module

**Files:**
- Create: `apps/cli/src/setup-ui.ts`
- Create: `apps/cli/src/setup-ui.test.ts`
- Modify: `apps/cli/package.json` (add `@clack/prompts`)

**Interfaces:**
- Consumes: nothing.
- Produces: `SetupIO`, `CANCEL`, `isCancel`, `clackIO()`, `scriptedIO(answers: unknown[])` — full signatures in the spec's Contracts section.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/cli && bun add @clack/prompts@^1.7.0 && cd ../..
```

- [ ] **Step 2: Write the failing test**

`apps/cli/src/setup-ui.test.ts` — the behaviour that matters is the scripted double (the real
one draws to a terminal and is covered by the flows that use it):

```ts
import { describe, expect, it } from 'vitest'
import { CANCEL, isCancel, scriptedIO } from './setup-ui'

describe('scriptedIO', () => {
  it('serves one ordered queue across mixed widget kinds', async () => {
    const { io } = scriptedIO(['all-in-one', 'https://a.test', true])
    expect(await io.select({ message: 'mode', options: [] })).toBe('all-in-one')
    expect(await io.text({ message: 'url' })).toBe('https://a.test')
    expect(await io.confirm({ message: 'systemd?' })).toBe(true)
  })

  it('returns CANCEL when the queue is exhausted, so a flow cannot spin on EOF', async () => {
    const { io } = scriptedIO([])
    expect(isCancel(await io.text({ message: 'url' }))).toBe(true)
  })

  it('applies validate before accepting a scripted answer', async () => {
    const { io } = scriptedIO(['nope', 'https://a.test'])
    const v = (s: string) => (s.startsWith('https://') ? undefined : 'must be https')
    expect(await io.text({ message: 'url', validate: v })).toBe('https://a.test')
  })

  it('records printed output, and command() renders the command alone on its line', () => {
    const { io, output } = scriptedIO([])
    io.command('tailscale funnel 18787', 'Run this, then come back:')
    expect(output.join('\n')).toContain('tailscale funnel 18787')
    expect(output.some((l) => l.trim() === 'tailscale funnel 18787')).toBe(true)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun run test:related -- apps/cli/src/setup-ui.test.ts`
Expected: FAIL — cannot resolve `./setup-ui`.

- [ ] **Step 4: Implement `setup-ui.ts`**

`clackIO()` maps each method onto `@clack/prompts` (`select`, `text`, `password`, `confirm`,
`note`, `log.*`, `spinner`, `intro`, `outro`), translating clack's cancel symbol to `CANCEL`.
`command(cmd, caption)` calls `note(cmd, caption)` so the box holds the command and nothing
else. `scriptedIO(answers)` shifts one answer per prompt, runs `validate` and re-shifts on
rejection, and returns `CANCEL` when the queue is empty.

- [ ] **Step 5: Run the tests**

Run: `bun run test:related -- apps/cli/src/setup-ui.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/package.json apps/cli/src/setup-ui.ts apps/cli/src/setup-ui.test.ts bun.lock
git commit -m "feat(cli): a clack-backed SetupIO with a boxed command primitive"
```

### Task 2: Move `cli-setup.ts` onto `SetupIO`

**Files:**
- Modify: `apps/cli/src/cli-setup.ts` (the `SetupIO` interface at :23-26 and every `io.` call)
- Modify: `apps/cli/src/cli-setup.test.ts` (682 lines — port to the scripted double)
- Modify: `apps/cli/src/cli.ts:1799-1826` (both `createInterface` call sites → `clackIO()`)

**Interfaces:**
- Consumes: `SetupIO`, `clackIO`, `scriptedIO`, `CANCEL`, `isCancel` from Task 1.
- Produces: unchanged exports — `runCliSetup`, `runVpsSetup`, `runJoinSetup`, `telemetryStep`, `repairConfig`, `shouldRunCliSetup`, `startBackendEngine`, `waitForDaemonEnrollment` — with `SetupIO` re-exported from `setup-ui.ts` rather than declared locally.

- [ ] **Step 1: Port the tests first**

Each existing `run([...answers])` helper becomes `scriptedIO([...])`. String answers for `text`
and `password` stay strings; `'1'`/`'2'`/`'3'` menu answers become the option values
(`'all-in-one'`, `'server'`, `'daemon'`, `'url'`, `'password'`, `'telemetry'`); `[Y/n]` and
`[y/N]` answers become booleans; `'CHANGE'` and `'open'` keep their current shape (`CHANGE`
stays a typed word, `open` becomes a boolean).

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run test:related -- apps/cli/src/cli-setup.test.ts`
Expected: FAIL — `scriptedIO` answers not consumed; flow still calls `io.prompt`.

- [ ] **Step 3: Rewrite the flow's I/O**

Per the spec's mapping table. Every prompt result is checked with `isCancel` and cancels through
one path that prints "Nothing saved" and returns. Delete the `MAX_ATTEMPTS` loops in
`reachabilityStep` (:243), `passwordStep` (:279) and `joinStep` (:514) — they exist only because
readline resolves `''` forever on EOF, which `CANCEL` now handles. Keep every explanatory
comment; they document decisions, not mechanics.

The copy-paste moments become `io.command(...)`: the tunnel command at :239, and the reachable
URL in the closing messages.

- [ ] **Step 4: Rewire the two call sites**

`apps/cli/src/cli.ts:1799` and `:1816` drop `node:readline/promises` and pass `clackIO()`.

- [ ] **Step 5: Run the tests**

Run: `bun run test:related -- apps/cli/src/cli-setup.test.ts apps/cli/src/setup-ui.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck --filter @podium/cli --concurrency=1
git add apps/cli/src/cli-setup.ts apps/cli/src/cli-setup.test.ts apps/cli/src/cli.ts
git commit -m "feat(cli): draw podium setup with clack prompts"
```

---

## Stage 2 — the handoff

### Task 3: `install-path.ts`

**Files:**
- Create: `apps/cli/src/install-path.ts`
- Create: `apps/cli/src/install-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface PathPersistResult {
  /** Startup files this run appended the snippet to. */
  written: string[]
  /** True when the snippet is present, whether this run wrote it or a previous one did. */
  persisted: boolean
}
export function persistPath(binDir: string, home?: string): PathPersistResult
export function pathHint(binDir: string, persisted: boolean, command: string): string | undefined
export const PATH_MARKER = '# >>> podium installer (PATH) >>>'
```

- [ ] **Step 1: Write the failing tests**

Port install.sh:300-367 verbatim in behaviour. Tests run against a temp `$HOME`:

```ts
it('writes ~/.profile always [R5]', ...)
it('writes a present ~/.bash_profile because it shadows ~/.profile [R5]', ...)
it('does not create ~/.bash_profile when absent [R5]', ...)
it('is idempotent — a second run appends nothing [R5]', ...)
it('writes the snippet unexpanded so it re-resolves $HOME on every source [R5]', ...)
it('writes fish to conf.d as its own file [R5]', ...)
it('returns persisted:true when a previous install already wrote the marker [R5]', ...)
```

- [ ] **Step 2: Run and watch them fail.** `bun run test:related -- apps/cli/src/install-path.test.ts`

- [ ] **Step 3: Implement**, porting the shell logic including the unexpanded `case ":${PATH-}:"` snippet and the fish `conf.d/podium-path.fish` variant.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/install-path.ts apps/cli/src/install-path.test.ts
git commit -m "feat(cli): PATH persistence in TypeScript, with real tests"
```

### Task 4: `install-supervision.ts`

**Files:**
- Create: `apps/cli/src/install-supervision.ts`
- Create: `apps/cli/src/install-supervision.test.ts`

**Interfaces:**
- Consumes: `hasSystemctl`, `hasUserSystemd` from `apps/cli/src/cli-systemd.ts`.
- Produces:

```ts
export interface SupervisionProbe {
  /** Can we install a user systemd service here? */
  systemd: boolean
  /** Why not, when systemd is false — one sentence, already operator-readable. */
  why?: string
  /** One actionable sentence, when there is one. */
  fix?: string
}
export function probeSupervision(deps?: {
  hasSystemctl?: () => boolean
  hasUserSystemd?: () => boolean
  env?: NodeJS.ProcessEnv
  uid?: () => number
  socketExists?: (p: string) => boolean
}): SupervisionProbe
```

Only the `XDG_RUNTIME_DIR` recovery is new logic — install.sh:404-406. `installSystemd`
(cli-systemd.ts:474) already enables linger and already returns a `remedy`, so the probe does not
duplicate either.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports systemd when the user bus answers', ...)
it('recovers XDG_RUNTIME_DIR from /run/user/<uid>/bus under sudo -i', ...)
it('explains a missing systemctl and offers the @reboot crontab fix', ...)
it('explains a missing user bus without claiming systemd is absent', ...)
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/install-supervision.ts apps/cli/src/install-supervision.test.ts
git commit -m "feat(cli): supervision probe with XDG_RUNTIME_DIR recovery"
```

### Task 5: `install-finish.ts` and the subcommand

**Files:**
- Create: `apps/cli/src/install-finish.ts`
- Create: `apps/cli/src/install-finish.test.ts`
- Modify: `apps/cli/src/cli.ts` (add `{ kind: 'install-finish'; opts: InstallFinishOptions }` to `LaunchPlan`, parse it in `resolvePlan`, dispatch it in `main`)

**Interfaces:**
- Consumes: `SetupIO`/`clackIO` (Task 1), `persistPath`/`pathHint` (Task 3), `probeSupervision` (Task 4), `applyChannel` (cli-channel.ts), `runJoinSetup`/`runCliSetup`/`runVpsSetup` (cli-setup.ts).
- Produces:

```ts
export interface InstallFinishOptions {
  channel: 'stable' | 'edge'
  instance: string
  dest: string
  bin: string
  command: string
  agents: string[]
  vps: boolean
  modifyPath: boolean
  interactive: boolean
  joinToken?: string
}
export function parseInstallFinishArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): InstallFinishOptions | { error: string }
export async function runInstallFinish(
  io: SetupIO,
  opts: InstallFinishOptions,
  deps?: InstallFinishDeps,
): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

```ts
it('persists the channel before any other step [R4]', ...)
it('pairs without prompting when PODIUM_JOIN_TOKEN is set [R6]', ...)
it('runs the interactive setup on a TTY with no join token [R7]', ...)
it('prints the report and never prompts without a TTY [R8]', ...)
it('honours --no-interactive on a TTY [R8]', ...)
it('renders every copy-paste command through command() [R9]', ...)
it('accepts --managed and --shared and changes nothing [R10]', ...)
it('skips PATH persistence under --no-modify-path', ...)
it('selects runVpsSetup under --vps', ...)
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** the parser and the flow: channel → PATH → supervision probe → agents → configure (join / interactive / neither) → report. Every step idempotent.
- [ ] **Step 4: Wire `cli.ts`.** Parse before the `setup` branches; keep it out of the help text.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/install-finish.ts apps/cli/src/install-finish.test.ts apps/cli/src/cli.ts
git commit -m "feat(cli): podium install-finish, the post-handoff installer flow"
```

### Task 6: `install.sh` becomes a bootstrap

**Files:**
- Modify: `install.sh` (delete :294-511 — PATH, systemd, join, agents, report; narrow :139-157 to the bootstrap tool set; add the probe and `exec`)
- Modify: `scripts/install-sh.test.sh`
- Modify: `packages/runtime/src/vps-bootstrap.ts` (drop the trailing `&& … setup --vps` chain, pass `--vps` to the installer instead)

**Interfaces:**
- Consumes: `podium install-finish` (Task 5).
- Produces: an `install.sh` whose only post-extraction act is the handoff.

- [ ] **Step 1: Update the shell test first**

Keep: arch selection, prerequisite refusal, signature fail-closed (R1), atomic install, and the
real-shell `env -i` PATH probe — that probe now exercises the TypeScript snippet through the
installed binary, which is what it always really tested. Add: the handoff is invoked with the
right flags (R2), and a binary that fails `--version` produces a plain-text report and a
non-zero exit (R3).

- [ ] **Step 2: Run and watch the new assertions fail.** `sh scripts/install-sh.test.sh`

- [ ] **Step 3: Rewrite `install.sh`.** Narrow the prerequisite set to a downloader, `base64`, `openssl`, `tar`, `gzip` and CA certificates — `git` and `bash` move behind the handoff. End with:

```sh
if ! "$BIN/$COMMAND" --version >/dev/null 2>&1; then
  fallback_report; exit 1
fi
# NOT "$@": install.sh's own flags are not install-finish's. Build the list, and pass the
# join token through the environment so a live pairing code stays out of /proc/*/cmdline.
set -- install-finish --channel "$CHANNEL" --instance "$INSTANCE" \
  --dest "$DEST" --bin "$BIN" --command "$COMMAND"
[ -z "$INSTALL_AGENTS" ] || set -- "$@" --agents "$INSTALL_AGENTS"
[ -z "$VPS" ] || set -- "$@" --vps
[ -z "${PODIUM_NO_MODIFY_PATH:-}" ] || set -- "$@" --no-modify-path
[ -n "$JOIN" ] && PODIUM_JOIN_TOKEN="$JOIN" && export PODIUM_JOIN_TOKEN
if [ -r /dev/tty ]; then
  exec "$BIN/$COMMAND" "$@" < /dev/tty
else
  exec "$BIN/$COMMAND" "$@" --no-interactive
fi
```

`--vps` is a new `install.sh` flag in this task, replacing the chained second command that
`buildVpsBootstrapCommand` appends today.

- [ ] **Step 4: Run the shell test.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add install.sh scripts/install-sh.test.sh packages/runtime/src/vps-bootstrap.ts
git commit -m "feat(install): shrink install.sh to a bootstrap that execs the verified binary"
```

---

## Stage 3 — agents behind the handoff

> **Merged into Stage 2 during execution.** `exec` is terminal: once install.sh hands off it
> cannot come back to install agents, so agents could not stay in the shell alongside the
> handoff. Reading the shell test also surfaced that install.sh:430-441 deliberately pairs
> BEFORE installing agents, because a one-use join code can expire during three vendor
> downloads — `install-finish` had that order backwards until a test pinned it.

### Task 7: `install-agents.ts`

**Files:**
- Create: `apps/cli/src/install-agents.ts`
- Create: `apps/cli/src/install-agents.test.ts`
- Modify: `apps/cli/src/install-finish.ts` (call it)
- Modify: `install.sh` (delete :197-252 and :442-481)
- Modify: `scripts/install-sh.test.sh` (agent-install assertions move to TS; keep an end-to-end one)

**Interfaces:**
- Consumes: `SetupIO` (Task 1).
- Produces:

```ts
export type AgentId = 'codex' | 'claude-code' | 'grok'
export interface AgentInstallResult { id: AgentId; ok: boolean; detail?: string }
export async function installAgents(
  io: SetupIO,
  ids: AgentId[],
  binDir: string,
  deps?: InstallAgentsDeps,
): Promise<AgentInstallResult[]>
```

Each agent runs under `io.spinner()`, with vendor output captured and surfaced only on failure.
The Claude standalone checksum fallback (install.sh:197-252) ports intact, including the
manifest checksum parse and the 64-hex-character length check.

- [ ] **Step 1: Write the failing tests**

```ts
it('runs each requested vendor installer once', ...)
it('surfaces vendor output only when an installer fails', ...)
it('falls back to the checksum-verified standalone when Claude self-staging fails', ...)
it('refuses a manifest checksum that is not 64 hex characters', ...)
it('rejects an unsupported agent id', ...)
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Delete the shell versions and run both lanes.**

Run: `bun run test:related -- apps/cli/src/install-agents.test.ts` then `sh scripts/install-sh.test.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/install-agents.ts apps/cli/src/install-agents.test.ts \
  apps/cli/src/install-finish.ts install.sh scripts/install-sh.test.sh
git commit -m "feat(cli): install the vendor agent CLIs from behind the handoff"
```

### Task 8: Final gate

- [ ] **Step 1:** `bun run typecheck --filter @podium/cli --filter @podium/runtime --concurrency=1`
- [ ] **Step 2:** `bun run lint:boundaries`
- [ ] **Step 3:** `bun run test` — report as "lean gate green", never as "tests pass".
- [ ] **Step 4:** `sh scripts/install-sh.test.sh`
- [ ] **Step 5:** Capture the new installer and setup output as issue artifacts.

---

## Self-review

**Spec coverage.** R1-R3 → Task 6. R4, R6-R8, R10 → Task 5. R5 → Task 3. R9 → Tasks 1, 2, 5.
Contracts: `SetupIO` → Task 1; `install-finish` flags → Task 5; module table → Tasks 1, 3, 4, 5, 7;
`install.sh`'s six jobs → Task 6. Staging maps to Stage 1 (Tasks 1-2), Stage 2 (Tasks 3-6),
Stage 3 (Task 7). The spec's testing section maps to the test steps in Tasks 2, 3, 6 and 7.

**Gap found and closed.** The spec says supervision keeps the user-bus probe and both repairs,
but `installSystemd` already enables linger — so Task 4's interface covers only the
`XDG_RUNTIME_DIR` recovery and says why, rather than duplicating linger.

**Type consistency.** `SetupIO` is declared once in Task 1 and consumed unchanged in Tasks 2, 5
and 7. `InstallFinishOptions` is produced in Task 5 and parsed from the flags Task 6 passes;
`--managed`/`--shared` appear in Task 5's parser (accepted, inert) and in Task 6's flag list.
`persistPath`/`pathHint` names match between Tasks 3 and 5. `AgentId` is defined in Task 7 and
`InstallFinishOptions.agents` is `string[]`, narrowed at the Task 7 boundary — deliberate, so
Task 5 does not depend on Task 7.

**Ordering.** Task 6 deletes shell that Task 5's subcommand must already replace, so 5 precedes
6. Task 7 deletes the agent shell last, so Stage 2 can ship with agents still installed by
`install.sh`.
