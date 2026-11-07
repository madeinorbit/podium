# Harness access contract

Status: accepted design, being implemented under POD-6520. Work lands on `integrate/6520-harness-access-contract` (based on `dev/mw`), and that branch moves to `dev/mw` only on the user's word.

This document is the single reference for the work. Each sub-issue brief repeats the part it needs. When a brief and this document disagree, this document wins; tell POD-6520 so the brief gets fixed.

## 1. The problem

Podium has no single place that answers three questions about a harness:

1. **Which binary** runs (the exact executable and its verified version)?
2. **Which environment** does it run with (PATH, HOME, harness selectors, credentials)?
3. **Which folders** hold its state (config, credentials, hooks, transcripts, history)?

Every caller answers these again. Each answer falls back to whatever the daemon process happens to have (`PATH`, `process.env`, `homedir()`), and on machines that differ from developers' machines the answers drift apart.

### The incident that exposed it

On a fresh macOS desktop install, a headed Codex session ran in its terminal and wrote its transcript, but the chat view stayed empty. The chain:

- The GUI-launched daemon inherited `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Codex lived in `/opt/homebrew/bin`.
- Launch used the inventory's verified absolute path plus the recovered command environment, so the terminal worked.
- The Codex hook installer probed a bare `codex --version` under the daemon's own PATH. That failed, so no Podium hooks were installed.
- Without hooks, and without Linux `/proc`, nothing bound the session to its rollout file, so no transcript reached the server.

The POD-6509 hotfix (`4543f1c2f7`) fixed this instance: hook install now uses the launch snapshot's version, and headed Codex binds through the owned child process on macOS. The bug class remains. Evidence: the original handover is artifact 1 on POD-6520 (finding IDs F01-F12).

### What is still in the code (verified at `4543f1c2f7`)

| Question | Places that answer it | Example of a wrong answer |
| --- | --- | --- |
| Which `codex`? | `bindHarnessLaunch` (correct); admission probes (`host-runtime.ts` → `runtime/version-probe.ts`, bare `codex`/`grok`, no env); Codex/Grok engine hosts (`facts.command`, a basename); Claude/OpenCode engines (`executablePath ?? basename`, frozen at daemon start); native attach (`cmd: 'codex'` straight to `spawnClient`) | On the incident Mac, a Codex **app-server** session still fails admission while the terminal works. |
| Where is Codex's state? | 8 sites with 5 precedence orders: `control/codex.ts` (ambient `CODEX_HOME` first), `adapters/codex/index.ts` (session `CODEX_HOME` first), instrumentation/state-provider/rollout (option ?? `homeDir` ?? `homedir()`), `usage.ts` (never reads `CODEX_HOME`), `session-observers.ts` (added by the hotfix, with its own order) | Usage reads `~/.codex` while launch honors a redirected home; the Codex API call can follow the daemon's own `CODEX_HOME` instead of the account's. |
| Which environment? | At least 5 recipes: `effectiveEnv`, `spawnEnv`, `serverChildEnv` (base `process.env`), `headlessSpawnEnv`/`headlessTurnEnv`, the attach composition. Codex compat env is hardcoded in the daemon. | Engine children get the GUI app's PATH, not the recovered one. Inherited API keys can look "explicitly selected" once the env is flattened (F10). |
| Version caches | One module-level cache per family, not keyed by executable | A verdict for one installation vouches for another. |

Scale in `packages/harness/src` (non-test): 146 optional context parameters (`homeDir?`, `env?`, `executablePath?`, …), 42 `?? homedir()` fallbacks, 32 `process.env` reads.

**The hotfix repeated the pattern.** It added `verifiedVersion?`, `harnessHome?` and `ownedProcess?`, a `launchSnapshots` WeakMap that smuggles the snapshot from instrumentation to launch, and one more Codex-home derivation. With no single place to ask, even the fix answered the question again. The cure has to be structural.

## 2. Principles

1. **One value answers the three questions.** It is built once, from the inventory, and is immutable.
2. **Required, never optional.** An optional context parameter with an ambient fallback is the bug pattern itself. A required parameter makes the compiler list every caller.
3. **Adapters declare; the contract executes.** Adapters say *what* (argv, folder rules, env needs). Only the contract turns that into a process or a path.
4. **Sessions pin; management asks per account.** A running session never changes installation or folders. Operations without a session get a context for the selected account.
5. **Provenance survives until the process boundary.** Inherited and explicitly chosen credentials stay distinguishable until the child env is built.
6. **Enforce with a ratchet and a poisoned machine.** A lint that only lets bypasses go down, plus a test where every ambient answer is a decoy.

## 3. The design

### 3.1 `HarnessInstallation` and `HarnessContext`

New module `packages/harness/src/harness-context.ts`, exported from `@podium/harness`.

```ts
/** Machine level, from the inventory. Nothing account-specific. */
interface HarnessInstallation {
  kind: BuiltinHarnessKind
  executable: string   // absolute, verified by the inventory
  version: string      // verified when the inventory was built
  generation: number   // command-environment generation
}

