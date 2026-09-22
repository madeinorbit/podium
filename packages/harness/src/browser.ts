/**
 * `@podium/harness/browser` — THE BROWSER-REACHABLE HALF (POD-2206).
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND ENTRYPOINT, WHEN `./metadata` ALREADY EXISTS
 * ---------------------------------------------------------------------------
 *
 * `@podium/harness/metadata` is the OPEN entrypoint: anyone may import it,
 * because everything it exports is a fact about software rather than an action
 * on a host. That is a statement about the SURFACE, and its own docblock says so
 * — the check behind it (`manifest-open-entrypoint`) deliberately does not walk
 * the closure, because the manifests legitimately reach `node:child_process` and
 * a transitive walk would refuse the whole surface and prove nothing.
 *
 * "Anyone may import it" and "a browser may bundle it" are therefore different
 * claims, and POD-2176 is what it costs to conflate them. `./metadata`
 * re-exports `./registry.js`, which holds `AGENT_MANIFESTS`, which pulls all five
 * manifests, `@podium/transcript`, and `@podium/runtime`'s sqlite modules — and
 * those evaluate `createRequire(import.meta.url)` at MODULE SCOPE. In a browser
 * `node:module` is a stub, so `createRequire` is not a function and the chunk
 * dies while it is still being evaluated. One `import` in a settings file
 * (091f4f80b) put 42 harness sources, 14 transcript sources and the five sqlite
 * modules into the SettingsView chunk: 652 KB of the chunk's 868 KB of source,
 * and every route under /settings crashed in any built bundle.
 *
 * So this module is the half a bundler may have. It imports NOTHING at runtime —
 * one type import, erased at build — which is the property that makes it safe,
 * and the property `manifest-browser-reach` now holds it to: `packages/harness`
 * is tagged `neutral` and this file is its declared browser entrypoint, so the
 * closure walk in scripts/check-boundaries.ts fails the build if anything here
 * ever grows an import of `node:`, `bun:`, or a node-only workspace.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACT IS DECLARED HERE AND NOT READ OFF THE MANIFESTS
 * ---------------------------------------------------------------------------
 *
 * `harnessSupportsNoTools` used to read `manifestFor(kind)?.headless`, which is
 * why the browser could not have it without the whole registry. Reading a
 * one-bit static fact should not require loading five process-driving adapters,
 * so the predicate is DEFINED here, over a literal table, and `./registry.ts`
 * re-exports it — there is exactly one implementation and no call site changed.
 *
 * The manifests still declare `headless.noTools` themselves: that is where a
 * person adding a harness writes down what their CLI can do, and moving it out
 * of the manifest would scatter the adapter's self-description. Two statements
 * of one fact would ordinarily be a drift hazard, so it is a TESTED identity
 * rather than a convention: `browser.test.ts` asserts, for every
 * `BuiltinHarnessKind`, that this table agrees with what that harness's manifest
 * declares. Flip a manifest without flipping the table and that test fails and
 * names the harness.
 */

import type { AgentKind, BuiltinHarnessKind } from '@podium/model'
import type { HarnessDescriptorWire, ModelChoiceWire } from '@podium/protocol'

/**
 * Which harnesses have a NATIVE all-tools-off mechanism.
 *
 * Exhaustive over {@link BuiltinHarnessKind} by type, so adding a harness is a
 * compile error here until someone states its answer — the same totality
 * contract `AGENT_MANIFESTS` carries, for the same reason: a harness that
 * silently defaults would borrow another CLI's behavior.
 */
export const HARNESS_NO_TOOLS: Record<BuiltinHarnessKind, boolean> = {
  'claude-code': true,
  codex: false,
  cursor: false,
  grok: false,
  opencode: false,
  pi: true,
}

/**
 * True only when the adapter has a native all-tools-off mechanism. Unknown and
 * merely sandboxed harnesses fail closed.
 *
 * FAILING CLOSED IS THE WHOLE POINT, and it is why this takes a `string` rather
 * than a `BuiltinHarnessKind`: callers hold OPEN wire ids (a newer peer may name
 * a harness this build has never heard of) and the honest answer for one of
 * those is "no", not "probably like claude-code". `Record` lookup on an unknown
 * key yields `undefined`, and `=== true` turns that into `false` rather than
 * letting it through as truthy.
 */
