/**
 * The command-plane contract table (POD-381) — the facet invariants ADR 3 makes
 * derivable, enforced here rather than in review.
 */

import { AgentKind, ResumeRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { commandExposure, isExposedOn } from '../framework'
import {
  commandPlaneContract,
  commandPlaneNames,
  sessionCommandPlane,
  sessionCommandPlaneInputs,
} from './command-plane'

const defs = Object.entries(sessionCommandPlane.defs)

/**
 * The ONE command in this class that may be queued offline, and the only reason
 * it may. Named as a constant so the exemption below cannot silently grow: a
 * second offline-eligible execution command has to edit this line.
 */
const OFFLINE_ELIGIBLE_EXCEPTION = 'resumeAndSend'

describe('the command-plane table', () => {
  it('covers exactly the eleven command-plane procs, and neither handoff nor ask', () => {
    // NINE were POD-381's. `stop` and `uploadImage` were added by POD-382, which had
    // to delete the last hand-written session mutations from router.ts and could only
    // do that by giving them contracts. `ask` was briefly here too and was REMOVED at
    // the integration merge: POD-729 cut it over to the mail table, and two contracts
    // for one command is a fork. The list is exact rather than a `toContain` so a
    // twelfth arrival has to edit this line — and so a command silently REMOVED from
    // the table cannot pass either.
    expect(commandPlaneNames().sort()).toEqual([
      'sessions.answerAskUserQuestion',
      'sessions.continue',
      'sessions.create',
      'sessions.hibernate',
      'sessions.kill',
      'sessions.resume',
      'sessions.resumeAndSend',
      'sessions.resurrect',
      'sessions.sendText',
      'sessions.stop',
      'sessions.uploadImage',
    ])
    // POD-642's and POD-729's respectively; neither may drift into this table.
    expect(commandPlaneContract('handoff')).toBeUndefined()
    expect(commandPlaneContract('ask')).toBeUndefined()
    // The lookup can also say yes — otherwise the line above proves nothing.
    expect(commandPlaneContract('kill')).toBeDefined()
  })

  it.each(defs)('%s declares every ADR 3 facet — none is left to a default', (_key, def) => {
    expect(def.policy).toBeDefined()
    expect(def.offline).toBeDefined()
    expect(def.redaction).toBeDefined()
    expect(def.conflict).toBe('cmd')
    // Default-closed means ABSENT ⇒ nowhere; a migrated command must opt in.
    expect(commandExposure(def).length).toBeGreaterThan(0)
  })

  it.each(defs)('%s requires the machine `use` verb — it commands a process', (_key, def) => {
    expect(def.policy?.machineVerb).toBe('use')
  })

  // D18.3's implication (machineVerb 'use' ⇒ not offline-eligible) and its ONE
  // named exception are asserted in `command-facet-rules.test.ts`, over EVERY
  // contract table this package exports rather than only this one. POD-642
  // spotted why that matters: `sessions.handoff` is the second declarer of the
  // field, and a per-file assertion would have left the rule unenforced for the
  // table that motivated it. A rule with two homes is a rule that drifts, so it
  // is not restated here.

  it('exposure is per-command, not one blanket list', () => {
    // create is an operator seam; sendText is reachable by an agent at a peer.
    // If these were equal the exposure facet would be decorative.
    expect(isExposedOn(sessionCommandPlane.defs.create, 'relay')).toBe(false)
    expect(isExposedOn(sessionCommandPlane.defs.sendText, 'relay')).toBe(true)
    expect(isExposedOn(sessionCommandPlane.defs.create, 'trpc')).toBe(true)
    // No command-plane write is served on the raw websocket surface.
    for (const [, def] of defs) expect(isExposedOn(def, 'ws')).toBe(false)
  })

  it.each(
    defs,
  )('%s: the exported input schema IS the contract’s instance, not a copy of it', (key, def) => {
    // `toBe`, never `toEqual`. The router builds its procedures on
    // sessionCommandPlaneInputs for the precise types CommandDef's widened
    // ZodTypeAny cannot give it; if that map ever held a FRESH z.object with
    // the same keys, every value assertion in this file would still pass, the
    // wire bytes would be identical, and the two would silently drift apart at
    // the first schema edit. Only instance identity sees that.
    expect(sessionCommandPlaneInputs[key as keyof typeof sessionCommandPlaneInputs]).toBe(def.input)
  })

  it('the exported input map covers every contract and nothing else', () => {
    expect(Object.keys(sessionCommandPlaneInputs).sort()).toEqual(
      Object.keys(sessionCommandPlane.defs).sort(),
    )
  })

  it("the vocabularies are the MODEL's instances, not same-valued copies", () => {
    // `toBe`, never a comparison of accepted values. A forked z.enum with
    // identical members parses, encodes and passes every golden case
    // identically — POD-380 found exactly that defect in its own contracts
    // after a wire regeneration, and enum membership being compile-time is why
    // no other gate would have caught it.
    // Asserted through the precisely-typed input map rather than through
    // `CommandDef['input']`, which is a widened ZodTypeAny with no `.shape` —
    // and these are the exact objects the router builds its procedures on.
    expect(sessionCommandPlaneInputs.create.shape.agentKind.unwrap()).toBe(AgentKind)
    expect(sessionCommandPlaneInputs.resume.shape.agentKind).toBe(AgentKind)
    expect(sessionCommandPlaneInputs.resume.shape.resume).toBe(ResumeRef)
  })

  it('input schemas are live and reject the shapes the router rejected', () => {
    const create = sessionCommandPlane.defs.create.input
    expect(create.safeParse({ cwd: '/p' }).success).toBe(true)
    // A non-uuid client id must be refused before it can reach the durable-label
    // path — POD-379 pins that refusal.
    expect(create.safeParse({ cwd: '/p', sessionId: '../../evil' }).success).toBe(false)
    const send = sessionCommandPlane.defs.sendText.input
    expect(send.safeParse({ sessionId: 's', text: '' }).success).toBe(false)
    expect(send.safeParse({ sessionId: 's', text: 'x'.repeat(32_769) }).success).toBe(false)
  })

  it('answerAskUserQuestion cannot express a payload-supplied answerer at all', () => {
    const parsed = sessionCommandPlane.defs.answerAskUserQuestion.input.parse({
      sessionId: 's',
      choices: [{ optionIndices: [1] }],
      humanQuestionAskedBy: 'someone-else',
      askedBy: 'someone-else',
    })

    // Stripped by the schema, so there is no field for a handler to trust and
    // none for a later edit to start trusting (ADR 3 D7.1).
    expect(parsed).toEqual({ sessionId: 's', choices: [{ optionIndices: [1] }] })
  })
})
