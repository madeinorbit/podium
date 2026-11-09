/**
 * GENERIC SYNCED EDITS, THE DECLARATIONS AND THEIR COMMANDS (ADR 12 D3/D4,
 * POD-6391). The server half (field permission, conflict rule, the matrix
 * agreement) is `apps/server/src/modules/records/records.test.ts`.
 */

import { ROW } from '@podium/model'
import { MetadataEntityKind } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { classificationErrors } from '../contract'
import { RECORD_CONTRACTS, recordContracts, recordEditInput } from './contracts'
import {
  declarationProblems,
  defineSyncedKind,
  editNeedsRevision,
  fieldConflict,
  label,
  spec,
  status,
  unsettableFields,
} from './declare'
import { freshCreateFields, freshRow, pendingCells } from './fresh'
import { ISSUE_FIELD_DEFAULTS, issueSeqPending } from './issue-fresh'
import { ISSUE_RECORD, NOT_YET_GENERIC, SESSION_USER_STATE_RECORD, SYNCED_KINDS } from './kinds'

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value')
  return value
}

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'

describe('every feed kind is declared or has an owner for its conversion', () => {
  it('the two lists together are exactly the feed kinds, with no overlap', () => {
    const declared = SYNCED_KINDS.map((d) => d.kind)
    const pending = Object.keys(NOT_YET_GENERIC)
    expect(declared.filter((k) => pending.includes(k))).toEqual([])
    expect([...declared, ...pending].sort()).toEqual([...MetadataEntityKind.options].sort())
  })

  it('every declaration is well-formed', () => {
    for (const d of SYNCED_KINDS) expect(declarationProblems(d), d.kind).toEqual([])
  })
})

describe('a declaration that could never serve a command fails where it is written', () => {
  const minimal = {
    kind: 'conversation' as const,
    title: 'conversation',
    wire: z.object({ id: z.string(), title: z.string() }),
    ref: z.string(),
    conflict: 'field-LWW' as const,
    visibility: ISSUE_RECORD.visibility,
    exposure: ISSUE_RECORD.exposure,
    delivery: ISSUE_RECORD.delivery,
    redaction: ISSUE_RECORD.redaction,
    attribution: ISSUE_RECORD.attribution,
    errorConsistency: ISSUE_RECORD.errorConsistency,
  }
  const edit = { edit: must(ISSUE_RECORD.ops.edit) }

  it('a field that is not on the wire schema', () => {
    expect(() =>
      defineSyncedKind({
        ...minimal,
        fields: { nope: spec(z.string(), ROW.issueCore) },
        ops: edit,
      }),
    ).toThrow(/nope is not on the conversation wire schema/)
  })

  it('a create with no device id shape', () => {
    expect(() =>
      defineSyncedKind({
        ...minimal,
        fields: { title: spec(z.string(), ROW.issueCore) },
        ops: { create: must(ISSUE_RECORD.ops.create) },
        creates: ISSUE_RECORD.creates,
      }),
    ).toThrow(/device id shape/)
  })

  it('an edit with nothing a client may write', () => {
    expect(() =>
      defineSyncedKind({
        ...minimal,
        fields: { title: status(z.string(), ROW.issueCore) },
        ops: edit,
      }),
    ).toThrow(/no spec field/)
  })

  it('a required label', () => {
    expect(() =>
      defineSyncedKind({
        ...minimal,
        fields: {
          title: spec(z.string(), ROW.issueCore),
          id: label(z.string(), ROW.issueCore, { required: true }),
        },
        ops: edit,
      }),
    ).toThrow(/required but a label field/)
  })
})

