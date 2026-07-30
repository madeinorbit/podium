/**
 * FROM "THE USER EDITED THE SETTINGS FORM" TO "THESE COMMANDS, OR THIS REFUSAL"
 * (POD-420, 3.7c).
 *
 * The shipped web client saves settings by sending the WHOLE blob to one
 * mutation. That is the defect POD-352 named: one payload, three matrix rows,
 * one authorization answer — and offline it would queue a credential. This
 * module is the seam that replaces it, and it is a PURE FUNCTION in L1 rather
 * than a branch inside a React component, for three reasons:
 *
 *  1. **The refusal must be by CLASS, not by payload sniffing.** A component
 *     asking "does this save contain an api key?" is a detector, and a detector
 *     that misses one key fails open. This planner asks a different question:
 *     which COMMAND does each changed leaf belong to, and what is that command's
 *     delivery class? A secret is refused offline because
 *     `settings.setSecret` is `online-sensitive`, which is a fact about the
 *     contract, not about the string.
 *  2. **It is testable without a browser.** The refusing arm depends on one
 *     injected boolean (`online`), so a unit test can produce the environmental
 *     fact the refusal needs — which is the question this run keeps asking of
 *     every gate. A refusal that only fires behind a real network partition is a
 *     refusal no suite can prove exists.
 *  3. **Every platform gets the same answer.** The web, the Tauri shell and
 *     `apps/mobile` cannot each re-derive "may this be queued" from a blob
 *     shape without three chances to get it wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DIFF IS OVER PATHS AND NOT OVER THE BLOB SHAPE
 * ---------------------------------------------------------------------------
 *
 * {@link changedSettingsLeaves} walks BOTH objects and stops at a classified
 * path, so `experimental` (an open record of feature ids) is one leaf and
 * `roles.coding.model` is another. A leaf that changed and is classified by
 * nothing is reported as an UNCLASSIFIED CHANGE — a refusal — rather than being
 * dropped. That direction matters: dropping it would mean a settings key added
 * to the blob and to no tier silently stops being writable while the save
 * button still says "Saved", which is the failure mode where a green UI and a
 * lost write look identical.
 */

import { classifySettingsPath, type SettingsTier } from '@podium/model'
import type { DeliveryClass } from '../contract'
import { SETTINGS_CONTRACTS, type SettingsContractName, TIER_COMMAND } from './contracts'

// ---------------------------------------------------------------------------
// Leaf diffing
// ---------------------------------------------------------------------------

/** A plain JSON object, which is all a settings blob is on the wire. */
type Blob = Record<string, unknown>

const isPlainObject = (v: unknown): v is Blob =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep structural equality, by canonical JSON. Sufficient and honest here: a
 *  settings leaf is JSON by construction (it round-trips through the wire on
 *  every load), so there is no `undefined`, no `Date` and no cycle to mishandle
 *  — and using `JSON.stringify` on a NON-canonical object would be a bug, which
 *  is why the two sides are stringified through the same key-sorting replacer. */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  if (!isPlainObject(value)) return JSON.stringify(value) ?? 'undefined'
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// Reading and writing one leaf, by dotted path
// ---------------------------------------------------------------------------

/**
 * The value at a dotted path, or `undefined` when the path is not present.
 *
 * Pure and shape-agnostic on purpose: the HANDLER applying a path-addressed
 * patch and the GUARD comparing a blob's secret leaves against the stored ones
 * must ask the same question the same way. Two readers of one address is how the
 * guard and the write end up disagreeing about which leaf they mean.
 */
export function readSettingsLeaf(blob: unknown, path: string): unknown {
  let cursor: unknown = blob
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/**
 * A COPY of `blob` with each dotted path set to its patch value.
 *
 * Structurally shared where untouched and copied along each written path — the
 * standard immutable update — so a caller holding the previous object still sees
 * the previous values. Intermediate objects are created when missing, which is
 * what makes a leaf writable on a blob saved by an older build that did not have
 * it.
 *
 * It applies what it is given and classifies NOTHING: the tier gate is the
 * command's input schema, which refuses an unclassified or cross-tier path
 * before a handler runs. Re-deciding it here would be a second answer to the
 * authorization question, and the two would drift.
 */
export function applySettingsPatch<T>(blob: T, values: Readonly<Record<string, unknown>>): T {
  let out = blob as unknown
  for (const [path, value] of Object.entries(values)) out = writeLeaf(out, path.split('.'), value)
  return out as T
}

function writeLeaf(node: unknown, segments: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segments
  if (head === undefined) return value
  const base: Blob = isPlainObject(node) ? { ...node } : {}
  base[head] = rest.length === 0 ? value : writeLeaf(base[head], rest, value)
  return base
}

/** One leaf that differs between two settings objects. */
export interface ChangedLeaf {
  readonly path: string
  readonly value: unknown
  /** `undefined` when nothing classifies this path — a refusal, never a default. */
  readonly tier: SettingsTier | undefined
}

/**
 * Every leaf whose value differs between `previous` and `next`.
 *
 * The walk STOPS at a classified path, which is what makes an open record
 * (`experimental`) one leaf rather than a family of unclassified ones. Below an
 * unclassified object it keeps descending, so an unclassified leaf is reported
 * at its own address and not swallowed by its parent.
 */
export function changedSettingsLeaves(previous: unknown, next: unknown): ChangedLeaf[] {
  const out: ChangedLeaf[] = []
  const walk = (a: unknown, b: unknown, prefix: string): void => {
    if (prefix) {
      const classification = classifySettingsPath(prefix)
      if (classification) {
        if (!sameValue(a, b)) out.push({ path: prefix, value: b, tier: classification.tier })
        return
      }
    }
    if (isPlainObject(a) || isPlainObject(b)) {
      const left = isPlainObject(a) ? a : {}
      const right = isPlainObject(b) ? b : {}
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], prefix ? `${prefix}.${key}` : key)
      }
      return
    }
    // A scalar at an unclassified address. Reported rather than ignored.
    if (prefix && !sameValue(a, b)) out.push({ path: prefix, value: b, tier: undefined })
  }
  walk(previous, next, '')
  return out
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One command the save must issue. Preference writes carry a path-addressed
 *  patch; a secret write carries a key and, for a replace, its material. */
