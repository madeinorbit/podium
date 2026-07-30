/**
 * The command-plane contract table (POD-381) — the facet invariants ADR 3 makes
 * derivable, enforced here rather than in review.
 */

import { describe, expect, it } from 'vitest'
import { commandExposure, isExposedOn } from './commands'
import {
  commandPlaneContract,
  commandPlaneNames,
  sessionCommandPlane,
} from './session-command-plane'

const defs = Object.entries(sessionCommandPlane.defs)

/**
 * The ONE command in this class that may be queued offline, and the only reason
 * it may. Named as a constant so the exemption below cannot silently grow: a
 * second offline-eligible execution command has to edit this line.
 */
const OFFLINE_ELIGIBLE_EXCEPTION = 'resumeAndSend'

describe('the command-plane table', () => {
  it('covers exactly the nine procs this issue migrates, and not handoff', () => {
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
    ])
    // POD-642's, and it must not drift into this table by accident.
    expect(commandPlaneContract('handoff')).toBeUndefined()
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

  it.each(defs)(
    '%s is not offline-enqueueable, the one documented exception aside (D18.3)',
    (key, def) => {
      if (key === OFFLINE_ELIGIBLE_EXCEPTION) {
        expect(def.offline).toBe('eligible')
        // An exception that is not argued is a mistake wearing a comment. The
        // decision record must name what overrode the blanket rule.
        expect(def.decision).toContain('oracle')
        return
      }
      expect(def.offline).not.toBe('eligible')
    },
  )

  it('the exemption list is exactly one command, and it is the one the outbox oracle covers', () => {
    const eligible = defs.filter(([, def]) => def.offline === 'eligible').map(([key]) => key)
    expect(eligible).toEqual([OFFLINE_ELIGIBLE_EXCEPTION])
    // sendText is the counterfactual the oracle draws in the same breath: same
    // shape, same substrate, deliberately NOT queued.
    expect(sessionCommandPlane.defs.sendText.offline).not.toBe('eligible')
  })

  it('exposure is per-command, not one blanket list', () => {
    // create is an operator seam; sendText is reachable by an agent at a peer.
    // If these were equal the exposure facet would be decorative.
    expect(isExposedOn(sessionCommandPlane.defs.create, 'relay')).toBe(false)
    expect(isExposedOn(sessionCommandPlane.defs.sendText, 'relay')).toBe(true)
    expect(isExposedOn(sessionCommandPlane.defs.create, 'trpc')).toBe(true)
    // No command-plane write is served on the raw websocket surface.
    for (const [, def] of defs) expect(isExposedOn(def, 'ws')).toBe(false)
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