describe('the generated commands', () => {
  it('one contract per offered op, named records.<kind>.<op>', () => {
    expect(Object.keys(RECORD_CONTRACTS).sort()).toEqual([
      'records.effect.edit',
      'records.issueProjection.create',
      'records.issueProjection.edit',
      'records.issueUserState.edit',
      'records.pin.create',
      'records.pin.remove',
      'records.session.edit',
      'records.session.remove',
      'records.sessionUserState.edit',
      'records.sessionUserState.remove',
      'records.superagentThread.edit',
      'records.tabOrder.edit',
      'records.tabOrder.remove',
      'records.userLayout.edit',
      'records.userLayout.remove',
      'records.userPreferences.edit',
      'records.userReadPosition.edit',
    ])
  })

  it('are classified: policy, delivery, redaction and conflict all pass the lint', () => {
    for (const contract of Object.values(RECORD_CONTRACTS)) {
      expect(classificationErrors(contract), contract.name).toEqual([])
    }
  })

  it('carry the kind’s conflict rule on edit and remove, append on create', () => {
    const issue = recordContracts(ISSUE_RECORD)
    expect(issue.edit?.conflict).toBe('exp-rev')
    expect(issue.create?.conflict).toBe('append')
    expect(recordContracts(SESSION_USER_STATE_RECORD).edit?.conflict).toBe('single-writer')
  })

  it('an edit parses any declared field and refuses an undeclared one', () => {
    const input = must(recordContracts(ISSUE_RECORD).edit).input
    const id = `iss_${UUID}`
    expect(input.safeParse({ id, patch: { title: 'renamed' }, expectedRevision: 3 }).success).toBe(
      true,
    )
    // A status field PARSES: the server refuses it after the target check.
    expect(input.safeParse({ id, patch: { revision: 9 } }).success).toBe(true)
    expect(input.safeParse({ id, patch: { stage: 'done' } }).success).toBe(false)
    expect(input.safeParse({ id, patch: {} }).success).toBe(false)
  })

  it('a create checks the device id shape (ADR 12 D4) and the required fields', () => {
    const input = must(recordContracts(ISSUE_RECORD).create).input
    const fields = { repoPath: '/p', title: 'new' }
    expect(input.safeParse({ id: `iss_${UUID}`, fields }).success).toBe(true)
    for (const id of ['#12', 'POD-12', UUID, 'iss_12']) {
      expect(input.safeParse({ id, fields }).success, id).toBe(false)
    }
    expect(input.safeParse({ id: `iss_${UUID}`, fields: { repoPath: '/p' } }).success).toBe(false)
    // Labels are the server's: a create cannot carry one.
    expect(input.safeParse({ id: `iss_${UUID}`, fields: { ...fields, seq: 7 } }).success).toBe(
      false,
    )
  })
})

