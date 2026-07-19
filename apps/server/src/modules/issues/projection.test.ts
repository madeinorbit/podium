import { describe, expect, it, vi } from 'vitest'
import type { IssueRow } from '../../store'
import {
  issueDepProjectionRows,
  issueDepToProjection,
  issueProjectionRows,
  issueRowToProjection,
  repoProjectionRows,
} from './projection'

/**
 * `IssueRow` → `IssueProjection` [POD-796] — the server's adapter onto THE model
 * mapping pair (ADR 4 D3.4).
 *
 * The model's own suite already proves the bijection field-by-field
 * (`packages/model/src/issue/issue.mapping.test.ts`). What is unproven — and
 * what lives here — is the SERVER's half: that today's hand-written `IssueRow`
 * is adapted onto `IssueStorageRow` without losing or inventing anything, and
 * that the projection carries none of the cross-entity payload the legacy
 * `IssueWire` carries.
 */

/** A FULLY populated row: every optional key present, every nullable key set.
 *  Populated-only fixtures cannot see a null/absent bug, so the null cases get
 *  their own tests below rather than riding on this one. */
function row(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'iss_1',
    repoPath: '/repo',
    repoId: 'repo_1',
    seq: 13,
    title: 'a title',
    description: 'a description',
    stage: 'in_progress',
    worktreePath: '/repo/.worktrees/x',
    branch: 'issue/13',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    machineId: 'mach_1',
    linearId: 'lin_1',
    linearIdentifier: 'POD-13',
    linearUrl: 'https://linear.app/x',
    activityNotes: 'notes',
    notesUpdatedAt: '2026-07-01T00:00:00.000Z',
    suggestedStage: 'review',
    suggestedReason: 'because',
    blockedBy: ['some-branch'],
    dependencyNote: 'dep note',
    prUrl: 'https://github.com/x/y/pull/1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    archived: false,
    revision: 7,
    deletedAt: null,
    priority: 2,
    type: 'feature',
    assignee: 'mgw',
    parentId: 'iss_parent',
    design: 'design',
    acceptance: 'acceptance',
    notes: 'notes',
    dueAt: '2026-08-01T00:00:00.000Z',
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: true,
    color: 'violet',
    estimateMin: 45,
    needsHuman: true,
    humanQuestion: 'which way?',
    humanQuestionOptions: ['left', 'right'],
    humanQuestionAskedBy: 'sess_1',
    humanQuestionAskedAt: '2026-07-02T00:00:00.000Z',
    panel: JSON.stringify({ todos: [{ text: 't', done: false }], artifacts: [], deferred: [] }),
    origin: 'agent',
    audience: 'human',
    draft: false,
    readAt: '2026-07-02T00:00:00.000Z',
    ...over,
  }
}

