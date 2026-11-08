/**
 * WHO MAY DECIDE AN APPROVAL (POD-6674 review): the operation's own permission,
 * per kind, and the request's person.
 */

import { asMachineId, asSessionId, asUserId, type SessionId } from '@podium/model'
import type { ApprovalEffectInput, ApprovalOp } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { type ApprovalOpPermissionDeps, isRequestPerson, mayRunApprovalOp } from './op-permission'

const ADMIN = userCommandPrincipal(asUserId('user:admin'), 'admin')
const MEMBER = userCommandPrincipal(asUserId('user:member'), 'member')
const ASKING = asSessionId('s-asks')

function deps(
  grants: { manages?: string[]; writesRevision?: string[]; owners?: Record<string, string> } = {},
): ApprovalOpPermissionDeps {
  const userOf = (p: CommandPrincipal) => (p.kind === 'user' ? p.user : '')
  return {
    machineVerb: async (p, machineId) =>
      (grants.manages ?? []).includes(`${userOf(p)}@${machineId}`),
    workflowWrite: async (p, revisionId) =>
      (grants.writesRevision ?? []).includes(`${userOf(p)}@${revisionId}`),
    sessionOwner: async (sessionId: SessionId) =>
      grants.owners?.[sessionId] === undefined ? undefined : asUserId(grants.owners[sessionId]!),
  }
}

const asked = (op: ApprovalOp): ApprovalEffectInput => ({
  op,
  machineId: asMachineId('m1'),
  sessionId: ASKING,
  issueId: null,
})

describe('the operation decides who may run it', () => {
  it('a software update, a channel switch and a server move are an admin’s', async () => {
    for (const op of [
      { kind: 'update' },
      { kind: 'channel', target: 'dev' },
      { kind: 'set-server', target: 'https://elsewhere.example' },
    ] as ApprovalOp[]) {
      expect(await mayRunApprovalOp(deps(), ADMIN, asked(op)), op.kind).toBe(true)
      expect(await mayRunApprovalOp(deps(), MEMBER, asked(op)), op.kind).toBe(false)
    }
  })

  it('a stop needs manage on the machine it stops, whatever the role', async () => {
    const op = asked({ kind: 'stop' })
    expect(await mayRunApprovalOp(deps({ manages: ['user:member@m1'] }), MEMBER, op)).toBe(true)
    expect(await mayRunApprovalOp(deps({ manages: ['user:member@m2'] }), MEMBER, op)).toBe(false)
    expect(await mayRunApprovalOp(deps(), ADMIN, op)).toBe(false)
  })

  it('a workflow publish or default needs write on the revision’s workflow', async () => {
    const grant = deps({ writesRevision: ['user:member@rev_1'] })
    for (const op of [
      { kind: 'workflow-publish', revisionId: 'rev_1' },
      {
        kind: 'workflow-set-default',
        targetKind: 'repository',
        targetId: '/r',
        revisionId: 'rev_1',
      },
    ] as ApprovalOp[]) {
      expect(await mayRunApprovalOp(grant, MEMBER, asked(op)), op.kind).toBe(true)
      expect(await mayRunApprovalOp(grant, ADMIN, asked(op)), op.kind).toBe(false)
    }
  })

  it('a scheduled continuation resumes only a session of the decider’s own', async () => {
    const schedule = (target: object) =>
      asked({
        kind: 'automation-schedule',
        name: 'later',
        runAt: '2099-01-01T00:00:00.000Z',
        prompt: 'go on',
        target,
      } as ApprovalOp)
    const owners = deps({ owners: { 's-asks': 'user:member', 's-other': 'user:admin' } })
    expect(await mayRunApprovalOp(owners, MEMBER, schedule({ kind: 'current' }))).toBe(true)
    expect(
      await mayRunApprovalOp(owners, MEMBER, schedule({ kind: 'session', sessionId: 's-other' })),
    ).toBe(false)
    expect(
      await mayRunApprovalOp(owners, MEMBER, schedule({ kind: 'fresh', repoPath: '/r' })),
    ).toBe(true)
  })

  it('an operation this table does not know is an admin’s', async () => {
    const unknown = asked({ kind: 'from-a-newer-agent' } as unknown as ApprovalOp)
    expect(await mayRunApprovalOp(deps(), ADMIN, unknown)).toBe(true)
    expect(await mayRunApprovalOp(deps(), MEMBER, unknown)).toBe(false)
  })
})

describe('the request’s person', () => {
  it('is the asking session’s owner; another member, even an admin, is not', () => {
    expect(isRequestPerson(MEMBER, asUserId('user:member'))).toBe(true)
    expect(isRequestPerson(ADMIN, asUserId('user:member'))).toBe(false)
    expect(isRequestPerson(MEMBER, null)).toBe(false)
  })
})
