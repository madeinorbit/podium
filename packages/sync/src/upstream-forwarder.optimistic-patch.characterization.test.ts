import { ISSUE_COMMAND_NAMES, type IssueCommandName } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { optimisticIssuePatch } from './upstream-forwarder'

/**
 * CHARACTERIZATION of `optimisticIssuePatch` — the node-side optimistic-patch
 * switch (POD-367, brief §SEQUENCING).
 *
 * This file changes NOTHING about the switch. Its only job is to pin the switch's
 * CURRENT behavior, exactly, so that its deletion is verified against recorded
 * behavior rather than against a reading of the code:
 *
 *  - POD-311 replaces the switch with command-specific optimistic reducers. The
 *    per-arm assertions below are the contract each reducer either reproduces or
 *    deliberately changes — and `classification` below is the COMPLETE list of
 *    commands a reducer set must cover, including the ones that produce no
 *    optimistic effect today.
 *  - POD-309 retires the forwarder itself, at which point this file goes with it.
 *
 * DELIBERATELY EXACT. `toStrictEqual` is used throughout, not `toMatchObject`:
 * the consumer (`apps/server/src/modules/issues/upstream.ts`,
 * `applyUpstreamOptimisticPatch`) accumulates patches with `{ ...prior, ...patch }`,
 * so a key's PRESENCE — even carrying `undefined` — overwrites the prior overlay
 * value. A loose matcher cannot tell "the arm does not touch this field" from
 * "the arm clears this field", and those are different behaviors under
 * accumulation. The existing `toMatchObject` coverage in `upstream-forwarder.test.ts`
 * stays as the readable summary; this file is the pinned one.
 *
 * Behaviors pinned here that are ASYMMETRIC (the setting direction is mirrored,
 * the clearing direction is not) are called out at their assertion. They are
 * recorded as findings, not fixed here — this issue does not edit the switch.
 */

const NOW = '2026-07-30T12:00:00.000Z'

// The eight `case` labels of the switch, as of this commit. Everything else in
// ISSUE_COMMAND_NAMES reaches `default` and yields a marker-only patch.
const NAMED_ARMS = [
  'archive',
  'claim',
  'clearNeedsHuman',
  'close',
  'defer',
  'reparent',
  'setLabels',
  'setNeedsHuman',
  'update',
] as const satisfies readonly IssueCommandName[]

/**
 * A probe input carrying EVERY key any arm of the switch reads, so that an arm
 * which yields a marker-only patch under this input yields one under any input:
 * the classification below is a statement about the switch, not about a
 * particular payload.
 */
const EVERY_READ_KEY = {
  id: 'iss_a',
  patch: { title: 'T' },
  reason: 'r',
  assignee: 'a',
  labels: ['l'],
  until: '2027-01-01',
  question: 'q?',
  options: ['o'],
  askedBy: 'ses_1',
  parentId: 'iss_p',
}

