# Agent Harness Implementation Checklist

Adding a harness on existing mechanisms is three edits. Use this checklist when
adding or auditing one so it matches the design, not the pre-ADR-10 history.

- One directory under `packages/harness/src/adapters/<name>/` declaring every
  `AgentManifest` section (`packages/harness/src/manifest.ts`).
- One registry line in `AGENT_MANIFESTS` (`packages/harness/src/registry.ts`).
- One `HarnessAgent` entry in `@podium/model`
  (`packages/model/src/entities/agent.ts`) — the closed set lives there by
  decision (ADR 10 § *The closed set lives in the model package*, 2026-09-28:
  `@podium/harness` already imports `@podium/model` throughout, so defining
  the list in the harness package would be a package cycle). The earlier
  "one directory plus one registry line" wording overstated the design; the
  spec (`docs/plans/pod-4414-harness-adapter-spec.html` §2–§5) and ADR 10 were
  corrected on integrate (`0fb1744a1`). The exhaustive
  `Record<BuiltinHarnessKind, AgentManifest>` makes a missing kind a compile
  error.
- A new driver family under `packages/harness/src/driver/families/` **only**
  if no existing family fits (see §3). Most harnesses never need this.

Design authority: ADR 10
(`docs/adr/0010-harness-adapter-and-driver-boundary.md`) and the POD-4414 spec
REV 2 (`docs/plans/pod-4414-harness-adapter-spec.html` §3–§5, §10). Detail
below names the code that enforces each item; a test fixture harness registers
through `registerTestManifest` instead of joining the closed set — that is a
test double, not the path a shipped harness takes.

## 1. The three edits

- [ ] New directory `packages/harness/src/adapters/<name>/` with an
  `index.ts` exporting `<name>Manifest: AgentManifest`, one file per section
  group (see `adapters/claude-code/`, `adapters/pi/`, `adapters/cursor/` for
  the shape: `descriptor.ts`, `catalog.ts`, `transcript.ts`, `discovery.ts`,
  `state.ts`, `credentials.ts`, `usage.ts`, `install.ts`, …).
- [ ] One line in `AGENT_MANIFESTS` (`packages/harness/src/registry.ts`)
  keyed by the new kind. No other registry table: `HARNESS_KINDS`,
  `CLIENT_TERMINAL_HARNESSES`, `driverFamilyForId`, and the descriptor
  builders all derive from this record.
- [ ] One entry in `HarnessAgent` (`packages/model/src/entities/agent.ts`).
  Keep every derived slice beside it (`COST_*`, `HANDOFF_*`, `CLOUD_*`,
  `USAGE_*`, `OBSERVATION_*`, `PORTABLE_CREDENTIAL_*`,
  `AGENT_CHOICE_*`) derived via `z.enum(SLICE)` — never restate the set as a
  second literal. `shell` stays out: it is a spawnable kind, not a harness.

## 2. Declare every section — `supported(value)` or `declined(reason)`

The compiler lists every missing section; the registry refuses every empty
reason. Each `Declared<T>` is `supported(value)` or `declined(reason)`, and
`assertDeclinedReasonsValid` (run by `registry.test.ts` and both generators
below) throws on an empty or placeholder reason. Write why the harness cannot
do it, for a reader deciding whether the gap is permanent.

