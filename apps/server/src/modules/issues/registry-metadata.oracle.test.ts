/**
 * THE ZERO-BEHAVIOUR-CHANGE ORACLE FOR POD-311.
 *
 * POD-311 moved the contract half of the issue registry into `@podium/commands`.
 * The acceptance criterion is not "it compiles" and not "the tests still pass" — it
 * is that every one of the sixty-eight commands still DECLARES what it declared
 * before, because the issue tracker is what the whole POD-279 fan-out is using while
 * the migration lands.
 *
 * ## Why this reads a committed fixture and never regenerates one
 *
 * A snapshot written by the code path it is meant to check is green by construction.
 * The ledger records that failure — "snapshot regeneration launders mutation" — so
 * `__fixtures__/registry-metadata.pre-pod311.json` was captured from the RUNNING
 * registry at `issue/279-integration` and committed in its OWN commit, BEFORE any
 * migration commit. The ordering is a fact in git history rather than a claim in a
 * comment, and a regeneration is a diff to a tracked file. Nothing in this suite
 * writes it.
 *
 * ## Why it asserts cells and not counts
 *
 * Sixty-eight commands in nine distinct metadata cells stays true if two commands
 * swap cells. So every command is compared field by field, and the failure message
 * names the command and the field.
 *
 * ## The two fields that moved, and how they are still compared
 *
 * `scope` and `cli` no longer sit on the handler record — they are `policy.resource`
 * and `cli` on the L1 contract. The oracle reads them THROUGH the contract and maps
 * them back to the old shape, so the comparison is against the pre-migration
 * declaration rather than against a redefinition of what the declaration means. The
 * mapping is one line and it is stated here, not hidden: the shipped `scope` was
 * `'issue'` exactly where the contract now says `policy.resource === 'issue'`.
 */

import { ISSUE_CONTRACTS, type IssueContractName } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import before from './__fixtures__/registry-metadata.pre-pod311.json' with { type: 'json' }
import { issueRegistry } from './registry'

/** The exact probe the fixture was captured with. Changing it invalidates the
 *  comparison, so it is a literal here and in the fixture's provenance note. */
const PROBE: Record<string, unknown> = {
  id: 'ID',
  ids: 'IDS',
  fromId: 'F',
  toId: 'T',
  oldId: 'O',
  newId: 'N',
  canonicalId: 'C',
  issueId: 'I',
  repoPath: '/r',
  ref: 'R',
  parentId: 'P',
}

interface Cell {
  kind: string
  action: string
  scope: string | null
  cli: unknown
  hasTarget: boolean
  targetOfProbe: string | null
  inputType: string
  inputKeys: string[] | string
}

/** Re-measure one command's cell from the LIVE objects, exactly as the fixture was
 *  measured — off the running registry and the running contract, never off source
 *  text, because source text is what a migration changes on purpose. */
function measure(name: string): Cell {
  // biome-ignore lint/suspicious/noExplicitAny: reading a heterogeneous table's runtime shape is the point
  const def = (issueRegistry.defs as Record<string, any>)[name]
  const contract = ISSUE_CONTRACTS[name as IssueContractName]
  // biome-ignore lint/suspicious/noExplicitAny: zod internals are the only way to read a schema's key set
  const schema = def.input as any
  let inputKeys: string[] | string
  try {
    const shape = schema?._def?.shape?.() ?? schema?._def?.innerType?._def?.shape?.()
    inputKeys = shape ? Object.keys(shape).sort() : `<${schema?._def?.typeName}>`
  } catch {
    inputKeys = '<err>'
  }
  return {
    kind: def.kind,
    action: def.action,
    // The moved field, mapped back to its pre-migration meaning (see the header).
    scope: contract.policy.resource === 'issue' ? 'issue' : null,
    // `cli` presentation hints: NOT ONE of the sixty-eight declared any, before the
    // split or after it — the `podium issue` verbs, positionals and summaries live in
    // `@podium/issue-client`'s table, which is the rendering layer. So this cell is
    // `null` on both sides, and comparing it is a check that nobody QUIETLY starts
    // declaring hints in a second place. `CommandContractBase.cli` is optional, so
    // the union of sixty-eight literals that all omit it has no such property; the
    // widened read is what lets the comparison exist at all.
    cli: (contract as { cli?: unknown }).cli ?? null,
    hasTarget: typeof def.target === 'function',
    targetOfProbe: def.target ? (def.target(PROBE) ?? null) : null,
    inputType: schema?._def?.typeName,
    inputKeys,
  }
}

const RECORDED = before.defs as unknown as Record<string, Cell>
const RECORDED_NAMES = Object.keys(RECORDED).sort()