describe('issueRowToProjection [POD-796]', () => {
  it('carries the durable row through, revision included', () => {
    const p = issueRowToProjection(row())
    // Spot-checks across every field group, not an exhaustive restatement: an
    // exhaustive copy of the key list here would be the very drift ADR 4 kills.
    // The group-by-group guarantee is the model's (issueDurableShape → R1/R3/R4
    // by construction); what this asserts is that the ADAPTER feeds it honestly.
    expect(p).toMatchObject({
      id: 'iss_1',
      repoPath: '/repo',
      repoId: 'repo_1',
      seq: 13,
      title: 'a title',
      stage: 'in_progress',
      type: 'feature',
      priority: 2,
      pinned: true,
      color: 'violet',
      estimateMin: 45,
      worktreePath: '/repo/.worktrees/x',
      branch: 'issue/13',
      machineId: 'mach_1',
      linearIdentifier: 'POD-13',
      blockedBy: ['some-branch'],
      needsHuman: true,
      humanQuestion: 'which way?',
      humanQuestionOptions: ['left', 'right'],
      humanQuestionAskedBy: 'sess_1',
      parentId: 'iss_parent',
      dueAt: '2026-08-01T00:00:00.000Z',
      origin: 'agent',
      audience: 'human',
      draft: false,
      archived: false,
      readAt: '2026-07-02T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    })
    // The sync token (ADR 2 D3) — the field `expectedRevision` is compared
    // against, so a projection that dropped it would silently disarm conflict
    // detection for every cap client.
    expect(p.revision).toBe(7)
  })

  it('decodes the panel JSON column into the structured value', () => {
    // The R3→R1 half of the JSON-column split (ADR 4 §4.1's worked example):
    // the row holds TEXT, the projection holds the parsed value. Nothing outside
    // the model's fromStorage may JSON.parse this column.
    expect(issueRowToProjection(row()).panel).toEqual({
      todos: [{ text: 't', done: false }],
      artifacts: [],
      deferred: [],
    })
  })

  it('carries NO sessions, NO memberSessionIds and NO derived rollups', () => {
    // THE D7.1 property, as data. Every key below is a function of something
    // OTHER than this issue's own row, so its presence here would put
    // cross-entity work back on the publish path — the exact defect POD-796
    // exists to remove. `sessions`/`memberSessionIds` are the headline (a
    // session change would dirty the issue); the rollups are the same bug in
    // smaller print.
    const p = issueRowToProjection(row()) as Record<string, unknown>
    for (const derived of [
      'sessions',
      'memberSessionIds',
      'sessionSummary',
      'unread',
      'ready',
      'blocked',
      'deferred',
      'childCount',
      'childDoneCount',
      'commentCount',
      'displayRef',
      'prefix',
      'labels',
      'deps',
      'dependents',
      'comments',
      'viaHub',
      'upstreamStale',
      'pendingSync',
    ]) {
      expect(p, `IssueProjection must not carry the derived field '${derived}'`).not.toHaveProperty(
        derived,
      )
    }
  })

  it('spells an unset nullable column as an ABSENT key, not null', () => {
    // The R1/R3 → R4 nullability convention (model/shape.ts `wireShape` +
    // `dropNullValues`). `null` is durable's spelling of "no value"; absence is
    // the wire's. Asserting absence rather than `toBeUndefined()` on purpose —
    // a key present with `undefined` would serialize identically but is a
    // different in-memory value, and the replica's restoreNullValues treats the
    // two the same only because POD-795 made it (`=== undefined`, not `in`).
    const p = issueRowToProjection(
      row({ worktreePath: null, branch: null, assignee: null, deferUntil: null, color: null }),
    )
    expect(p).not.toHaveProperty('worktreePath')
    expect(p).not.toHaveProperty('branch')
    expect(p).not.toHaveProperty('assignee')
    expect(p).not.toHaveProperty('deferUntil')
    expect(p).not.toHaveProperty('color')
  })

  it('preserves the EMPTY STRING where the legacy serializer drops it', () => {
    // The deliberate divergence recorded in model/issue/mapping.ts and SETTLED
    // at this cutover: today's serializer omits by TRUTHINESS
    // (`...(row.assignee ? {assignee} : {})`), so a stored '' reaches the wire
    // absent and reads back as null — a lossy round-trip a mapping pair claiming
    // to be a bijection may not inherit. This pair omits on `=== null`, so ''
    // survives. Measured as safe against the live DB (assignee='' on 2 rows).
    const p = issueRowToProjection(row({ assignee: '', design: '' }))
    expect(p.assignee).toBe('')
    expect(p.design).toBe('')
  })

  it('fills the keys IssueRow marks optional with IssueRow’s own documented defaults', () => {
    // The twelve "Optional so pre-existing row literals stay valid" keys. A
    // stored row never exercises this (mapIssueRow fills every one), so this
    // pins the LITERAL path — which is where IssueRow says absence is legal.
    const bare = row()
    for (const k of [
      'repoId',
      'machineId',
      'deletedAt',
      'readAt',
      'color',
      'panel',
      'humanQuestionOptions',
      'humanQuestionAskedBy',
      'humanQuestionAskedAt',
      'origin',
      'audience',
      'draft',
    ]) {
      delete (bare as unknown as Record<string, unknown>)[k]
    }
    const p = issueRowToProjection(bare)
    // The defaults IssueRow's own doc comments declare: "absent = 'human'",
    // "absent = false", "null/absent = never opened".
    expect(p.origin).toBe('human')
    expect(p.audience).toBe('human')
    expect(p.draft).toBe(false)
    // Absent-optional → null → absent on the wire.
    expect(p).not.toHaveProperty('repoId')
    expect(p).not.toHaveProperty('machineId')
    expect(p).not.toHaveProperty('readAt')
    expect(p).not.toHaveProperty('panel')
  })

  it('THROWS on a row with no revision rather than fabricating one', () => {
    // THE revision decision. A stored row always has one (upsertIssue assigns on
    // every accepted write; POD-792 backfilled 1; mapIssueRow reads `?? 1`), so
    // this state means an unwritten literal. Fabricating a `1` would not be a
    // neutral placeholder — it is a CLAIM of "first write" that a client can echo
    // back as an expectedRevision precondition against a row at revision 47,
    // turning a stale write into an accepted one (ADR 1 / POD-793).
    const noRevision = row()
    delete (noRevision as Partial<IssueRow>).revision
    expect(() => issueRowToProjection(noRevision)).toThrow(/no revision/)
  })

  it('REFUSES a stored enum value the model does not understand', () => {
    // Stricter than today's blind `row.stage as IssueWire['stage']` cast, and
    // deliberately so (model/issue/storage.ts): an unrecognised value currently
    // flows onto the wire mislabelled as valid. The boundary refuses it instead.
    expect(() => issueRowToProjection(row({ type: 'not-a-type' }))).toThrow()
    expect(() => issueRowToProjection(row({ stage: 'not-a-stage' }))).toThrow()
  })
})

describe('issueProjectionRows: all-or-nothing [POD-796]', () => {
  it('projects every row when they all project', () => {
    const rows = issueProjectionRows([row({ id: 'iss_1' }), row({ id: 'iss_2' })])
    expect(rows?.map((r) => r.id)).toEqual(['iss_1', 'iss_2'])
  })

  it('returns undefined — NOT a partial list — when one row cannot be projected', () => {
    // THE reconcile-remove hazard. Ledger.reconcile is a FULL-TRUTH diff: every
    // baseline id missing from the rows it is handed is diffed as a REMOVE. So a
    // per-row skip would not degrade gracefully — it would durably tell every cap
    // client that the poison issue was DELETED. `undefined` leaves the baseline
    // untouched instead: stale by one publish, and self-healing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = issueProjectionRows([
        row({ id: 'iss_ok' }),
        row({ id: 'iss_poison', type: 'not-a-type' }),
        row({ id: 'iss_also_ok' }),
      ])
      expect(rows).toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('issueDep projection [POD-822]', () => {
  it("derives the edge id from its primary key, so the feed's identity is the store's", () => {
    const p = issueDepToProjection({ fromId: 'iss_1', toId: 'iss_2', type: 'blocks' })
    // The composed key — not a minted id. Re-adding the same edge produces a
    // byte-identical row the ledger dedups, so a no-op add appends nothing.
    expect(p).toEqual({ id: 'iss_1|iss_2|blocks', fromId: 'iss_1', toId: 'iss_2', type: 'blocks' })
    expect(issueDepToProjection({ fromId: 'iss_1', toId: 'iss_2', type: 'blocks' })).toEqual(p)
  })

  it('rows: keys each edge by its composed id, stable order', () => {
    const rows = issueDepProjectionRows([
      { fromId: 'iss_1', toId: 'iss_2', type: 'blocks' },
      { fromId: 'iss_1', toId: 'iss_3', type: 'related' },
    ])
    expect(rows?.map((r) => r.id)).toEqual(['iss_1|iss_2|blocks', 'iss_1|iss_3|related'])
  })

  it('returns undefined — NOT a partial list — when an edge id cannot be composed', () => {
    // Same reconcile-remove hazard as issueProjectionRows: a partial list would
    // diff every missing edge as a REMOVE, flipping genuinely-blocked issues to
    // blocked=false on every replica. A `|` in an id is the only reachable throw.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = issueDepProjectionRows([
        { fromId: 'iss_1', toId: 'iss_2', type: 'blocks' },
        { fromId: 'iss_a|b', toId: 'iss_2', type: 'blocks' },
      ])
      expect(rows).toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('repo projection [POD-822]', () => {
  it('keys by the LOGICAL repoId and collapses sibling checkouts to one row', () => {
    // repos.listRepos() returns one row per (machine, path); the entity is the
    // logical repo, so two checkouts of repo_a with the same prefix are ONE row.
    const rows = repoProjectionRows([
      { repoId: 'repo_a', prefix: 'POD' },
      { repoId: 'repo_a', prefix: 'POD' },
      { repoId: 'repo_b', prefix: null },
    ])
    expect(rows).toEqual([
      { id: 'repo_a', value: { id: 'repo_a', prefix: 'POD' } },
      // prefix: null becomes an ABSENT key on the wire (the null↔absent
      // convention), which is what makes displayRef fall back to #13.
      { id: 'repo_b', value: { id: 'repo_b' } },
    ])
  })

  it('drops rows with no repoId — an unidentified repo has no stable id to address', () => {
    const rows = repoProjectionRows([
      { repoId: null, prefix: 'POD' },
      { repoId: 'repo_a', prefix: 'POD' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['repo_a'])
  })
})
