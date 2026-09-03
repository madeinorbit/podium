import { join } from 'node:path'
import type { AgentKind, HarnessAgent } from '@podium/model'
import {
  type BuiltinHarnessKind,
  isBuiltinHarnessKind,
  type ObservationProvider,
} from '@podium/protocol'
import type { TranscriptRecordMapper, TranscriptRuntimeReader } from '@podium/transcript'
import type { AgentStateProvider } from './agent-state/types.js'
import {
  type AgentManifest,
  type ClientTerminalSpec,
  declaredValue,
  type DriverFamily,
  type HarnessCapabilities,
  type HarnessEnvironment,
  type HarnessLogin,
  type PortableCredential,
  type DriverId,
} from './manifest.js'
import { claudeCodeManifest } from './manifests/claude-code.js'
import { codexManifest } from './manifests/codex.js'
import { cursorManifest } from './manifests/cursor.js'
import { grokManifest } from './manifests/grok.js'
import { opencodeManifest } from './manifests/opencode.js'
import { piManifest } from './manifests/pi.js'

/**
 * THE harness registry (#158/POD-303): one manifest per driveable harness kind.
 *
 * The exhaustive `Record<BuiltinHarnessKind, AgentManifest>` makes "new harness =
 * one manifest file + one entry here" a TYPE-CHECKED contract — a missing kind
 * fails compilation, and registry.test.ts asserts every manifest declares every
 * capability field (implemented, or explicitly `unsupported`).
 *
 * The Record is keyed by the CLOSED `BuiltinHarnessKind` on purpose. Lookups from
 * the OPEN wire `HarnessId` go through {@link manifestFor}, which returns
 * `undefined` for a harness this build has never heard of — the caller then
 * degrades. There is deliberately NO fallback entry: a default manifest would make
 * an unknown harness silently behave like whichever CLI happened to be the
 * default, which is the exact failure the open/closed split exists to prevent.
 */
export const AGENT_MANIFESTS: Record<BuiltinHarnessKind, AgentManifest> = {
  'claude-code': claudeCodeManifest,
  codex: codexManifest,
  grok: grokManifest,
  opencode: opencodeManifest,
  cursor: cursorManifest,
  pi: piManifest,
}

/**
 * Manifest lookup over an OPEN harness id (a wire `HarnessId`, an `AgentKind`, or
 * any string from an older or newer peer). Returns `undefined` for 'shell' (not a
 * harness) and for unknown harness names — callers MUST branch on that and
 * degrade, never substitute another harness's manifest.
 */
export function manifestFor(kind: AgentKind | string): AgentManifest | undefined {
  return isBuiltinHarnessKind(kind) ? AGENT_MANIFESTS[kind] : undefined
}

/** Static feature declarations for a known harness. Unknown ids and `shell`
 * degrade to no special capabilities rather than borrowing another CLI's row. */
export function harnessCapabilitiesFor(kind: AgentKind | string): HarnessCapabilities | undefined {
  return manifestFor(kind)?.capabilities
}

/**
 * THE ONE LOOKUP THE ATTACH PATH USES (POD-2823).
 *
 * The daemon produces a Native view for a server-family session by running the
 * harness's own TUI beside the engine. It used to decide WHAT to run by asking
 * which harness this is; it now asks the harness, through here. Unknown ids, a
 * harness with no server mode, and a server harness that ships no attachable
 * client all answer `undefined` — three different reasons, one caller-visible
 * outcome ("this session has no Native view"), which is the only distinction the
 * attach path can act on.
 */
export function clientTerminalFor(
  kind: AgentKind | string,
  driverId?: DriverId,
): ClientTerminalSpec | undefined {
  const runtime = manifestFor(kind)?.runtime
  const primary = runtime?.server && declaredValue(runtime.server)
  const server =
    driverId === undefined || primary?.driverId === driverId
      ? primary
      : runtime?.serverAlternatives?.find((candidate) => candidate.driverId === driverId)
  const clientTerminal = server?.clientTerminal
  return clientTerminal ? declaredValue(clientTerminal) : undefined
}

