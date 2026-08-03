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
  declaredValue,
  type HarnessCapabilities,
  type HarnessLogin,
} from './manifest.js'
import { claudeCodeManifest } from './manifests/claude-code.js'
import { codexManifest } from './manifests/codex.js'
import { cursorManifest } from './manifests/cursor.js'
import { grokManifest } from './manifests/grok.js'
import { opencodeManifest } from './manifests/opencode.js'

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

export function harnessDisplayName(kind: AgentKind | string): string {
  return manifestFor(kind)?.displayName ?? kind
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
 * NATIVE LOGIN DETECTION for one harness, by kind (POD-335).
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
): HarnessLogin | undefined {
  return manifestFor(kind)?.inventory.detectLogin(homeDir)
}
