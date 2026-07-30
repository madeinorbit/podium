/**
 * Tests for the presence-class contracts (POD-380) and the four facets they
 * carry. The load-bearing ones are the TOTALITY tests: a new presence contract
 * that forgets `policy`, `exposure`, `offline` or `redaction` fails here rather
 * than being served with an implicit default.
 */

import { OP_STREAM_MEMBERS, PinKind, WorkState } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type CommandDef, commandExposure, isExposedOn } from './commands'
import {
  pinCommands,
  PRESENCE_COMMAND_TABLES,
  presenceCommand,
  presenceCommandNames,
  sessionPresenceCommands,
} from './session-commands'

/** Every presence contract, paired with its dotted name. */
const contracts = presenceCommandNames().map((name) => {
  const def = presenceCommand(name)
  if (!def) throw new Error(`presenceCommand(${name}) returned undefined`)
  return { name, def }
})

describe('the presence-class inventory', () => {
  it('covers exactly the eleven writes POD-380 migrates', () => {
    expect(presenceCommandNames().sort()).toEqual(
      [
        'pins.set',
        'sessions.markRead',
        'sessions.markUnread',
        'sessions.rename',
        'sessions.setArchived',
        'sessions.setDraft',
        'sessions.setIssueId',
        'sessions.setWorkState',
        'snoozes.clear',
        'snoozes.set',
        'tabs.setOrder',
      ].sort(),
    )
  })

  it('presenceCommand resolves a real name and refuses a near-miss', () => {
    expect(presenceCommand('sessions.rename')).toBe(sessionPresenceCommands.defs.rename)
    // Not a prototype walk, and not a fuzzy match: an unmigrated proc is undefined,
    // which is what a cutover audit reads to tell migrated from hand-written.
    expect(presenceCommand('sessions.sendText')).toBeUndefined()
    expect(presenceCommand('sessions.toString')).toBeUndefined()
    expect(presenceCommand('sessions')).toBeUndefined()
    expect(presenceCommand('pins.setOrder')).toBeUndefined()
  })
})

describe('the four facets are present on every presence contract', () => {
  it.each(contracts)('$name declares policy / exposure / offline / redaction', ({ def }) => {
    expect(def.policy).toBeDefined()
    expect(def.exposure).toBeDefined()
    expect(def.offline).toBeDefined()
    expect(def.redaction).toBeDefined()
    // The conflict class travels with the contract too (ADR 1's vocabulary).
    expect(def.conflict).toBeDefined()
  })

  it.each(contracts)('$name declares a non-empty exposure set', ({ def }) => {
    // A contract that declared `exposure: []` would typecheck and read as
    // "classified", but be served nowhere — an unreachable command, not a
    // default-closed one. Distinguish the two.
    expect(commandExposure(def).length).toBeGreaterThan(0)
  })
})

describe('exposure is DEFAULT-CLOSED, and that is the only default', () => {
  it('an unclassified contract is served on NO transport', () => {
    const unclassified: CommandDef = { input: z.object({}), action: 'write' }

    expect(commandExposure(unclassified)).toEqual([])
    for (const transport of ['trpc', 'relay', 'cli', 'mcp', 'ws'] as const) {
      expect(isExposedOn(unclassified, transport)).toBe(false)
    }
  })

  it('a classified contract is served on the declared transport and refused on the others — the gate discriminates', () => {
    // The counterfactual the default-closed claim needs: prove the gate can say
    // YES, or "everything is refused" would pass against a gate stuck at false.
    const rename = sessionPresenceCommands.defs.rename
    expect(isExposedOn(rename, 'trpc')).toBe(true)
    expect(isExposedOn(rename, 'relay')).toBe(false)
    expect(isExposedOn(rename, 'cli')).toBe(false)
    expect(isExposedOn(rename, 'mcp')).toBe(false)
  })

  it('NO presence contract is exposed on the relay — the absence POD-379 pinned is now a declaration', () => {
    // POD-379: "the presence-class writes have NO agent path at all. They are
    // operator-only by ABSENCE from the relay allowlist, not by a check. A
    // migration that routes them through a uniform command plane must reproduce
    // the absence deliberately." This test IS the deliberate reproduction.
    for (const { name, def } of contracts) {
      expect(isExposedOn(def, 'relay'), `${name} must not be relay-exposed`).toBe(false)
    }
  })
})

