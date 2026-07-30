import {
  type AgentKind,
  type BuiltinHarnessKind,
  type HarnessAgent,
  isBuiltinHarnessKind,
} from '@podium/protocol'
import type { AgentStateProvider } from './agent-state/types.js'
import { type AgentManifest, declaredValue } from './manifest.js'
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