/** Installation + account. Everything that touches a harness takes this. */
interface HarnessContext {
  installation: HarnessInstallation
  home: string         // account HOME
  env: Readonly<Record<string, string>>  // account environment
  roots: HarnessRoots  // resolved once from the adapter's declaration
}
```

**Both are plain data, with no methods.** A session can hold one, modules can pass it around, and tests can build one by hand. Behavior lives in functions that take a context.

Builder: `harnessContext(snapshot, kind, home)`.

- Throws when the kind is not installed. Never falls back to a basename.
- `env = harnessLoginReadEnv(kind, home, snapshot.commandEnvironment.env)` (`packages/harness/src/registry.ts`). That function is already the documented "environment the child gets for this account" (POD-2692): it strips foreign credentials and `removeInherited`, sets `HOME`, and sets the instance selectors from the home. Reuse it; write no new recipe.
- `roots = manifest.roots(home, env)`.
- `home` is the daemon's existing credential home: `credentialHome = accountHome?.path ?? homeDir ?? machineHome` (`apps/daemon/src/host-runtime.ts`). Management code reaches it through `resolveManagementCredentialHome` (`harness-management.ts`). There is no other home.
- Machine-level facts (version probes) use `installation` plus the machine command env, never the account env.

The installation record leaves room for a later `managed | external` provenance field. That field and installation management are out of scope (see §6).

### 3.2 Adapter roots

Each adapter (all six plus the fixture) declares one required rule:

```ts
roots(home: string, env: HarnessEnvironment): HarnessRoots
// HarnessRoots = { state: string; config?; credentials?; transcripts?; hooks? }
```

One rule shape everywhere: `env[selector]?.trim() || join(home, defaultDir)`, the same precedence as the credential layouts' `homeEnvVar`.

| Harness | Selector | Default under home |
| --- | --- | --- |
| Codex | `CODEX_HOME` | `.codex` |
| Claude Code | `CLAUDE_CONFIG_DIR` | `.claude` |
| Grok | `GROK_HOME` | `.grok` |
| Pi | `PI_CODING_AGENT_DIR` | `.pi/agent` |
| OpenCode | `XDG_DATA_HOME` / `XDG_CONFIG_HOME` | per `adapters/opencode/paths.ts`, `opencode/db.ts` |
| Cursor | per `cursor/paths.ts` | per `cursor/paths.ts` |

Because `env` comes from `harnessLoginReadEnv`, which sets the instance selector from the home, an ambient `CODEX_HOME` in the daemon's own environment never redirects an account's folders. That matches what the session child already gets today.

Claude Code and OpenCode have no instance selector, because setting theirs is not neutral: `CLAUDE_CONFIG_DIR` also moves `.claude.json` out of the home root and re-keys the macOS keychain item to a hash of the folder. They declare `environment.operatorSelectors` instead (`CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`; `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`). For a named account (home ≠ the command env's `HOME`), `harnessLoginReadEnv` drops them, so the context, every account read and the child use the defaults under the account home, and the Claude keychain item is the unscoped one, as with no selector set. The machine's own account keeps the operator's values. `harnessChildEnv` returns any the child does not carry in `strip`, so the daemon's own copy cannot return at the boundary. A value a session layer sets explicitly still wins (POD-6604).

### 3.3 Scopes

- **Session scope.** A context is built once at spawn and carried on `SessionSpec.harnessContext`. It is required for every non-shell harness. Server families already receive `SessionSpec` through `ServerFamilyLaunch`, so engines read the same carrier. Everything session-related reads it: launch, hook install, observer, transcript tail, engine launch, admission, attach, resume.
  - Lifetime: daemon memory, with the session. The binding store is not extended (it is schema-versioned).
  - Reattach after a daemon restart rebuilds the context from the current inventory. Roots depend only on home and env, so a rebuilt context reads the same folders, and a running process is never relaunched.
  - An inventory refresh never changes a running session. New sessions get the new generation.
- **Account scope.** `harnessContext(snapshot, kind, resolveManagementCredentialHome(ctx))` serves model probes, quota, usage scans, credential export/import, the Codex Responses call and transcript reads. None of them need a live session.
- **Machine scope.** Version and capability checks use `installation` and the machine command env. Caches key on executable path plus generation.

### 3.4 Starting a harness process

- **Adapters return argv without `cmd`** for launch, exec, login and attach. Today they return `cmd: 'codex'` and rely on a binder to overwrite it, so any path that forgets the binder runs the wrong binary. If adapters cannot name a command, no path can forget.
- **`harnessCommand(context, invocation)` is the only constructor of a launchable spec.** It returns a branded `BoundCommand`.
- **Harness spawn sites accept only `BoundCommand`:** the PTY host spawn, the engine owner spawn, buffered exec and attach `spawnClient`. The shell keeps its own path.
- **OS tools are not harness access.** `ps`, `pgrep`, `lsof`, `/usr/bin/security`, `curl`, `wget`, `ldd` and `sh` go through a small `HostTools` port with absolute paths resolved from the command env.

### 3.5 One child environment

`harnessChildEnv(context, { sessionEnv, wiringEnv, podiumEnv })` replaces `spawnEnv`, `serverChildEnv`, `headlessSpawnEnv`, `headlessTurnEnv`, `effectiveEnv`, `engineEnvBuilder` and the attach composition.

Order (later wins):

1. Machine command env.
2. Remove inherited `foreignCredentialEnv` keys.
3. Session env (`spec.env`).
4. Harness wiring env (instrumentation output).
5. Account `HOME` and instance selectors.
6. Podium vars and the PATH prefix (`PODIUM_CLI_PATH` dir, instance bin roots).

Strip rules, as today:

- `removeInherited` keys (e.g. Claude's `CLAUDE_CODE_SESSION_ID`) are removed from the final env, whatever their source.
- `foreignCredentialEnv` keys are removed unless they came from `spec.env`.

"Explicitly selected" means present in `spec.env`, and only that. Strip decisions never read the composed env (F10).

Known difference to resolve before changing it:

- In the terminal path today, `cmd.env` (which holds the whole command env) is applied after the session env, so the machine env beats the session env, PATH included.
- Engines do the opposite.

The order above makes the session env win in both. Check what `spec.env` carries first.

Harness-specific env such as `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` moves into the adapter's `environment` declaration.

### 3.6 Enforcement

- **Ambient-access ratchet**, built first.
  - A rule `harness-ambient-access` in `scripts/check-boundaries.ts`, modeled on the vendor rule (`checkHarnessVendorLiterals` and its count ratchet).
  - Scope A, adapters and driver families: counts `child_process` imports, `Bun.spawn`, `homedir()`/`os.homedir` and `process.env` per file.
  - Scope B, `apps/daemon`: counts harness folder literals (`.codex`, `.claude`, `.grok`, `.pi/agent`).
  - The allowlist holds measured counts with a category (`to-migrate`, or `os-tool` with a reason). Going above a count fails; going below fails until the count is lowered. Each step lowers counts in the same commit.
- **Poisoned-machine conformance test**, one per adapter.
  - Setup: a failing fake harness binary first on PATH, and decoy `HOME` and selectors with sentinel files, placed in both the machine env and `process.env`. The selected installation is a recording fake binary; the account home sits elsewhere.
  - Run: every supported declared section that needs no model, enumerated through `sectionStatusesOf(manifest)`, so a new section without a case fails the test.
  - Assert: no sentinel was read or modified, and every child's argv[0] is the selected path.
- **Proven armed.** Inject a bare-basename spawn, a `?? homedir()` fallback and a `process.env` selector read into one adapter, one at a time. Both the test and the lint must fail on each.

## 4. Migration plan

Sub-issues of POD-6520, in dependency order. Each ships on its own and leaves the code working. The briefs hold file-level detail.

| Step | Issue | What | Closes |
| --- | --- | --- | --- |
| 1 | POD-6532 Harness context and roots | Types, builder, adapter `roots`; the eight Codex derivations move onto one rule (temporary `harnessRoots(kind, home, env)` helper until steps 2-3 hand a context in) | Codex root drift, F07 root |
| 1b | POD-6545 Harness ambient-access ratchet | Lint with frozen counts; runs alongside step 1 | new bypasses during the migration |
| 2 | POD-6533 Session-pinned harness context | `SessionSpec.harnessContext` for terminal sessions; removes the `launchSnapshots` WeakMap, `selectedSnapshot?`, `harnessSnapshot?`, `verifiedVersion?`, `harnessHome?` | hotfix side channels |
| 2b | POD-6546 Engine and attach harness binding | Engines, admission probes (installation-keyed caches) and native attach read the session context; engine env starts from the command env | F02-F05, the app-server admission bug |
| 3 | POD-6534 Account-scoped harness operations | Model probes, Codex Responses, quota/usage, credentials, transcript reads; after step 1, may run alongside 2/2b | F06-F09 |
| 4 | POD-6535 Single harness child environment | F10 test first, then `harnessChildEnv` | F10, five recipes |
| 5 | POD-6536 Harness access lockdown | argv without `cmd`, `BoundCommand`, required context everywhere, `HostTools`, ratchet to zero, conformance tests proven armed, dormant helpers removed (F11) | the class |
| 6 | POD-6548 Harness contract acceptance run | Real Mac under the incident's conditions | end-to-end proof |

Steps 1 through 2b give the most value: after them, the incident's chain (launch works, everything else looks elsewhere) cannot happen for session-scoped access.

## 5. Acceptance

### Evidence rules (every step)

- A regression test counts only if it **fails on the base and passes after**. Paste the base failure into the handoff.
- A test that cannot fail on the base is a **guard**; call it that.
- Never edit an existing test just to make it pass. A changed expectation needs a listed behavior difference in the commit message.
- Handoffs map each DONE WHEN item in the brief to its evidence.

### Per step (summary; the briefs are authoritative for details)

- **1:** In three setups (default; account home ≠ machine home; decoy ambient `CODEX_HOME`), every migrated Codex site resolves the same folder. It fails on the base in setup 3. Builder and roots unit tests.
- **1b:** Rule tests; a deliberately broken tree fails the lean gate at this rule.
- **2:** The same context reaches instrumentation, launch and observer; the refresh guard (X selected, refresh to Y, launch still uses X); the reattach test; `bun run test:integration`.
- **2b:** Decoy-PATH admission and launch test for all five engine families (fails on base); per-install cache test; engine PATH comes from the command env (fails on base); pinning across refresh; attach test; family conformance tests; `bun run test:integration`.
- **3:** Account matrix with decoy selectors, covering model probe, Claude token, Codex auth/Responses, quota, usage, credential export and transcript roots (fails on base for the model probe). `ANTHROPIC_API_KEY` behavior pinned unchanged. No-snapshot credential refusal. `scripts/managed-account-spawn.integration.test.ts`.
- **4:** F10 test run on the base first; precedence table test; parity across the five paths; old functions deleted; `bun run test:integration`.
- **5:** Ratchet `to-migrate` empty; conformance over `sectionStatusesOf`; three bypasses proven to fail both guards; a `// @ts-expect-error` test for plain `{cmd,args}`; `bun run test:integration`.
- **6:** On a Mac (GUI daemon PATH, Codex via Homebrew only, Claude via its installer, separate instance), seven checks with evidence:
  1. A fresh Codex terminal session with no hooks shows its chat.
  2. The same with untrusted hooks.
  3. A Codex server-mode session passes admission and shows its chat.
  4. Claude in terminal and server mode shows its chat.
  5. Two Codex sessions in the same folder each show only their own conversation.
  6. Model list and quota show the account's data.
  7. A daemon restart mid-conversation keeps the history, and a new prompt streams in.

## 6. Out of scope

- **Harness installation manager** (adopt, install ownership, update, repair, rollback, uninstall). It sits on top of this contract: an update becomes "publish a new installation generation; running sessions keep theirs". Plan it after step 2b, as separate work.
- **Developer tooling, live tests, archived rigs, docs.** The ratchet and conformance tests cover production packages only.
- **Transcript binding without hooks** beyond what the hotfix did. A lead for later: the Claude adapter declares `newSessionIdFlag: false`, although Claude Code accepts `--session-id <uuid>`, so a fresh Claude session binds only through its first hook. Not yet checked whether that was deliberate.

## 7. Working rules for implementers

- Branch from `integrate/6520-harness-access-contract`, land back onto it, and never onto `dev/mw`.
- `bun run setup:worktree`; never `git stash`; format only changed files.
- Focused `bun run test:file` while working, the lanes the brief names, and one lean gate at the end. Never the full suite.
- Line numbers in briefs are from `4543f1c2f7`; search by symbol.
- Questions and blockers: `podium issue mail send 6520`. Otherwise choose the conservative option, record it in the handoff, and continue.