describe('what a new record looks like (POD-6400)', () => {
  const ctx = { at: '2026-11-04T12:00:00.000Z', by: 'user_1' }
  const id = `iss_${UUID}`

  it('every kind that offers create declares a fresh record', () => {
    for (const d of SYNCED_KINDS) {
      expect(d.ops.create === undefined || d.fresh !== undefined, d.kind).toBe(true)
    }
  })

  it('a new issue is a whole wire row from only what a person chose', () => {
    const row = freshRow(ISSUE_RECORD, id, { title: 'new', repoPath: '/p' }, ctx)
    expect(ISSUE_RECORD.wire.safeParse(row).success).toBe(true)
    expect(row).toMatchObject({
      id,
      title: 'new',
      description: { value: '' },
      priority: ISSUE_FIELD_DEFAULTS.priority,
      type: 'task',
      stage: 'backlog',
      owner: 'user_1',
      createdAt: ctx.at,
      updatedAt: ctx.at,
    })
    expect(issueSeqPending(row as { seq: number })).toBe(true)
    // The placement input places the record; it is not a cell of it.
    expect(row).not.toHaveProperty('repoPath')
  })

  it('a device that does not know its person still paints a whole row', () => {
    const row = freshRow(ISSUE_RECORD, id, { title: 'new', repoPath: '/p' }, { ...ctx, by: null })
    expect(ISSUE_RECORD.wire.safeParse(row).success).toBe(true)
  })

  it('what the create names wins over a default', () => {
    expect(freshCreateFields(ISSUE_RECORD, { title: 't', priority: 0 })).toEqual({
      title: 't',
      priority: 0,
      description: '',
      type: 'task',
      labels: [],
      archived: false,
    })
    const row = freshRow(ISSUE_RECORD, id, { title: 't', description: 'why' }, ctx)
    expect(row).toMatchObject({ description: { value: 'why' } })
  })

  it('places a new issue under the one repo this device holds at its path, else nowhere', () => {
    const at = (rows: Record<string, string[]>) => ({
      ...ctx,
      known: (entity: string, field: string, value: unknown) =>
        entity === 'repo' && field === 'repoPath' ? (rows[String(value)] ?? []) : [],
    })
    const fields = { title: 'new', repoPath: '/p' }
    expect(freshRow(ISSUE_RECORD, id, fields, at({ '/p': ['repo_a'] }))?.repoId).toBe('repo_a')
    // Two repos at one path, or none: the server decides; nothing is guessed.
    expect(
      freshRow(ISSUE_RECORD, id, fields, at({ '/p': ['repo_a', 'repo_b'] })),
    ).not.toHaveProperty('repoId')
    expect(freshRow(ISSUE_RECORD, id, fields, at({}))).not.toHaveProperty('repoId')
    expect(freshRow(ISSUE_RECORD, id, fields, ctx)).not.toHaveProperty('repoId')
  })

  it('every label and status field is pending: a paint never shows an invented value as known', () => {
    for (const [name, f] of Object.entries(ISSUE_RECORD.fields)) {
      if (f.role === 'label' || f.role === 'status') {
        expect(pendingCells(ISSUE_RECORD), name).toContain(name)
      }
    }
  })

  describe('a fresh record that would not paint a whole row fails where it is written', () => {
    const wire = z.object({
      id: z.string(),
      title: z.string(),
      seq: z.number().int(),
      stage: z.enum(['backlog', 'done']),
    })
    const base = {
      kind: 'conversation' as const,
      title: 'thing',
      wire,
      ref: z.string(),
      newId: z.string(),
      conflict: 'exp-rev' as const,
      visibility: ISSUE_RECORD.visibility,
      exposure: ISSUE_RECORD.exposure,
      delivery: ISSUE_RECORD.delivery,
      redaction: ISSUE_RECORD.redaction,
      attribution: ISSUE_RECORD.attribution,
      errorConsistency: ISSUE_RECORD.errorConsistency,
      creates: ISSUE_RECORD.creates,
      ops: { create: must(ISSUE_RECORD.ops.create) },
    }
    const fields = {
      title: spec(z.string(), ROW.issueCore, { required: true }),
      seq: label(z.number().int(), ROW.issueCore),
    }
    const fresh = { cells: { stage: 'backlog' }, pending: { seq: () => 0 } }

    it('the well-formed one is accepted', () => {
      expect(() => defineSyncedKind({ ...base, fields, fresh })).not.toThrow()
    })

    it('a create with no fresh record', () => {
      expect(() => defineSyncedKind({ ...base, fields })).toThrow(/without a fresh record/)
    })

    it('a required wire cell nothing covers', () => {
      expect(() => defineSyncedKind({ ...base, fields, fresh: { ...fresh, cells: {} } })).toThrow(
        /a fresh thing has no stage/,
      )
    })

    it('a label the paint does not mark pending', () => {
      expect(() => defineSyncedKind({ ...base, fields, fresh: { ...fresh, pending: {} } })).toThrow(
        /label field seq is not pending/,
      )
    })

    it('a constant or placeholder that is not a value of its cell', () => {
      expect(() =>
        defineSyncedKind({ ...base, fields, fresh: { ...fresh, cells: { stage: 'later' } } }),
      ).toThrow(/fresh cell stage does not parse/)
      expect(() =>
        defineSyncedKind({ ...base, fields, fresh: { ...fresh, pending: { seq: () => 'x' } } }),
      ).toThrow(/pending cell seq's placeholder does not parse/)
      expect(() =>
        defineSyncedKind({
          ...base,
          fields,
          fresh: { ...fresh, pending: { seq: () => undefined } },
        }),
      ).toThrow(/pending cell seq's placeholder does not parse/)
    })

    it('a default on a field the server fills, or one that is not a value of the field', () => {
      expect(() =>
        defineSyncedKind({
          ...base,
          fields: { ...fields, seq: label(z.number().int(), ROW.issueCore, { default: 1 }) },
          fresh,
        }),
      ).toThrow(/seq has a default but a label field/)
      expect(() =>
        defineSyncedKind({
          ...base,
          fields: {
            ...fields,
            stage: spec(z.enum(['backlog', 'done']), ROW.issueCore, {
              default: 'later' as 'backlog',
            }),
          },
          fresh: { cells: {}, pending: fresh.pending },
        }),
      ).toThrow(/stage's default does not parse/)
    })

    it('a fresh record on a kind with no create', () => {
      expect(() =>
        defineSyncedKind({ ...base, ops: { edit: must(ISSUE_RECORD.ops.edit) }, fields, fresh }),
      ).toThrow(/fresh record without a create/)
    })
  })
})

describe('clearing a field, and a conflict rule per field (POD-6403)', () => {
  const {
    placement: _placement,
    fresh: _fresh,
    creates: _creates,
    newId: _newId,
    ...cells
  } = ISSUE_RECORD
  const NOTE = defineSyncedKind({
    ...cells,
    kind: 'conversation',
    title: 'note',
    wire: z.object({
      id: z.string(),
      title: z.string(),
      note: z.string().optional(),
      revision: z.number(),
    }),
    ref: z.string(),
    conflict: 'exp-rev',
    fields: {
      title: spec(z.string(), ROW.issueCore),
      // A plain field: the last writer wins, whatever the record's revision.
      note: spec(z.string(), ROW.composerDraft, { conflict: 'field-LWW' }),
      revision: status(z.number(), ROW.issueCore),
    },
    ops: { edit: must(ISSUE_RECORD.ops.edit) },
  })

  it('a field may carry its own rule; the kind’s rule is every other field’s', () => {
    expect(fieldConflict(NOTE, 'note')).toBe('field-LWW')
    expect(fieldConflict(NOTE, 'title')).toBe('exp-rev')
  })

  it('only an edit that names an exp-rev field must name a revision', () => {
    expect(editNeedsRevision(NOTE, ['note'])).toBe(false)
    expect(editNeedsRevision(NOTE, ['note', 'title'])).toBe(true)
    expect(editNeedsRevision(SESSION_USER_STATE_RECORD, ['readAt'])).toBe(false)
  })

  it('an edit may clear an optional spec field, and nothing else', () => {
    expect(unsettableFields(NOTE)).toEqual(['note'])
    const input = recordEditInput(NOTE)
    expect(input.safeParse({ id: 'n', patch: {}, unset: ['note'] }).success).toBe(true)
    // A cell the wire always carries cannot be absent; a status is the server's.
    expect(input.safeParse({ id: 'n', patch: {}, unset: ['title'] }).success).toBe(false)
    expect(input.safeParse({ id: 'n', patch: {}, unset: ['revision'] }).success).toBe(false)
    // An edit still says something, and never both sets and clears one field.
    expect(input.safeParse({ id: 'n', patch: {} }).success).toBe(false)
    expect(input.safeParse({ id: 'n', patch: { note: 'a' }, unset: ['note'] }).success).toBe(false)
  })

  it('a field rule generic edits cannot apply fails where it is written', () => {
    expect(() =>
      defineSyncedKind({
        ...NOTE,
        fields: {
          ...NOTE.fields,
          note: spec(z.string(), ROW.composerDraft, { conflict: 'cmd' as never }),
        },
      }),
    ).toThrow(/note's conflict cmd/)
  })
})