- [ ] Always-required fields (plain, never `Declared`, never declined):
  `descriptor` + `catalog` (adapter's own `descriptor.ts`/`catalog.ts` rows —
  the ONE label/mark/icon/brand statement; `descriptor.shortLabel` is the one
  short label), `capabilities`, `resumeKind`, `environment`
  (`removeInherited` + optional `instanceHome`; empty is a decision, so a new
  harness cannot silently inherit its parent's identity), `launch`,
  `discovery`, `runtime` (with required `terminal`, see §3), `stateChannels`.
- [ ] `Declared` sections — implement or decline with a real reason:
  `credentials`, `usage`, `install`, `exec`, `headless`, `state`,
  `instrumentation`, `observer`, `transcript`, `composer`,
  `handoffTranscript`, `classifyBrowserOpen`, plus the nested declarations the
  `sectionStatusesOf` walk covers (`inventory.loginCommand`,
  `loginCommandProbe`, `loginIdentity`, `portableCredential`;
  `runtime.server`, `runtime.embedded`; `usage.quota/history/transcripts`;
  `headless.buildExec`; `runtime.server.versionRange/clientTerminal`;
  `transcript.recordToItems/recordRuntime/recordColor/chainPaths/sqliteLocator`;
  `credentials.transfer`). A harness may land with launch and discovery only
  and `unsupported('…')` for the rest, then grow sections in later PRs.
- [ ] `capabilities` fully stated (no parallel table): `argvPrompt`,
  `effortFlag`, `systemPromptFlag`, `newSessionIdFlag`, `quota`, `cloud`,
  `composerScrape`, `oscTitle`, `subagentModelEnv`, `promptModeHints`,
  `handoff`, `mcp`, `hookInstall`, `observationProvider`,
  `observationProtocol`, `submitVerification`, `composerReadiness`,
  `rawFirstTurn`, `exclusiveInteractiveResume`, `promptTitleFallback`,
  `mcpConfigTransport`, `interruptKey`, `interruptQuitsWhenIdle`.
- [ ] `inventory.executable` (`names`, `versionArgs`, optional
  `identityProbe` for ambiguous binary names) plus `detectLogin`; interactive
  login goes through the declared `loginCommand`, never a second encoding.
- [ ] Regenerate the two projections and check them in:
  `bun scripts/harness-matrix.ts` →
  `docs/architecture/harness-support-matrix.md` (the *implemented* input;
  never a session's capability), and `bun scripts/harness-descriptors.ts` →
  `packages/harness/src/adapters/bundled-descriptors.generated.ts` (the
  bundled fallback). CI runs both with `--check`.

## 3. Drive it — the `runtime` axis, and a new family only if none fits

- [ ] `runtime.terminal` is required (`driverId`, `sendProof`,
  `acceptCorrelation`) — the terminal family
  (`packages/harness/src/driver/families/terminal`, today `generic-pty`) is
  the permanent tier and fallback, not a deprecation path.
- [ ] `runtime.server` / `runtime.embedded` are `Declared`: `supported(spec)`
  with `driverId`, `transport`, `spawn`, `versionRange`, `clientTerminal`
  (plus `serverAlternatives` where the harness ships a second mechanism), or
  `declined` with the verification still owed (e.g. pi's
  `--mode rpc is real but Podium has not driven it yet`).
- [ ] `select(ctx)` is a pure function of `SelectionContext` (auth, platform,
  available, preference) ending in this harness's terminal driver id, via
  `selectRuntimeDriver`. A new protocol or store kind adds an implementation
  **inside the harness package** (`driver/families/<family>/`) and still
  changes no application consumer; driver ids are the closed `DRIVER_IDS`
  list in `manifest.ts`.
- [ ] History from disk: no family answers transcript history from a protocol
  call or process memory — the protocol stream carries deltas only, and live
  drivers read history through the injected Store port
  (`transcriptSourceFromGrammar` / `readEngineHistoryFromGrammar`). The
  `history-from-disk` lint enforces the history body; the `terminal-objects-*`
  lints enforce the process/terminal/driver/server shape (ADR 10 Decisions B/C).
- [ ] Import direction (the `harness-own-adapter` lint): nothing in
  `adapters/` imports a mechanism; no mechanism imports a specific adapter,
  only the Adapter type. Exception: a driver family directory named after a
  harness may import its **own** adapter directory and no other. The terminal
  family, `driver/host.ts`, `driver/runtime.ts`, `store/`, `inventory/`, and
  `observer.ts` must not import any specific adapter; the Store's transcript
  sources stay the one reader of transcript grammars; the registry stays the
  one composition root.

## 4. What you do NOT touch

- [ ] No web/mobile labels, icons, menus, model selectors, or resume labels:
  presentation comes from the adapter's `descriptor`/`catalog` sections,
  served per machine by `buildServedDescriptors` (implemented + available
  flags) and bundled for offline clients via the generated snapshot read
  through `@podium/harness/browser` only. Composer rules are bundled code,
  never served over the wire.
- [ ] No per-harness branches outside `adapters/` and `driver/families/`:
  the `harness-vendor-boundary` identifier lint fails new harness literals
  elsewhere. `leak` entries must only shrink; `policy` entries (e.g. the
  superagent harness order in `harness-defaults.ts`) stay in their owning
  policy module with a one-line reason — never move product preference into
  an adapter. Comments, fixtures, and historical migrations are excluded.
- [ ] No second closed set, no second capability table: subsets derive beside
  `HarnessAgent`; runtime facts derive off the manifests through the registry
  (`manifestFor` degrades unknown ids to `undefined`, never a fallback
  manifest). Capability is three facts from three sources — implemented
  (adapter declarations / matrix), available-on-this-machine (Inventory +
  admission), effective-for-this-session (live handle) — never the matrix
  alone.

## 5. Verification

- [ ] `tsc` totality holds (`Record<BuiltinHarnessKind, AgentManifest>`);
  `registry.test.ts` is green (one manifest per kind, every capability field
  declared, decline reasons valid, closed-set sync with `HarnessAgent`).
- [ ] Both generators are current (`harness-matrix`, `harness-descriptors`
  `--check`); `bun run lint:boundaries` is green.
- [ ] Focused harness tests cover the new adapter: launch command
  construction, transcript grammar (including malformed/torn records and
  real on-disk session-layout fixtures), discovery scans, observer/state
  mapping, and install/credential/usage declarations as supported.
- [ ] Smoke-test the installed CLI help and a bounded safe invocation on the
  local machine when the CLI is available.
- [ ] Unsupported stays visible: every gap is a `declined(reason)` row in the
  matrix, not a silently hidden capability.