/**
 * Every harness that declares a client terminal, DERIVED from the registry.
 *
 * The teardown path needs this: with no attachment record in hand, "is a parked
 * master still holding a label for this session?" has to be asked of every
 * label that could exist. A hand-written list of three names there was the same
 * defect as a branch — a fourth driver would have been silently skipped, and its
 * abduco master left resident until the machine rebooted. Reading it off the
 * manifests makes the declaration the only thing that has to be right.
 */
export const CLIENT_TERMINAL_HARNESSES: readonly BuiltinHarnessKind[] = (
  Object.keys(AGENT_MANIFESTS) as BuiltinHarnessKind[]
).filter((kind) => clientTerminalFor(kind) !== undefined)

/** Portable native-login declaration without exposing process-driving APIs. */
export function harnessPortableCredential(
  kind: AgentKind | string,
): PortableCredential | undefined {
  const declaration = manifestFor(kind)?.inventory.portableCredential
  return declaration ? declaredValue(declaration) : undefined
}

const PROPAGATABLE_HARNESSES: Partial<Record<AgentKind, true>> = {
  'claude-code': true,
  codex: true,
}

/** Native logins whose guarded credential files may be propagated between machines. */
export function harnessSupportsCredentialPropagation(
  kind: AgentKind | string,
): kind is 'claude-code' | 'codex' {
  return PROPAGATABLE_HARNESSES[kind as AgentKind] === true
}

export function harnessSupportsInitialPrompt(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.argvPrompt ?? false
}

export function harnessSupportsEffort(kind: AgentKind | string): boolean {
  return (harnessCapabilitiesFor(kind)?.effortFlag ?? 'none') !== 'none'
}

export function harnessSupportsCloud(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.cloud ?? false
}

export function harnessShowsPromptModeHints(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.promptModeHints ?? false
}

export function harnessSupportsHandoff(kind: AgentKind | string): kind is 'claude-code' | 'codex' {
  return harnessCapabilitiesFor(kind)?.handoff ?? false
}

export function harnessSupportsMcp(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.mcp === 'full'
}

export function harnessObservationProvider(
  kind: AgentKind | string,
): ObservationProvider | undefined {
  const provider = harnessCapabilitiesFor(kind)?.observationProvider
  return provider === 'none' ? undefined : provider
}

export function harnessObservationProtocol(
  kind: AgentKind | string,
): HarnessCapabilities['observationProtocol'] | undefined {
  return harnessCapabilitiesFor(kind)?.observationProtocol
}

export function harnessNeedsSubmitVerification(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.submitVerification ?? false
}

export function harnessUsesRawFirstTurn(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.rawFirstTurn ?? false
}

/**
 * When this harness's composer is known to accept typed input (POD-2823).
 *
 * `on-bind` for an unknown harness: a build that has never heard of this CLI
 * cannot claim to know its start-up window, and guessing `confirmed-turn` would
 * queue every send behind a proof this build has no idea how to obtain.
 */
export type HarnessComposerReadiness = HarnessCapabilities['composerReadiness']

export function harnessComposerReadiness(kind: AgentKind | string): HarnessComposerReadiness {
  return harnessCapabilitiesFor(kind)?.composerReadiness ?? 'on-bind'
}

/** How to abort a running turn in one harness's TUI: the key, the bytes that key
 *  is on a PTY, and whether pressing it outside a turn would exit the CLI. */
export interface HarnessInterrupt {
  key: HarnessCapabilities['interruptKey']
  /** PTY encoding of {@link key} — what a caller actually writes. */
  bytes: string
  quitsWhenIdle: boolean
}

const INTERRUPT_BYTES: Record<HarnessCapabilities['interruptKey'], string> = {
  esc: '\x1b',
  'ctrl-c': '\x03',
}

/**
 * The abort chord for a session of this kind (POD-1214).
 *
 * TWO kinds have no manifest to ask, and they want opposite things, so both are
 * named here rather than left to a single shared default:
 *
 *   'shell'   Ctrl-C, because a shell's abort IS SIGINT and there is no TUI to
 *             ask. Harmless at an idle prompt (a fresh prompt line), so no guard.
 *   unknown   Esc, the conservative guess for a CLI this build cannot name:
 *             wrong-and-inert beats wrong-and-fatal, and Ctrl-C into an unknown
 *             TUI risks killing an agent mid-turn.
 */