export type SettingsWriteIntent =
  | {
      readonly kind: 'preference'
      readonly command: SettingsContractName
      readonly delivery: DeliveryClass
      readonly values: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'secret'
      readonly command: SettingsContractName
      readonly delivery: DeliveryClass
      readonly key: string
      /** Absent for `settings.clearSecret` — see {@link planSettingsWrite}. */
      readonly value?: string
    }

/** Why a change could not be issued. Every refusal names the PATH, so the UI can
 *  say which field it is talking about — a refusal a user cannot act on is a
 *  failure surfaced as a shrug. */
export interface SettingsWriteRefusal {
  readonly path: string
  readonly reason: 'unclassified' | 'requires-connection'
  readonly message: string
}

export interface SettingsWritePlan {
  readonly intents: readonly SettingsWriteIntent[]
  readonly refusals: readonly SettingsWriteRefusal[]
}

export interface PlanOptions {
  /** Whether the client currently has a connection. Injected rather than read
   *  from `navigator`, so the REFUSING arm is reachable in a unit test. */
  readonly online: boolean
}

/**
 * Turn an edited settings object into the commands that write it.
 *
 * SECRETS ARE ONE COMMAND EACH, deliberately: they are keyed rows on a matrix
 * row whose conflict rule is `cmd` ("online replace only"), so batching two
 * rotations into one call would make a partial failure unrepresentable. A leaf
 * that changed to the empty string becomes `settings.clearSecret`, because the
 * model refuses to let absence and emptiness be spelled the same way — today's
 * blob uses `''` for "not configured", and this is the boundary where that
 * legacy spelling is translated into the honest pair.
 *
 * OFFLINE, an `online-sensitive` intent is REFUSED rather than queued or
 * silently dropped. The refusal is derived from the contract's delivery class
 * and nothing else: no key names, no payload inspection, no allowlist.
 */
export function planSettingsWrite(
  previous: unknown,
  next: unknown,
  options: PlanOptions,
): SettingsWritePlan {
  const intents: SettingsWriteIntent[] = []
  const refusals: SettingsWriteRefusal[] = []
  const patches = new Map<SettingsContractName, Record<string, unknown>>()

  for (const leaf of changedSettingsLeaves(previous, next)) {
    if (!leaf.tier) {
      refusals.push({
        path: leaf.path,
        reason: 'unclassified',
        message: `'${leaf.path}' belongs to no settings tier, so no command may write it`,
      })
      continue
    }
    if (leaf.tier === 'server-secret') {
      const value = typeof leaf.value === 'string' ? leaf.value : ''
      const command: SettingsContractName =
        value.length > 0 ? 'settings.setSecret' : 'settings.clearSecret'
      const delivery = SETTINGS_CONTRACTS[command].delivery.class
      if (!options.online && delivery !== 'offline-eligible') {
        refusals.push({
          path: leaf.path,
          reason: 'requires-connection',
          message: `'${leaf.path}' is a server-owned secret: ${command} is ${delivery} and is never queued (ADR 1 D6)`,
        })
        continue
      }
      intents.push(
        value.length > 0
          ? { kind: 'secret', command, delivery, key: leaf.path, value }
          : { kind: 'secret', command, delivery, key: leaf.path },
      )
      continue
    }
    const command = TIER_COMMAND[leaf.tier]
    const delivery = SETTINGS_CONTRACTS[command].delivery.class
    if (!options.online && delivery !== 'offline-eligible') {
      refusals.push({
        path: leaf.path,
        reason: 'requires-connection',
        message: `'${leaf.path}' is written by ${command}, which is ${delivery} and is never queued`,
      })
      continue
    }
    const patch = patches.get(command) ?? {}
    patch[leaf.path] = leaf.value
    patches.set(command, patch)
  }

  // Preference patches AFTER the loop so each command is issued once with every
  // path it owns — the shape its input schema takes, and the shape that makes a
  // save one write per tier rather than one per field.
  for (const [command, values] of patches) {
    intents.push({
      kind: 'preference',
      command,
      delivery: SETTINGS_CONTRACTS[command].delivery.class,
      values,
    })
  }

  return { intents, refusals }
}

/**
 * The commands in this family that may NEVER be issued without a connection,
 * derived from the table.
 *
 * Exported for the UI, which needs to explain the refusal before the user
 * spends effort on a field that cannot be saved, and for the audit gate, which
 * asserts the set is non-empty — an empty set would make every "secrets are
 * never queued" assertion vacuously true.
 */
export const ONLINE_ONLY_SETTINGS_COMMANDS: readonly SettingsContractName[] = (
  Object.keys(SETTINGS_CONTRACTS) as SettingsContractName[]
).filter((name) => SETTINGS_CONTRACTS[name].delivery.class !== 'offline-eligible')