export function harnessSupportsNoTools(kind: AgentKind | string): boolean {
  return HARNESS_NO_TOOLS[kind as BuiltinHarnessKind] === true
}

export type {
  HarnessVersion,
  HarnessVersionDiagnostic,
  HarnessVersionPolicy,
  HarnessVersionStatus,
} from './version-policy'
/**
 * The version policy, re-exported BY NAME.
 *
 * An open entrypoint may not `export *`: that re-opens a capability-restricted
 * package in one line, so widening this surface has to be an edit someone makes
 * on purpose. Extensionless, because the boundary checker resolves a browser
 * entrypoint's closure itself and an import it cannot resolve TRUNCATES that
 * closure — which would make the no-Node claim green for the wrong reason.
 */
export {
  CODEX_VERSION_POLICY,
  GROK_ACP_VERSION_POLICY,
  gateHarnessVersion,
  HARNESS_VERSION_POLICIES,
  harnessVersionDiagnostic,
  harnessVersionFloor,
  OPENCODE_VERSION_POLICY,
  parseHarnessVersion,
} from './version-policy'
/**
 * Opaque cursor and stream-item identity (POD-4469: dissolved from
 * `@podium/transcript/browser`). Parsing, paging and tailing remain behind the
 * host-only store entry; these pure cursor helpers are the only transcript
 * machinery a rendered feed needs.
 */
export { decodeCursor, encodeCursor } from './store/cursor-codec'
export { streamIdOfCursor, streamItemIdOf } from './store/stream-identity'

// ---------------------------------------------------------------------------
// Wire descriptors (POD-4475): the DATA half of the harness contract.
// ---------------------------------------------------------------------------
//
// The wire descriptor is serialisable DATA (label, brand, icon, catalog,
// login copy, client capability flags); bundled browser CODE (composer
// extract/injectable/clearSequence/verify) is NOT served and stays here, in
// this entry, for harnesses the client build knows — composer interpretation
// is authoritative on the daemon, which serves the resulting state.
//
// TWO READERS, ONE STATEMENT. The per-harness rows are hand-written ONCE in
// `adapters/<harness>/{descriptor,catalog}.ts` (pure literals + a type-only
// import); the client capability flags are DERIVED from each manifest at
// generation time (`scripts/harness-descriptors.ts`, harness-matrix.ts
// pattern) into `adapters/bundled-descriptors.generated.ts`, which is what
// this entry bundles. The served builder (`descriptors.ts`, host-only) reads
// the same rows and overlays machine availability. An older client renders a
// NEW harness from the served report inside the schema it already has; it
// does not acquire a new interaction model.
//
// The import below names no harness: the generated rows key themselves by
// their own `kind`, so adding a harness is adding two files plus a regen,
// never editing a key set here.

import { GENERATED_BUNDLED_DESCRIPTORS } from './adapters/bundled-descriptors.generated'

/** Wire schema version the bundled rows speak. */
export const BUNDLED_DESCRIPTOR_SCHEMA_VERSION = 1

/**
 * The bundled fallback: every harness THIS BUILD knows, without a machine.
 * Served descriptors overlay these by kind (served wins); kinds only the
 * report names are appended. Clients always render through
 * {@link resolveDescriptors}, never this list directly.
 */
export const BUNDLED_DESCRIPTORS: readonly HarnessDescriptorWire[] =
  GENERATED_BUNDLED_DESCRIPTORS

/** The bundled row for a harness this build knows, or `undefined`. */
export function bundledDescriptorFor(kind: string): HarnessDescriptorWire | undefined {
  return BUNDLED_DESCRIPTORS.find((candidate) => candidate.kind === kind)
}

/** A served-or-bundled descriptor as clients render it. */
export type ResolvedDescriptor = HarnessDescriptorWire

/**
 * The ONE provider fallback rule (POD-4542): the wire field is optional so
 * an older daemon's frame still parses (§5: the schema widens the parser
 * first), and every reader resolves a missing value to the kind — the
 * honest answer for the self-routing harnesses. Stated here, once; the
 * zod parser (`HarnessDescriptorWire`) and the browser parser
 * (`parseServedDescriptors`) below plus the server's `nativePairs` all read
 * through this, so the two parsers can never disagree on the field again.
 */