describe('the visibility-class split (§3.1.1 / §3.3)', () => {
  const perUserState = [
    'sessions.markRead',
    'sessions.markUnread',
    'snoozes.set',
    'snoozes.clear',
    'pins.set',
    'tabs.setOrder',
  ]
  const ownedSession = [
    'sessions.rename',
    'sessions.setArchived',
    'sessions.setWorkState',
    'sessions.setIssueId',
    'sessions.setDraft',
  ]

  it('splits the inventory exhaustively — every contract is in exactly one class', () => {
    expect([...perUserState, ...ownedSession].sort()).toEqual(presenceCommandNames().sort())
  })

  it.each(perUserState)('%s is self-scoped per-user state, single-writer', (name) => {
    const def = presenceCommand(name)
    expect(def?.policy).toEqual({ resource: 'per-user-state', scope: 'self', action: 'write' })
    // The point of the re-key: the conflict class collapses (§3.3).
    expect(def?.conflict).toBe('single-writer')
  })

  it.each(ownedSession)('%s writes the session under owner-or-grant', (name) => {
    const def = presenceCommand(name)
    expect(def?.policy?.resource).toBe('session')
    expect(def?.policy?.scope).toBe('owner-or-grant')
  })

  it('no per-user contract is owner-or-grant scoped — the two rules are not interchangeable', () => {
    // ADR 9 D3 rule 4: per-user state is NON-GRANTABLE. A per-user row that fell
    // back to owner-or-grant would become shareable, which is the bug this
    // classification exists to prevent.
    for (const name of perUserState) {
      expect(presenceCommand(name)?.policy?.scope).not.toBe('owner-or-grant')
    }
  })
})

describe('offline classes match POD-379’s outbox oracle exactly', () => {
  // The oracle tags the covered set must-not-change. These are not new decisions;
  // a diff here means the migration changed which writes survive an offline gap.
  const OFFLINE_ELIGIBLE = [
    'sessions.rename',
    'sessions.setArchived',
    'sessions.setWorkState',
    'sessions.markRead',
    'sessions.markUnread',
    'snoozes.set',
    'snoozes.clear',
  ]

  it('exactly the seven writes createEngineOutbox enqueues are offline-eligible', () => {
    const eligible = contracts.filter((c) => c.def.offline === 'eligible').map((c) => c.name)
    expect(eligible.sort()).toEqual(OFFLINE_ELIGIBLE.sort())
  })

  it('pins and tab order are the deliberate exclusions, not oversights — each records why', () => {
    for (const name of ['pins.set', 'tabs.setOrder']) {
      const def = presenceCommand(name)
      expect(def?.offline).toBe('direct-only')
      expect(def?.decision).toContain('POD-379')
    }
  })
})

describe('redaction', () => {
  it('the composer draft redacts its edit — unsent user prose never reaches a log', () => {
    const draft = sessionPresenceCommands.defs.setDraft
    expect(draft.redaction?.fields).toEqual(['edit'])
    expect(draft.redaction?.note).toBeTruthy()
  })

  it('every other presence contract declares an EMPTY redaction set, not an absent one', () => {
    for (const { name, def } of contracts) {
      if (name === 'sessions.setDraft') continue
      expect(def.redaction?.fields, name).toEqual([])
    }
  })
})

