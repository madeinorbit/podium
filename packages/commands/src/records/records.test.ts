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
import { RECORD_CONTRACTS, recordContracts } from './contracts'
import { declarationProblems, defineSyncedKind, label, spec, status } from './declare'
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
      'records.issueProjection.create',
      'records.issueProjection.edit',
      'records.sessionUserState.edit',
      'records.sessionUserState.remove',
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