describe('optimisticIssuePatch — classification of the whole command surface', () => {
  /**
   * A GUARD ON THIS SUITE'S OWN COVERAGE, not on the switch.
   *
   * POD-365's finding: a parameterised suite whose parameter list IS the thing under
   * test cannot notice its own coverage shrinking. Four tests in this file iterate
   * `ISSUE_COMMAND_NAMES`, and the classification test below derives its expected
   * marker count FROM that same list — so a command deleted from the list would
   * leave every one of them green while silently covering one case fewer. An
   * evaporated question, not a wrong answer.
   *
   * The length is a LITERAL on purpose: derived from the list it would be a
   * tautology. Update it deliberately when a command is genuinely added or removed.
   */
  it('the canonical command list has not shrunk beneath this suite', () => {
    expect(ISSUE_COMMAND_NAMES).toHaveLength(68)
    // And every named arm is still a MEMBER, so renaming one in the canonical list
    // is caught here rather than silently reclassifying that arm as unknown.
    for (const arm of NAMED_ARMS) expect(ISSUE_COMMAND_NAMES).toContain(arm)
  })

  /**
   * The switch's coverage measured against the CANONICAL command list, not
   * against itself. This is the list POD-311's reducers must account for: nine
   * commands have a representable optimistic effect today and the rest do not,
   * which for the read-only ones is correct and for the mutating ones below is a
   * gap rather than a decision.
   */
  it('nine commands have a named arm; every other command name is marker-only', () => {
    const named: string[] = []
    const marker: string[] = []
    for (const name of ISSUE_COMMAND_NAMES) {
      const patch = optimisticIssuePatch(name, EVERY_READ_KEY, NOW)
      // A marker-only patch is exactly `{ updatedAt }`, even when the input
      // carries every field the switch knows how to read.
      const isMarker = Object.keys(patch).length === 1 && patch.updatedAt === NOW
      ;(isMarker ? marker : named).push(name)
    }
    expect(named.sort()).toStrictEqual([...NAMED_ARMS].sort())
    // Counted, not spelled out: the interesting members are asserted below.
    expect(marker).toHaveLength(ISSUE_COMMAND_NAMES.length - NAMED_ARMS.length)
  })

  /**
   * MUTATING commands with no optimistic effect. Each of these changes a field
   * the node-side replica already carries, so the value could be mirrored — it
   * simply is not. Recorded because "marker-only" is the right answer for
   * `start`/`addSession`/`depAdd` (whose effect is not locally representable)
   * and is a GAP for these, and POD-311 needs the two cases separated.
   */
  it('field-level mutating commands that produce no optimistic value change', () => {
    for (const proc of [
      'undefer', // the clearing counterpart of `defer` — a separate command, not `defer` without `until`
      'setTucked',
      'markRead',
      'markUnread',
      'setState',
      'setCoordinator',
      'promote',
      'supersede',
      'duplicate',
      'restore',
      'delete',
      'stop',
      'answerQuestion',
      'panelApply',
    ] satisfies IssueCommandName[]) {
      expect(optimisticIssuePatch(proc, { ...EVERY_READ_KEY, value: true }, NOW)).toStrictEqual({
        updatedAt: NOW,
      })
    }
  })

  it('an unknown proc name is marker-only, not a throw', () => {
    expect(optimisticIssuePatch('notACommand', { id: 'i' }, NOW)).toStrictEqual({ updatedAt: NOW })
  })
})

describe('optimisticIssuePatch — `update`', () => {
  it('passes the caller-supplied patch through UNFILTERED and stamps updatedAt', () => {
    // Pinned deliberately: the arm does not validate the patch against IssueWire,
    // so an unknown key reaches the node-side overlay verbatim. A reducer that
    // parses its input (POD-311's stated direction) changes this.
    expect(
      optimisticIssuePatch(
        'update',
        { id: 'i', patch: { title: 'T', priority: 1, notAField: 'x' } },
        NOW,
      ),
    ).toStrictEqual({ title: 'T', priority: 1, notAField: 'x', updatedAt: NOW })
  })

  it('a missing patch yields marker-only', () => {
    expect(optimisticIssuePatch('update', { id: 'i' }, NOW)).toStrictEqual({ updatedAt: NOW })
  })

  it('rewrites color:null to color:undefined, and KEEPS the key present', () => {
    const patch = optimisticIssuePatch('update', { id: 'i', patch: { color: null } }, NOW)
    // `toStrictEqual` distinguishes an undefined-valued key from an absent one;
    // the key must stay present, because that is what clears a prior overlay
    // colour when the consumer spreads `{ ...prior, ...patch }`.
    expect(patch).toStrictEqual({ color: undefined, updatedAt: NOW })
    expect(Object.keys(patch).sort()).toStrictEqual(['color', 'updatedAt'])
  })

  it('does not mutate the caller\'s patch object when rewriting color', () => {
    const input = { id: 'i', patch: { color: null as string | null } }
    optimisticIssuePatch('update', input, NOW)
    expect(input.patch.color).toBeNull()
  })
})