/**
 * THE ONE SANCTIONED DRIFT, AND THE RECORDING IS NOT REGENERATED TO ABSORB IT.
 *
 * The catch-up merge with main (POD-1246) brought POD-793's stale-write check,
 * which adds an `expectedRevision` key to the input of every issue MUTATION —
 * these twenty-three and no others. Re-capturing the fixture would have made the
 * suite green in one step and thrown away the thing it exists to hold: a
 * recording of the registry BEFORE the POD-311 split. An oracle you re-record
 * whenever it disagrees with you is a diary, not an oracle.
 *
 * So the recording stays as captured and the expectation is derived from it. The
 * list is written out rather than computed from `def.action` because the property
 * is "exactly these commands gained exactly this key": a twenty-fourth command
 * growing an `expectedRevision`, or any of these growing a SECOND key, still
 * fails. And because the key is only ever ADDED here, a mutation that LOSES it —
 * silently disarming conflict detection for that command — fails too.
 */
const GAINED_EXPECTED_REVISION = new Set([
  'answerQuestion',
  'applySuggestion',
  'archive',
  'claim',
  'clearNeedsHuman',
  'close',
  'defer',
  'delete',
  'depAdd',
  'depRemove',
  'dismissSuggestion',
  'duplicate',
  'panelApply',
  'promote',
  'reparent',
  'restore',
  'setCoordinator',
  'setLabels',
  'setNeedsHuman',
  'setState',
  'supersede',
  'undefer',
  'update',
])

/**
 * THE SECOND SANCTIONED DRIFT, recorded the same way and for the same reason.
 *
 * The same catch-up merge brought two main-side features that widen exactly two
 * READ/WRITE inputs and no others:
 *
 *   - POD-1545 let `start` choose the model and effort in the command that starts
 *     the issue, so `start` gained `defaultModel` + `defaultEffort`;
 *   - POD-1342 made the tree's depth/node caps callable over the wire (the CLI's
 *     truncation footer tells the reader to raise them), so `tree` gained
 *     `maxDepth` + `maxNodes`.
 *
 * Spelled out per command rather than derived, on the same principle as
 * {@link GAINED_EXPECTED_REVISION}: the property is "exactly these commands gained
 * exactly these keys", so a third command growing them, or either of these growing
 * a further key — or silently LOSING one — still fails.
 */
const GAINED_KEYS: Record<string, string[]> = {
  start: ['defaultEffort', 'defaultModel'],
  tree: ['maxDepth', 'maxNodes'],
}

/** The recorded key set, plus the keys the catch-up merge added to it. */
function expectedInputKeys(name: string, was: Cell): string[] | string {
  if (!Array.isArray(was.inputKeys)) return was.inputKeys
  const added = [
    ...(GAINED_EXPECTED_REVISION.has(name) ? ['expectedRevision'] : []),
    ...(GAINED_KEYS[name] ?? []),
  ]
  return added.length === 0 ? was.inputKeys : [...was.inputKeys, ...added].sort()
}