export function harnessInterrupt(kind: AgentKind | string): HarnessInterrupt {
  if (kind === 'shell')
    return { key: 'ctrl-c', bytes: INTERRUPT_BYTES['ctrl-c'], quitsWhenIdle: false }
  const capabilities = harnessCapabilitiesFor(kind)
  const key = capabilities?.interruptKey ?? 'esc'
  return {
    key,
    bytes: INTERRUPT_BYTES[key],
    quitsWhenIdle: capabilities?.interruptQuitsWhenIdle ?? false,
  }
}

export function harnessRequiresExclusiveInteractiveResume(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.exclusiveInteractiveResume ?? false
}

export function harnessUsesPromptTitleFallback(kind: AgentKind | string): boolean {
  return harnessCapabilitiesFor(kind)?.promptTitleFallback ?? false
}

export function harnessMcpConfigTransport(
  kind: AgentKind | string,
): HarnessCapabilities['mcpConfigTransport'] {
  return harnessCapabilitiesFor(kind)?.mcpConfigTransport ?? 'none'
}

export function harnessPremintsHeadlessResumeId(kind: AgentKind | string): boolean {
  const headless = manifestFor(kind)?.headless
  const value = headless ? declaredValue(headless) : undefined
  return (
    value?.resumeIdAllocation === 'sdk-session-uuid' ||
    value?.resumeIdAllocation === 'daemon-minted-uuid'
  )
}

/**
 * True only when the adapter has a native all-tools-off mechanism. Unknown and
 * merely sandboxed harnesses fail closed.
 *
 * RE-EXPORTED, not implemented here (POD-2206). It used to read
 * `manifestFor(kind)?.headless`, which made a one-bit static fact cost the whole
 * registry — and a browser cannot pay that: the manifests reach sqlite modules
 * whose top-level `createRequire` a bundle cannot answer, which is what crashed
 * every /settings route (POD-2176). The fact now lives in `./browser.ts`, which
 * imports nothing, so both a bundle and this registry can state it. One
 * implementation, no call site changed; `browser.test.ts` holds the table to
 * what the manifests declare.
 */
export { harnessSupportsNoTools } from './browser.js'

export function harnessDisplayName(kind: AgentKind | string): string {
  return manifestFor(kind)?.displayName ?? kind
}

/**
 * Is this driver id a SERVER-family one — declared by some harness as its
 * server driver? Read off the manifests, never a table (POD-2249).
 *
 * The daemon has asked this of the manifests since POD-2113
 * (`runtime/registry.ts`'s `isServerDriverId`); this static twin exists because
 * the SERVER now needs the same fact — a `killed:false` reap receipt must not
 * blind-reattach a server-family session, whose reattach path can SPAWN (codex
 * `adopt()` starts a fresh app-server) — and the row's `driverId` is all it
 * holds. Pure metadata: names no process, reaches no host.
 */
export function driverIdIsServerFamily(driverId: string): boolean {
  return driverFamilyForId(driverId) === 'server'
}

/**
 * WHICH FAMILY does this driver id belong to (POD-2290)? Read off the manifests,
 * never a table — the same rule {@link driverIdIsServerFamily} follows, and this
 * is now its implementation.
 *
 * `undefined` means NOT THAT THIS BUILD HAS NO FAMILIES but that no manifest
 * claims the id: the conformance `fake` driver, or an id from a newer daemon.
 * Every caller must therefore have an answer for "unknown", and the honest one
 * is whatever it would have done before driver families existed.
 *
 * WHY A FAMILY AND NOT A BOOLEAN. The question a client actually asks is "does
 * this session have a terminal", and `server` is only one of the two answers
 * that mean no — `embedded` (the SDK loop in a runtime-owned worker) has no PTY
 * either. A `isServerFamily`-shaped flag would have to be re-derived, or gain a
 * second flag beside it, the day the first embedded driver binds.
 */
export function driverFamilyForId(driverId: string): DriverFamily | undefined {
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    if (declaredValue(manifest.runtime.server)?.driverId === driverId) return 'server'
    if (manifest.runtime.serverAlternatives?.some((server) => server.driverId === driverId))
      return 'server'
    if (declaredValue(manifest.runtime.embedded)?.driverId === driverId) return 'embedded'
    if (manifest.runtime.terminal.driverId === driverId) return 'terminal'
  }
  return undefined
}