describe('the composer draft reserves op-stream without building it (§4)', () => {
  const draft = sessionPresenceCommands.defs.setDraft
  const parse = (input: unknown) => draft.input.safeParse(input)

  it('declares the op-stream conflict class, and the draft is a DECLARED member of the reserved set', () => {
    expect(draft.conflict).toBe('op-stream')
    // The class's membership is closed (ADR 1 Am1 D12) and POD-365 already owns
    // the list. This contract must be reserving a member of THAT set, not
    // inventing a twelfth op-stream field by convenience.
    expect(OP_STREAM_MEMBERS).toContain('session.composerDraft')
    expect(draft.decision).toContain('op-stream')
    // §3.3 classifies the draft as shared-surface state, NOT per-user. If a later
    // implementer deviates, the deviation must be recorded here — this assertion
    // is what makes a silent switch to per-user visible.
    expect(draft.policy?.resource).toBe('session')
  })

  it('edit is a DISCRIMINATED UNION, so a splice op joins it additively', () => {
    expect(parse({ sessionId: 's', edit: { kind: 'replace', text: 'hi' } }).success).toBe(true)
    // Not a bare `{text}`: a flat payload could not gain a second op shape
    // without a wire change, which is exactly what the reservation must avoid.
    expect(parse({ sessionId: 's', text: 'hi' }).success).toBe(false)
    expect(parse({ sessionId: 's', edit: { kind: 'splice', at: 0 } }).success).toBe(false)
  })

  it('baseRevision is optional — absent is today’s unconditional write, present enables rejection', () => {
    expect(parse({ sessionId: 's', edit: { kind: 'replace', text: 'x' } }).success).toBe(true)
    expect(parse({ sessionId: 's', baseRevision: 3, edit: { kind: 'replace', text: 'x' } }).success).toBe(
      true,
    )
    // A revision is an ordinal, not a timestamp or a string: -1 and 1.5 are not
    // revisions the Authority could have issued.
    expect(parse({ sessionId: 's', baseRevision: -1, edit: { kind: 'replace', text: 'x' } }).success).toBe(
      false,
    )
    expect(
      parse({ sessionId: 's', baseRevision: 1.5, edit: { kind: 'replace', text: 'x' } }).success,
    ).toBe(false)
  })
})

/** `.nullable()` wraps the enum, so identity has to be read through the wrapper.
 *  Throws rather than returning the wrapper when the shape is not what it expects,
 *  so a schema change cannot silently turn this into a comparison of two wrappers. */
function unwrapNullable(field: z.ZodTypeAny): z.ZodTypeAny {
  const inner = (field as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType
  if (!inner) throw new Error('expected a nullable wrapper around the enum')
  return inner
}

/** The `workState` field of the setWorkState contract, non-optional so a shape
 *  change surfaces here rather than as a skipped assertion. */
function workStateField(): z.ZodTypeAny {
  const shape = (sessionPresenceCommands.defs.setWorkState.input as z.ZodObject<z.ZodRawShape>).shape
  const field = shape.workState
  if (!field) throw new Error('setWorkState contract has no workState field')
  return field
}

describe('input schemas preserve the shipped router validation', () => {
  it('rename keeps the 120-character bound', () => {
    const rename = sessionPresenceCommands.defs.rename
    expect(rename.input.safeParse({ sessionId: 's', name: 'x'.repeat(120) }).success).toBe(true)
    expect(rename.input.safeParse({ sessionId: 's', name: 'x'.repeat(121) }).success).toBe(false)
  })

  it('mutationId keeps the 128-character bound on every write that carries one', () => {
    for (const { name, def } of contracts) {
      const shape = (def.input as z.ZodObject<z.ZodRawShape>).shape
      expect(Object.hasOwn(shape, 'mutationId'), `${name} must accept a mutationId`).toBe(true)
    }
    expect(
      sessionPresenceCommands.defs.markRead.input.safeParse({
        sessionId: 's',
        mutationId: 'm'.repeat(129),
      }).success,
    ).toBe(false)
  })

  it('setWorkState’s field IS @podium/model’s WorkState instance, not a same-shaped copy', () => {
    // `toBe`, not accepted-value equality. A local `z.enum([...])` with identical
    // members parses the same, encodes the same, and passes every one of the golden
    // wire cases — enum membership is compile-time, so the wire gate cannot see a
    // fork. Instance identity is the only assertion that can.
    expect(unwrapNullable(workStateField())).toBe(WorkState)
  })

  it('pins.set’s kind field IS @podium/model’s PinKind instance', () => {
    const shape = (pinCommands.defs.set.input as z.ZodObject<z.ZodRawShape>).shape
    expect(shape.kind).toBe(PinKind)
  })

  it('every table namespace matches the tRPC router it replaces', () => {
    expect(PRESENCE_COMMAND_TABLES.map((t) => t.namespace)).toEqual([
      'sessions',
      'snoozes',
      'pins',
      'tabs',
    ])
  })
})