export function providerOf(descriptor: {
  kind: string
  provider?: string | null | undefined
}): string {
  return descriptor.provider ?? descriptor.kind
}

/**
 * Merge served descriptors over the bundled fallback. Served wins by kind;
 * report-only kinds (a NEWER harness) are appended in report order. Pure and
 * total: an empty report renders the bundled set, and unknown entries never
 * throw — see {@link parseServedDescriptors}.
 */
export function resolveDescriptors(
  served: readonly HarnessDescriptorWire[],
): HarnessDescriptorWire[] {
  const byKind = new Map(BUNDLED_DESCRIPTORS.map((data) => [data.kind, data]))
  for (const descriptor of served) byKind.set(descriptor.kind, descriptor)
  return [...byKind.values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse a served `descriptors` frame field WITHOUT the registry, WITHOUT
 * zod, and without throwing — this is what a client build that has never
 * heard of the harness runs. Unknown fields are ignored; missing optionals
 * fall back (capabilities fail closed to all-false, the catalog to empty,
 * the icon to a blank mark the renderer replaces with an initial); an entry
 * without a usable kind+label is skipped, never guessed. A non-array frame
 * parses to no descriptors.
 *
 * No zod here on purpose: the mobile bundle does not carry it, and the
 * tolerance (ignore extras, default missing, skip invalid) is three lines
 * spelled out rather than a schema option set.
 */
export function parseServedDescriptors(frame: unknown): HarnessDescriptorWire[] {
  if (!Array.isArray(frame)) return []
  const out: HarnessDescriptorWire[] = []
  for (const entry of frame) {
    if (!isRecord(entry)) continue
    const kind = asString(entry.kind)
    const label = asString(entry.label)
    if (!kind || !label) continue
    const icon = isRecord(entry.icon) ? entry.icon : undefined
    const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined
    const catalog = isRecord(entry.catalog) ? entry.catalog : undefined
    const brand = isRecord(entry.brand) ? entry.brand : undefined
    const login = isRecord(entry.login) ? entry.login : undefined
    const defaults = isRecord(entry.defaults) ? entry.defaults : undefined
    const available = isRecord(entry.available) ? entry.available : undefined
    const brandBg = asString(brand?.bg)
    const brandFg = asString(brand?.fg)
    const iconId = asString(icon?.id) ?? kind
    const iconViewBox = asString(icon?.viewBox) ?? ''
    const iconD = asString(icon?.d) ?? ''
    // POD-4529: the Accounts hub reads the provider off the served
    // descriptor. A frame predating the field still renders — see
    // {@link providerOf}, the one fallback rule.
    const provider = providerOf({ kind, provider: asString(entry.provider) })
    const models = Array.isArray(catalog?.models)
      ? catalog.models.flatMap((model) => {
          if (!isRecord(model)) return []
          const value = asString(model.value)
          const modelLabel = asString(model.label)
          if (!value || !modelLabel) return []
          const efforts = Array.isArray(model.efforts)
            ? model.efforts.filter((effort): effort is string => typeof effort === 'string')
            : undefined
          return [{ value, label: modelLabel, ...(efforts ? { efforts } : {}) }]
        })
      : []
    const efforts = Array.isArray(catalog?.efforts)
      ? catalog.efforts.filter((effort): effort is string => typeof effort === 'string')
      : []
    const command = asString(login?.command)
    const installHint = asString(login?.installHint)
    const signedOutHint = asString(login?.signedOutHint)
    const defaultModel = asString(defaults?.model)
    const defaultEffort = asString(defaults?.effort)
    // POD-4541: headed-create panel intent. A plain string on purpose — a
    // newer spelling parses and simply never matches the client's known
    // values, so unknown/missing renders as today (no override).
    const defaultPanelMode = asString(defaults?.panelMode)
    out.push({
      schemaVersion: typeof entry.schemaVersion === 'number' ? entry.schemaVersion : 1,
      kind,
      provider,
      label,
      shortLabel: asString(entry.shortLabel) ?? label,
      icon: { id: iconId, viewBox: iconViewBox, d: iconD },
      ...(brandBg && brandFg ? { brand: { bg: brandBg, fg: brandFg } } : {}),
      capabilities: {
        argvPrompt: capabilities?.argvPrompt === true,
        effort: capabilities?.effort === true,
        systemPrompt: capabilities?.systemPrompt === true,
      },
      catalog: {
        models,
        efforts,
        liveMerge:
          typeof catalog?.liveMerge === 'string' && catalog.liveMerge.length > 0
            ? catalog.liveMerge
            : 'live-wins-when-non-empty',
      },
      ...(command !== undefined || installHint !== undefined || signedOutHint !== undefined
        ? {
            login: {
              ...(command !== undefined ? { command } : {}),
              ...(installHint !== undefined ? { installHint } : {}),
              ...(signedOutHint !== undefined ? { signedOutHint } : {}),
            },
          }
        : {}),
      ...(defaultModel !== undefined || defaultEffort !== undefined || defaultPanelMode !== undefined
        ? {
            defaults: {
              ...(defaultModel !== undefined ? { model: defaultModel } : {}),
              ...(defaultEffort !== undefined ? { effort: defaultEffort } : {}),
              ...(defaultPanelMode !== undefined ? { panelMode: defaultPanelMode } : {}),
            },
          }
        : {}),
      ...(available
        ? {
            available: {
              installed: available.installed === true,
              loggedIn: available.loggedIn === true,
            },
          }
        : {}),
      ...(Array.isArray(entry.sections)
        ? {
            sections: entry.sections.flatMap((section) => {
              if (!isRecord(section)) return []
              const name = asString(section.section)
              if (!name || typeof section.supported !== 'boolean') return []
              return [{ section: name, supported: section.supported }]
            }),
          }
        : {}),
    })
  }
  return out
}

/** Stored sentinel meaning "no override — the agent/harness decides". */
export const DESCRIPTOR_AUTO = 'auto'

export interface DescriptorChoice {
  value: string
  label: string
}

/**
 * The models to offer for a harness: the live list (from the CLI's `models`
 * command, fetched by the server) when non-empty, else the static catalog.
 * The `liveMerge` rule travels as data; the one rule clients implement today
 * is live-wins-when-non-empty, and any spelling they do not know falls back
 * to it rather than to an empty picker.
 */
export function descriptorModels(
  descriptor: HarnessDescriptorWire,
  live?: readonly ModelChoiceWire[],
): readonly ModelChoiceWire[] {
  void descriptor.catalog.liveMerge
  return live && live.length > 0 ? live : descriptor.catalog.models
}

/** Model options with the `auto` default first. */
export function modelOptionsForDescriptor(
  descriptor: HarnessDescriptorWire,
  live?: readonly ModelChoiceWire[],
): DescriptorChoice[] {
  return [{ value: DESCRIPTOR_AUTO, label: 'Auto' }, ...descriptorModels(descriptor, live)]
}

const EFFORT_LEVEL_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

/** Display label for an effort value; unknown rungs render verbatim. */
export function effortLevelLabel(level: string): string {
  return EFFORT_LEVEL_LABELS[level] ?? level
}

/** Effort options for the harness ladder, with the `auto` default first. */
export function effortOptionsForDescriptor(
  descriptor: HarnessDescriptorWire,
  modelValue?: string | null,
  live?: readonly ModelChoiceWire[],
): DescriptorChoice[] {
  const withAuto = (levels: readonly string[]): DescriptorChoice[] => [
    { value: DESCRIPTOR_AUTO, label: 'Auto' },
    ...levels.map((level) => ({ value: level, label: effortLevelLabel(level) })),
  ]
  if (!modelValue || modelValue === DESCRIPTOR_AUTO) {
    return descriptor.capabilities.effort ? withAuto(descriptor.catalog.efforts) : []
  }
  const efforts = descriptorModels(descriptor, live).find((m) => m.value === modelValue)?.efforts
  if (efforts !== undefined) {
    if (efforts.length === 0) return []
    return withAuto(efforts)
  }
  return descriptor.capabilities.effort ? withAuto(descriptor.catalog.efforts) : []
}

/** Display label for a stored model value; falls back to the raw value. */
export function modelLabelForDescriptor(
  descriptor: HarnessDescriptorWire,
  value: string | null | undefined,
  live?: readonly ModelChoiceWire[],
): string {
  if (!value || value === DESCRIPTOR_AUTO) return 'Auto'
  return descriptorModels(descriptor, live).find((m) => m.value === value)?.label ?? value
}

/** Whether an effort value is offered for this harness (ladder or live). */
export function isEffortValidForDescriptor(
  descriptor: HarnessDescriptorWire,
  value: string | null | undefined,
  live?: readonly ModelChoiceWire[],
): boolean {
  if (!value || value === DESCRIPTOR_AUTO) return true
  if (descriptor.catalog.efforts.includes(value)) return true
  return descriptorModels(descriptor, live).some((model) => model.efforts?.includes(value))
}

/** Client operations a descriptor gates. Unknown strings fail closed. */
export type GatedHarnessOperation = 'argv-prompt' | 'effort' | 'system-prompt'

/** A typed refusal: the harness cannot do this operation. */
export interface HarnessOperationRefusal {
  kind: 'harness-operation-unsupported'
  harness: string
  operation: string
}

/**
 * Refuse an operation the descriptor does not implement, or `undefined`
 * when it does. Callers render the refusal (disabled control + reason)
 * instead of misrouting — e.g. a first prompt for a harness without
 * `argvPrompt` travels the durable outbox, never a guessed argv token.
 */
export function refuseUnsupportedOperation(
  descriptor: HarnessDescriptorWire,
  operation: GatedHarnessOperation | (string & {}),
): HarnessOperationRefusal | undefined {
  const supported =
    operation === 'argv-prompt'
      ? descriptor.capabilities.argvPrompt
      : operation === 'effort'
        ? descriptor.capabilities.effort
        : operation === 'system-prompt'
          ? descriptor.capabilities.systemPrompt
          : false
  if (supported) return undefined
  return { kind: 'harness-operation-unsupported', harness: descriptor.kind, operation }
}

// ---------------------------------------------------------------------------
// Bundled composer rules (POD-4477): the CODE half of the harness contract.
// ---------------------------------------------------------------------------
//
// The wire descriptor above is DATA and is SERVED; composer rules are pure
// functions and are BUNDLED — they stay in this entry for the harnesses the
// client build knows, and are never sent over the wire (spec §5 rule 6).
// Composer interpretation is authoritative on the daemon, which serves the
// resulting state; these bundled rules are the client fallback (the web
// fallback's scrape, the terminal client's input-ready heuristic).
//
// The per-harness rule sets live ONCE in `adapters/<harness>/composer.ts`.
// This entry bundles the ones this build knows; the daemon reads the same
// objects through the manifest. A harness this build has never heard of — or
// one whose section is declined — has no rules here: the client falls back
// to "no input-ready heuristic", never to a fetched rule and never to
// another harness's.

import { claudeComposer } from './adapters/claude-code/composer'
import { codexComposer } from './adapters/codex/composer'
import type { HarnessComposer } from './manifest.js'

const BUNDLED_COMPOSER_RULES: Record<string, HarnessComposer> = {
  // 'claude-code' is quoted (a bare identifier cannot carry a dash); codex is
  // a bare key. The vendor-boundary lint counts only quoted literals, and the
  // one quoted key here is covered by the browser.ts policy entry — a second
  // statement of a manifest fact, tested against the manifests below, the
  // same shape as HARNESS_NO_TOOLS above.
  'claude-code': claudeComposer,
  codex: codexComposer,
}

/**
 * The bundled composer rules for a harness this build knows, or `undefined`
 * when it knows none. Fail-closed: an unknown kind (a newer peer may name
 * anything), `shell`, and harnesses whose section is declined all answer
 * `undefined` — the caller runs no heuristic rather than guessing.
 */
export function composerRulesFor(kind: string): HarnessComposer | undefined {
  // A plain-object lookup would answer a rule set for 'toString' via the
  // prototype — the honest answer for inherited properties is undefined.
  if (!Object.hasOwn(BUNDLED_COMPOSER_RULES, kind)) return undefined
  return BUNDLED_COMPOSER_RULES[kind]
}