describe('optimisticIssuePatch — the lifecycle arms', () => {
  it('close sets stage=done, and carries a reason only when it is a string', () => {
    expect(optimisticIssuePatch('close', { id: 'i', reason: 'done!' }, NOW)).toStrictEqual({
      stage: 'done',
      closedReason: 'done!',
      updatedAt: NOW,
    })
    expect(optimisticIssuePatch('close', { id: 'i' }, NOW)).toStrictEqual({
      stage: 'done',
      updatedAt: NOW,
    })
    expect(optimisticIssuePatch('close', { id: 'i', reason: 42 }, NOW)).toStrictEqual({
      stage: 'done',
      updatedAt: NOW,
    })
    // `closedAt` is NOT mirrored — the overlay shows a closed issue with no close
    // time until hub truth arrives.
  })

  it('archive sets archived=true; there is no un-archive arm', () => {
    expect(optimisticIssuePatch('archive', { id: 'i' }, NOW)).toStrictEqual({
      archived: true,
      updatedAt: NOW,
    })
    // `restore` reaches the default arm (asserted above): un-archiving shows no
    // optimistic effect. ASYMMETRIC.
  })

  it('defer mirrors deferUntil when present, and flips `deferred` from its presence', () => {
    expect(optimisticIssuePatch('defer', { id: 'i', until: '2027-01-01' }, NOW)).toStrictEqual({
      deferUntil: '2027-01-01',
      deferred: true,
      updatedAt: NOW,
    })
    // No `until` ⇒ `deferred: false` is written but `deferUntil` is left ALONE:
    // a prior overlay's deferUntil survives alongside deferred:false. ASYMMETRIC.
    expect(optimisticIssuePatch('defer', { id: 'i' }, NOW)).toStrictEqual({
      deferred: false,
      updatedAt: NOW,
    })
  })
})

describe('optimisticIssuePatch — the assignment arms', () => {
  it('claim mirrors a string assignee and does NOT clear on omission', () => {
    expect(optimisticIssuePatch('claim', { id: 'i', assignee: 'me' }, NOW)).toStrictEqual({
      assignee: 'me',
      updatedAt: NOW,
    })
    // Un-claiming (no assignee) is marker-only: the overlay keeps showing the
    // previous assignee until hub truth. ASYMMETRIC.
    expect(optimisticIssuePatch('claim', { id: 'i' }, NOW)).toStrictEqual({ updatedAt: NOW })
  })

  it('setLabels mirrors an array and does NOT clear on a non-array', () => {
    expect(optimisticIssuePatch('setLabels', { id: 'i', labels: ['a', 'b'] }, NOW)).toStrictEqual({
      labels: ['a', 'b'],
      updatedAt: NOW,
    })
    // An empty array IS an array — clearing labels explicitly does mirror.
    expect(optimisticIssuePatch('setLabels', { id: 'i', labels: [] }, NOW)).toStrictEqual({
      labels: [],
      updatedAt: NOW,
    })
    expect(optimisticIssuePatch('setLabels', { id: 'i' }, NOW)).toStrictEqual({ updatedAt: NOW })
  })

  it('setLabels does not check element types', () => {
    expect(optimisticIssuePatch('setLabels', { id: 'i', labels: [1, null] }, NOW)).toStrictEqual({
      labels: [1, null],
      updatedAt: NOW,
    })
  })

  it('reparent mirrors a parentId and does NOT clear it on omission', () => {
    expect(optimisticIssuePatch('reparent', { id: 'i', parentId: 'iss_p' }, NOW)).toStrictEqual({
      parentId: 'iss_p',
      updatedAt: NOW,
    })
    // Re-parenting to top level (no parentId) is marker-only. ASYMMETRIC.
    expect(optimisticIssuePatch('reparent', { id: 'i' }, NOW)).toStrictEqual({ updatedAt: NOW })
  })

  it('the branded id casts are compile-time only — the value is byte-identical', () => {
    const patch = optimisticIssuePatch('reparent', { id: 'i', parentId: 'iss_p' }, NOW)
    expect(patch.parentId).toBe('iss_p')
  })
})

