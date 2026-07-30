/**
 * THE OPERATOR CLASS, RESOLVED PER USER (POD-728 acceptance criterion 9).
 *
 * "Nothing still treats the string `operator` as an identity" is the criterion,
 * and each privilege the kind used to carry gets its own recorded policy and its
 * own assertion here: the unwrapped byte-faithful body, the brake exemptions,
 * the brake KEYS, the operator-addressed routing, and the rendered label.
 *
 * Every case that asserts a per-user answer is paired with a SECOND user, so
 * "distinct per user" is a claim about two different values rather than about
 * one value the test happened to be handed.
 */

import type { UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  deliversUnwrapped,
  exemptFromBrakes,
  isHumanPrincipal,
  type MailSenderPrincipal,
  operatorAddressee,
  senderBrakeKey,
  senderLabel,
} from './principal'

const ada = 'usr_ada' as UserId
const bo = 'usr_bo' as UserId

const human = (user: UserId | null): MailSenderPrincipal => ({ kind: 'operator', user })
const superagent = (user: UserId | null): MailSenderPrincipal => ({ kind: 'superagent', user })
const agent = (sessionId: string): MailSenderPrincipal => ({ kind: 'agent', user: ada, sessionId })
const system = (name: string): MailSenderPrincipal => ({ kind: 'system', user: null, name })

describe('who is a human', () => {
  it('a human principal is, and nothing else is', () => {
    expect(isHumanPrincipal(human(ada))).toBe(true)
    // The three non-human kinds, so the predicate is not vacuously true.
    expect(isHumanPrincipal(superagent(ada))).toBe(false)
    expect(isHumanPrincipal(agent('s1'))).toBe(false)
    expect(isHumanPrincipal(system('steward'))).toBe(false)
  })
})

describe('the unwrapped byte-faithful body belongs to a PERSON, not to a grade', () => {
  it('a human gets it', () => {
    expect(deliversUnwrapped(human(ada), 'message')).toBe(true)
  })

  it('a second human gets it too — it is not one privileged account', () => {
    expect(deliversUnwrapped(human(bo), 'message')).toBe(true)
  })

  it('a question is the one exception — its envelope constrains the answer', () => {
    expect(deliversUnwrapped(human(ada), 'question')).toBe(false)
  })

  it('a superagent does NOT get it: "you, automated" is not you typing', () => {
    expect(deliversUnwrapped(superagent(ada), 'message')).toBe(false)
    expect(deliversUnwrapped(agent('s1'), 'message')).toBe(false)
  })
})

describe('the wake-cooldown and spawn-budget exemptions attach to a human', () => {
  it('exempts a human, and a second human', () => {
    expect(exemptFromBrakes(human(ada))).toBe(true)
    expect(exemptFromBrakes(human(bo))).toBe(true)
  })

  it('does NOT exempt the superagent — it is exactly the unattended loop the brakes exist for', () => {
    expect(exemptFromBrakes(superagent(ada))).toBe(false)
  })

  it('does not exempt an agent or a system job', () => {
    expect(exemptFromBrakes(agent('s1'))).toBe(false)
    expect(exemptFromBrakes(system('steward'))).toBe(false)
  })
})

describe('the brake bucket is re-keyed per user', () => {
  it('two superagents on different humans get DIFFERENT buckets', () => {
    // The defect this closes: one shared `superagent` bucket lets one person's
    // superagent throttle another's — a cross-user denial of service with no
    // error message, because a throttled wake looks exactly like a quiet one.
    expect(senderBrakeKey(superagent(ada))).not.toBe(senderBrakeKey(superagent(bo)))
    expect(senderBrakeKey(superagent(ada))).toBe(`superagent:${ada}`)
  })

  it('two humans get DIFFERENT buckets', () => {
    expect(senderBrakeKey(human(ada))).not.toBe(senderBrakeKey(human(bo)))
  })

  it('degenerates to today’s bare kind when no user is resolvable', () => {
    // Why this is safe to land before the User aggregate: with no user the key
    // is byte-identical to the shipped one, so the cooldown behaves as it does
    // today rather than being silently re-partitioned.
    expect(senderBrakeKey(human(null))).toBe('operator')
    expect(senderBrakeKey(superagent(null))).toBe('superagent')
  })

  it('leaves the kinds that were ALREADY per-principal alone', () => {
    expect(senderBrakeKey(agent('s1'))).toBe('agent:s1')
    expect(senderBrakeKey(agent('s2'))).toBe('agent:s2')
    expect(senderBrakeKey(system('steward'))).toBe('system:steward')
  })
})

describe('an operator-ADDRESSED row resolves to a specific human', () => {
  it('comes back to the human whose thread it is', () => {
    expect(operatorAddressee(human(ada))).toBe(ada)
    expect(operatorAddressee(human(bo))).toBe(bo)
  })

  it('a superagent’s reply reaches ITS human, not a shared box', () => {
    expect(operatorAddressee(superagent(ada))).toBe(ada)
  })

  it('a system job gets NO human — D21.2 forbids assigning it one', () => {
    // Not a fallback: nobody is accountable for a steward's notice, and naming
    // someone would make the product lie about who acted.
    expect(operatorAddressee({ kind: 'system', user: ada, name: 'steward' })).toBeNull()
  })

  it('is the shared box only while no user is resolvable', () => {
    expect(operatorAddressee(human(null))).toBeNull()
  })
})

describe('the rendered label names a person', () => {
  const names: Record<string, string> = { [ada]: 'Ada', [bo]: 'Bo' }
  const displayName = (u: UserId): string | null => names[u] ?? null

  it('renders the human’s name, and a different one for a different human', () => {
    expect(senderLabel(human(ada), displayName)).toBe('Ada')
    expect(senderLabel(human(bo), displayName)).toBe('Bo')
  })

  it('attributes a superagent to its person', () => {
    expect(senderLabel(superagent(ada), displayName)).toBe("Ada's superagent")
  })

  it('falls back to the role wording only when there is no person to name', () => {
    expect(senderLabel(human(null), displayName)).toBe('the operator')
    expect(senderLabel(superagent(null), displayName)).toBe('the superagent')
  })
})