/**
 * MIGHT a session with this resume-ref kind be server-driven? True exactly when
 * the harness that owns the kind declares a server driver (POD-2249).
 *
 * "MIGHT", deliberately: `resumeKind` is a per-HARNESS fact, so `codex-thread`
 * names PTY-driven codex sessions too. This is the DURABLE approximation of
 * {@link driverIdIsServerFamily} for a row whose `driverId` did not survive —
 * that field is transient by design (re-established on bind), while the resume
 * kind is in `toRow()`. A caller holding both should prefer the driver id; this
 * exists for the post-redeploy row that has only the kind, where failing open
 * is the spawn loop and failing closed is a held park.
 */
export function isServerFamilyResumeKind(resumeKind: string): boolean {
  return Object.values(AGENT_MANIFESTS).some(
    (manifest) =>
      manifest.resumeKind === resumeKind &&
      (declaredValue(manifest.runtime.server) !== undefined ||
        (manifest.runtime.serverAlternatives?.length ?? 0) > 0),
  )
}

export function harnessResumeKind(kind: HarnessAgent): string
export function harnessResumeKind(kind: AgentKind | string): string | undefined
export function harnessResumeKind(kind: AgentKind | string): string | undefined {
  return manifestFor(kind)?.resumeKind
}

/** The native-record mapper declared by this CLI's manifest. SQLite-backed,
 * unknown, and shell sessions have no JSONL mapper. */
export function transcriptRecordMapperFor(
  kind: AgentKind | string,
): TranscriptRecordMapper | undefined {
  const declaredTranscript = manifestFor(kind)?.transcript
  const transcript = declaredTranscript ? declaredValue(declaredTranscript) : undefined
  return transcript ? declaredValue(transcript.recordToItems) : undefined
}

/** The runtime-fact reader declared by this CLI's manifest — what model, effort
 * and context use its records report. Harnesses that report none (and unknown
 * kinds) return undefined, so the caller observes nothing rather than inferring
 * it from another harness's record conventions. */
export function transcriptRuntimeReaderFor(
  kind: AgentKind | string,
): TranscriptRuntimeReader | undefined {
  const declaredTranscript = manifestFor(kind)?.transcript
  const transcript = declaredTranscript ? declaredValue(declaredTranscript) : undefined
  return transcript ? declaredValue(transcript.recordRuntime) : undefined
}

/** @deprecated Renamed to {@link manifestFor}. Kept so POD-398/399 can retire the
 *  remaining call sites without widening this leaf's diff. */
export const harnessAdapterFor = manifestFor

/** @deprecated Renamed to {@link AGENT_MANIFESTS}. */
export const HARNESS_ADAPTERS = AGENT_MANIFESTS

/**
 * The state-provider registry. Kinds whose manifest declares `state` unsupported —
 * and unknown kinds — return undefined, so phase stays 'unknown' instead of being
 * inferred from another harness's output conventions.
 */
export function agentStateProviderFor(kind: AgentKind): AgentStateProvider | undefined {
  const manifest = manifestFor(kind)
  return manifest ? declaredValue(manifest.state) : undefined
}

/** Resolve a resume.kind ('grok-session', 'codex-thread', …) to its harness. */
export function harnessKindForResumeKind(resumeKind: string): HarnessAgent | undefined {
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    if (manifest.resumeKind === resumeKind) return manifest.kind
  }
  return undefined
}

/**
 * LOCAL LOGIN FALLBACK for one harness, by kind (POD-335). This compatibility
 * surface is synchronous and never runs a provider CLI.
 *
 * A named function rather than a second reach for {@link AGENT_MANIFESTS}, and
 * the reason is the boundary rather than tidiness. `apps/server`'s Accounts hub
 * needs one fact — "is this CLI logged in, and as whom" — and used to get it by
 * importing the whole manifest registry, which also carries launch, exec, PTY
 * and probe APIs it must never hold (`manifest-consumers` in the architecture
 * manifest). Handing it the ANSWER instead of the registry is what lets that
 * rule be precise instead of a whole-package ban with an allowlist under it.
 *
 * `undefined` for an unknown kind — never another harness's detector, the same
 * open/closed discipline {@link manifestFor} states at length.
 */