describe('issue registry metadata is unchanged by the POD-311 split', () => {
  /**
   * NON-VACUITY, ASSERTED BEFORE ANYTHING IS COMPARED. Every loop below iterates the
   * fixture's key set; an empty or renamed fixture would turn all of them green and
   * mean nothing. `an empty router satisfies every absence claim perfectly` — the
   * same shape, one layer up.
   */
  it('the fixture is populated, and describes the registry that exists now', () => {
    expect(before.namespace).toBe('issues')
    expect(before.count).toBe(68)
    expect(RECORDED_NAMES).toHaveLength(68)
    expect(issueRegistry.namespace).toBe(before.namespace)
    expect(Object.keys(issueRegistry.defs).sort()).toEqual(
      [...RECORDED_NAMES, 'share', 'unshare'].sort(),
    )
  })

  it('every command declares the same cell it declared before the migration', () => {
    for (const name of RECORDED_NAMES) {
      const was = RECORDED[name] as Cell
      const now = measure(name)
      // Field by field, so a failure names the field rather than printing two
      // objects and leaving the reader to diff them.
      expect(now.kind, `${name}.kind`).toBe(was.kind)
      expect(now.action, `${name}.action`).toBe(was.action)
      expect(now.scope, `${name}.scope`).toBe(was.scope)
      expect(now.cli, `${name}.cli`).toEqual(was.cli)
      // …and both sides are really null, so the line above is not two undefineds
      // agreeing (see `measure`).
      expect(was.cli, `${name}.cli was recorded`).toBeNull()
      expect(now.hasTarget, `${name}.hasTarget`).toBe(was.hasTarget)
      expect(now.targetOfProbe, `${name}.target(probe)`).toBe(was.targetOfProbe)
      expect(now.inputType, `${name}.inputType`).toBe(was.inputType)
      expect(now.inputKeys, `${name}.inputKeys`).toEqual(expectedInputKeys(name, was))
    }
  })

  /**
   * THE INSTRUMENT MUST BE OBSERVED SAYING NO.
   *
   * An oracle that has only ever been seen passing is not an oracle. Each planted
   * perturbation is one that a careless migration could actually produce — a command
   * dropped, a scope widened, an action weakened, a schema key lost, an extractor
   * repointed at a different input field — and each must fail the SAME comparison the
   * suite above applies, run here as a pure function so the product is never mutated
   * (an interrupted mutation script strands the product broken).
   */
  describe('the comparison can fail', () => {
    const compare = (was: Cell, now: Cell, name?: string): string[] => {
      const bad: string[] = []
      if (now.kind !== was.kind) bad.push('kind')
      if (now.action !== was.action) bad.push('action')
      if (now.scope !== was.scope) bad.push('scope')
      if (now.hasTarget !== was.hasTarget) bad.push('hasTarget')
      if (now.targetOfProbe !== was.targetOfProbe) bad.push('targetOfProbe')
      if (now.inputType !== was.inputType) bad.push('inputType')
      const wantKeys = name ? expectedInputKeys(name, was) : was.inputKeys
      if (JSON.stringify(now.inputKeys) !== JSON.stringify(wantKeys)) bad.push('inputKeys')
      return bad
    }

    it('reports nothing when a live cell is compared with its own recording', () => {
      // The YES the ledger insists on seeing first: the predicate is capable of
      // agreeing, on real data, for every command.
      for (const name of RECORDED_NAMES) {
        expect(compare(RECORDED[name] as Cell, measure(name), name), name).toEqual([])
      }
    })

    /**
     * Each case names the command it perturbs, because a perturbation that happens
     * to restate the value already there is A MUTANT THAT NEVER APPLIED — it reads
     * as a survivor and proves nothing. `close` is a subtree-scoped write with an
     * `id` extractor and a three-key input; `list` is an unscoped read with no
     * extractor. Every patch below is asserted to actually differ before it is used.
     */
    it.each([
      ['a scope widened onto an unscoped read', 'list', { scope: 'issue' }, 'scope'],
      ['a scope silently dropped from a write', 'close', { scope: null }, 'scope'],
      ['a weakened action', 'close', { action: 'read' }, 'action'],
      ['a dropped target extractor', 'close', { hasTarget: false }, 'hasTarget'],
      ['an extractor repointed at another field', 'close', { targetOfProbe: 'F' }, 'targetOfProbe'],
      ['a changed procedure type', 'close', { kind: 'query' }, 'kind'],
      ['a lost schema key', 'close', { inputKeys: ['id'] }, 'inputKeys'],
    ])('catches %s', (_label, command, patch, expectedField) => {
      const was = RECORDED[command] as Cell
      const live = measure(command)
      const mutated = { ...live, ...patch } as Cell
      // THE MUTANT APPLIED: the patched field really differs from the recording.
      expect(
        JSON.stringify(mutated[expectedField as keyof Cell]),
        `${command}.${expectedField}: mutant did not apply`,
      ).not.toBe(JSON.stringify(was[expectedField as keyof Cell]))
      expect(compare(was, mutated, command)).toContain(expectedField)
    })

    /**
     * The sanctioned drift is still a comparison, not a hole punched in one.
     *
     * `GAINED_EXPECTED_REVISION` widens what the oracle accepts, so it has to be
     * shown REFUSING on the same axis — otherwise "the key is only ever added, so
     * losing it still fails" is a claim in a comment. Dropping `expectedRevision`
     * from a mutation is precisely how conflict detection would be disarmed for
     * that command without any other cell moving.
     */
    it('catches the stale-write key dropped from a mutation', () => {
      const live = measure('close')
      const without = (live.inputKeys as string[]).filter((k) => k !== 'expectedRevision')
      // THE MUTANT APPLIED: the key really was there to lose.
      expect(without, 'close: expectedRevision was not present to drop').not.toEqual(live.inputKeys)
      const mutated = { ...live, inputKeys: without } as Cell
      expect(compare(RECORDED.close as Cell, mutated, 'close')).toContain('inputKeys')
    })

    it('catches a command disappearing from the table', () => {
      const live = new Set(Object.keys(issueRegistry.defs))
      live.delete('close')
      expect([...live].sort()).not.toEqual(RECORDED_NAMES)
    })
  })
})