describe('optimisticIssuePatch — the needs-human arm', () => {
  it('mirrors the full question tuple, stamping askedAt locally', () => {
    expect(
      optimisticIssuePatch(
        'setNeedsHuman',
        { id: 'i', question: 'q?', options: ['a', 'b'], askedBy: 'ses_1' },
        NOW,
      ),
    ).toStrictEqual({
      needsHuman: true,
      humanQuestion: 'q?',
      humanQuestionOptions: ['a', 'b'],
      humanQuestionAskedBy: 'ses_1',
      humanQuestionAskedAt: NOW,
      updatedAt: NOW,
    })
  })

  it('stamps humanQuestionAskedAt even when askedBy is absent, splitting the pair', () => {
    // PINNED AS A FINDING, not endorsed. `humanQuestionAskedBy` is
    // server-authoritative precisely so "did a person or an agent ask this?"
    // stays answerable (ADR 9 D5 A3); the local overlay can produce an
    // askedAt with no askedBy, which answers the timestamp without answering
    // the attribution. Whatever replaces this arm must not widen that.
    expect(optimisticIssuePatch('setNeedsHuman', { id: 'i' }, NOW)).toStrictEqual({
      needsHuman: true,
      humanQuestionAskedAt: NOW,
      updatedAt: NOW,
    })
  })

  it('drops askedBy when it is not a string', () => {
    expect(
      optimisticIssuePatch('setNeedsHuman', { id: 'i', askedBy: 7 }, NOW),
    ).toStrictEqual({ needsHuman: true, humanQuestionAskedAt: NOW, updatedAt: NOW })
  })

  it('drops the options array whole when ANY element is not a string', () => {
    expect(
      optimisticIssuePatch('setNeedsHuman', { id: 'i', options: ['a', 3] }, NOW),
    ).toStrictEqual({ needsHuman: true, humanQuestionAskedAt: NOW, updatedAt: NOW })
    // An empty array passes the every() guard and IS mirrored.
    expect(
      optimisticIssuePatch('setNeedsHuman', { id: 'i', options: [] }, NOW),
    ).toStrictEqual({
      needsHuman: true,
      humanQuestionOptions: [],
      humanQuestionAskedAt: NOW,
      updatedAt: NOW,
    })
  })

  it('clearNeedsHuman flips the flag and leaves the question tuple STANDING', () => {
    // ASYMMETRIC, and the sharpest instance: the overlay can show
    // needsHuman:false while still carrying the question, its options, its
    // asker and its askedAt from the prior accumulated patch.
    expect(optimisticIssuePatch('clearNeedsHuman', { id: 'i' }, NOW)).toStrictEqual({
      needsHuman: false,
      updatedAt: NOW,
    })
  })
})

describe('optimisticIssuePatch — invariants across every arm', () => {
  it('every arm stamps updatedAt from the caller-supplied clock, never Date.now', () => {
    const other = '1999-12-31T23:59:59.000Z'
    for (const name of ISSUE_COMMAND_NAMES) {
      expect(optimisticIssuePatch(name, { id: 'i' }, other).updatedAt).toBe(other)
    }
  })

  it('no arm returns pendingSync — the queue flag is the consumer\'s to derive', () => {
    for (const name of ISSUE_COMMAND_NAMES) {
      expect(optimisticIssuePatch(name, { id: 'i' }, NOW)).not.toHaveProperty('pendingSync')
    }
  })

  it('no arm returns commentCount — addComment\'s bump is the consumer\'s', () => {
    // The count bump lives in applyUpstreamOptimisticPatch (#175), not here.
    expect(optimisticIssuePatch('addComment', { id: 'i', body: 'hi' }, NOW)).toStrictEqual({
      updatedAt: NOW,
    })
  })

  it('no arm returns a nested entity array — nothing here can embed sessions', () => {
    // ADR 4 D7.1: `IssueWire.sessions` is the embed being deleted. The switch
    // must not be a second producer of it, now or after the cutover.
    for (const name of ISSUE_COMMAND_NAMES) {
      const patch = optimisticIssuePatch(
        name,
        { id: 'i', sessions: [{ id: 'ses_1' }], patch: { sessions: [{ id: 'ses_1' }] } },
        NOW,
      )
      // `update` passes its patch through unfiltered, so it is the one arm that
      // WOULD carry an embed if a caller put one there — recorded, since it is
      // the same unfiltered passthrough asserted above.
      if (name === 'update') {
        expect(patch).toHaveProperty('sessions')
        continue
      }
      expect(patch).not.toHaveProperty('sessions')
    }
  })
})