export function harnessDetectLogin(
  kind: AgentKind | string,
  homeDir: string,
  env?: HarnessEnvironment,
): HarnessLogin | undefined {
  return manifestFor(kind)?.inventory.detectLogin(homeDir, env)
}

/**
 * The harness-specific home selector this CLI must follow into `homeDir`.
 *
 * The declaration ({@link AgentManifest.environment}`.instanceHome`) already
 * existed and already governed the CHILD a spawn creates; this is that same rule
 * read from one place so a login PROBE can compose the identical environment.
 * Empty for a harness that derives its state root from `HOME` alone.
 */
export function harnessInstanceHomeEnv(
  kind: AgentKind | string | undefined,
  homeDir: string | undefined,
): Record<string, string> {
  if (!kind || !homeDir) return {}
  const selector = manifestFor(kind)?.environment.instanceHome
  return selector ? { [selector.variable]: join(homeDir, selector.relativeDir) } : {}
}

/**
 * THE ENVIRONMENT A LOGIN READ MUST RUN UNDER TO ANSWER FOR `credentialHome`
 * (POD-2692) — and it is the environment the CHILD gets, deliberately, because
 * that is the whole point.
 *
 * Three things decide how a session starts, and each of them used to pick its own
 * home: the inventory probe that publishes installed/ready/logged-in, the
 * synchronous admission gate that decides whether a headless driver may be used,
 * and the `HOME` the spawned child actually lives in. Measured on a named
 * instance whose agent-home was logged OUT while the operator's home was logged
 * IN, the inventory answered `in` — as the operator, naming the operator's email
 * — while the gate and the child answered `out`. So Podium reported a harness
 * ready and then handed the session a home with no credential in it. Pair them
 * the other way round and a signed-in instance is demoted onto the interactive
 * login path instead. Both failures have already happened on this epic
 * (POD-2631, POD-2772).
 *
 * `HOME` ALONE DOES NOT GET THERE. `CODEX_HOME` and `GROK_HOME` override it, and
 * the manifest already says so: "an ambient selector can redirect the child back
 * into the daemon operator's real harness state". That warning was applied to the
 * child spawn and to nothing else, which is exactly how a readout that ignores
 * the instance home survived — the child followed the selector, the probe did
 * not. The strip lists are here for the same reason: a `foreignCredentialEnv`
 * left in the probe's environment makes it report the account an inherited API
 * key selects, while the child, which strips that key, runs as the login on disk.
 *
 * NOT FOR VERSION PROBES. `<binary> --version` answers "what can this MACHINE
 * run" and reads no per-user auth; `serverChildEnv` in apps/daemon already draws
 * that line and it stays drawn. This composition is only for reads that name an
 * account.
 */
export function harnessLoginReadEnv<Value extends string | undefined>(
  kind: AgentKind | string,
  credentialHome: string,
  machineEnv: Readonly<Record<string, Value>>,
): Record<string, Value | string> {
  const manifest = manifestFor(kind)
  const stripped = new Set([
    ...(manifest?.inventory.foreignCredentialEnv ?? []),
    ...(manifest?.environment.removeInherited ?? []),
  ])
  const env: Record<string, Value | string> = {}
  for (const [key, value] of Object.entries(machineEnv)) {
    if (!stripped.has(key)) env[key] = value
  }
  return { ...env, HOME: credentialHome, ...harnessInstanceHomeEnv(kind, credentialHome) }
}

/**
 * Whether this inventory fact requires the interactive login path before a
 * server-family session can be admitted. Most harnesses reserve `unknown` for
 * genuinely inconclusive reads. Codex also uses it for the short replacement
 * grace after auth.json disappears, where app-server cannot answer yet.
 *
 * Keep that harness variance here so generic hosts consume the adapter-owned
 * answer without branching on a harness identity.
 */
export function harnessLoginNeedsInteractive(
  kind: AgentKind | string,
  state: HarnessLogin['state'] | undefined,
): boolean {
  return state === 'out' || (kind === 'codex' && state === 'unknown')
}
