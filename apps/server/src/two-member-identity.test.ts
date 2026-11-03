/**
 * EVERY REQUEST ACTS AS THE PERSON WHO MADE IT (POD-6285; docs/design/
 * multi-user-instance.md §3.1, gap 6; acceptance row MU-02).
 *
 * Nothing stands in for "the first admin". Alice is the fixture's first admin,
 * so a path that falls back to the first admin attributes Bob's action to
 * Alice, which is what each test below would observe without the fix.
 *
 * Every write carries forged identity fields in its payload (a member, an owner
 * and an actor naming Alice). They must have no effect: the server reads the
 * caller from the transport, never from the payload.
 */

import { asIssueId, type IssueId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const ALICE = MEMBERS.alice.id
const BOB = MEMBERS.bob.id

/** The payload fields a forger would try: every name an identity goes by. */
const FORGED = {
  userId: ALICE,
  memberId: ALICE,
  ownerUserId: ALICE,
  onBehalfOf: ALICE,
  actor: { kind: 'user', id: ALICE },
  from: { kind: 'operator', attribution: { actor: { kind: 'user', id: ALICE }, onBehalfOf: ALICE } },
}

const storedAttribution = async (messageId: string) =>
  (await f.handle.registry.sessionStore.messages.getMessage(messageId))?.attribution

const latestMailOn = async (issueId: IssueId) => {
  const rows = await f.handle.registry.sessionStore.messages.listLedger({ issueId, limit: 50 })
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
}

describe('MU-02: issue mail is attributed to its sender on every transport', () => {
  it('control: Alice’s mail on her own task is Alice’s', async () => {
    const sent = (await (await f.as('alice')).trpc.issues.mailSend.mutate({
      id: f.tasks.alice,
      body: 'alice writes',
    } as never)) as { id: string }
    expect(await storedAttribution(sent.id)).toMatchObject({ onBehalfOf: ALICE })
  })

  it('tRPC over HTTP: Bob’s mail is Bob’s, whatever the payload claims', async () => {
    const sent = (await (await f.as('bob')).trpc.issues.mailSend.mutate({
      id: f.tasks.bob,
      body: 'bob writes',
      ...FORGED,
    } as never)) as { id: string }
    const attribution = await storedAttribution(sent.id)
    // Without the fix: the sender has no attribution, and the service stamped
    // the first admin, Alice.
    expect(attribution).toMatchObject({ actor: { kind: 'user', id: BOB }, onBehalfOf: BOB })
  })

  it('agent CLI over the daemon relay: Bob’s agent mails for Bob', async () => {
    const out = await f.agent(f.sessions.bob).cli(['mail', 'send', String(f.tasks.bob), '--body', 'bob agent writes'])
    const row = await latestMailOn(asIssueId(f.tasks.bob))
    expect(row?.body ?? '', out).toContain('bob agent writes')
    expect(row?.attribution).toMatchObject({ onBehalfOf: BOB })
    expect(row?.attribution?.actor).toMatchObject({ kind: 'agent', id: f.sessions.bob })
  })

  it('MCP over the daemon relay: Bob’s agent mails for Bob; forged fields are refused', async () => {
    const bobAgent = f.agent(f.sessions.bob)
    // The tool's argument schema is strict, so a forged identity is refused
    // outright rather than read.
    const forged = await bobAgent
      .mcp('issue_mail', { sub: 'send', ref: String(f.tasks.bob), body: 'forged', ...FORGED })
      .catch((error: unknown) => String(error))
    expect(forged).toMatch(/unrecognized|unknown|invalid/i)
    await bobAgent.mcp('issue_mail', { sub: 'send', ref: String(f.tasks.bob), body: 'bob agent via mcp' })
    const row = await latestMailOn(asIssueId(f.tasks.bob))
    expect(row?.body).toContain('bob agent via mcp')
    expect(row?.attribution).toMatchObject({ onBehalfOf: BOB })
  })
})

describe('a spawn uses its own person’s preferences (gap 6, settingsViewer)', () => {
  const spawnFrameFor = (machine: 'alice' | 'bob', sessionId: string) =>
    f
      .daemonFrames(f.machines[machine])
      .find(
        (frame): frame is Extract<typeof frame, { type: 'spawn' }> =>
          frame.type === 'spawn' && frame.sessionId === sessionId,
      )

  it('Bob’s spawn carries Bob’s subagent model, not Alice’s', async () => {
    const settings = f.handle.registry.modules.settings
    await settings.updatePreferences(ALICE, { 'roles.coding.subagentModel': 'alice-subagent' })
    await settings.updatePreferences(BOB, { 'roles.coding.subagentModel': 'bob-subagent' })

    const start = async (name: 'alice' | 'bob') =>
      (await (await f.as(name)).trpc.sessions.create.mutate({
        agentKind: 'claude-code',
        cwd: `/wt/${name}-prefs`,
        machineId: f.machines[name],
        issueId: f.tasks[name],
        ...FORGED,
      } as never)) as { sessionId: string }

    // Control: Alice's own spawn has always carried Alice's choice.
    const alice = await start('alice')
    expect(spawnFrameFor('alice', alice.sessionId)?.subagentModel).toBe('alice-subagent')

    // Without the fix the spawn read the first admin's (Alice's) preferences.
    const bob = await start('bob')
    expect(spawnFrameFor('bob', bob.sessionId)?.subagentModel).toBe('bob-subagent')
  })

  it('Bob’s issue session with no agent named takes Bob’s default harness', async () => {
    const settings = f.handle.registry.modules.settings
    // A coding role's harness is the one its native account names.
    await settings.updatePreferences(ALICE, { 'roles.coding.accountId': 'native:claude-code' })
    await settings.updatePreferences(BOB, { 'roles.coding.accountId': 'native:codex' })
    // The fixture's daemons advertise no terminal driver, so the start stops
    // right after it has chosen the harness, and the refusal names that harness.
    const added = (await f.as('bob')).trpc.issues.addSession.mutate({
      id: f.tasks.bob,
      ...FORGED,
    } as never)
    // Without the fix the issue start read the first admin's harness: claude-code.
    await expect(added).rejects.toThrow(/terminal runtime driver for codex$/)
  })
})

/**
 * Issue reads that embed sessions read them AS THE READER (POD-6285). Bob's
 * session on Alice's task is Bob's (POD-6283), so Alice's read of her own task
 * must not carry it. Without the fix these reads asked the session view with no
 * principal, which answers every session that has an owner.
 */
describe('issue reads embed only the sessions their reader may read', () => {
  const alice = async () => (await f.as('alice')).trpc
  const ids = (sessions: readonly { sessionId?: string; id?: string }[] | undefined) =>
    (sessions ?? []).map((session) => session.sessionId ?? session.id)

  it('issues.get', async () => {
    const issue = (await (await alice()).issues.get.query({ id: f.tasks.alice } as never)) as {
      sessions: { sessionId: string }[]
    }
    // Control: Alice's own session on her task is there.
    expect(ids(issue.sessions)).toContain(f.sessions.alice)
    expect(ids(issue.sessions)).not.toContain(f.sessions.bobOnAliceTask)
  })

  it('issues.tree', async () => {
    const tree = (await (await alice()).issues.tree.query({ id: f.tasks.alice } as never)) as {
      root: { sessions: { sessionId?: string; id?: string }[] }
    }
    expect(ids(tree.root.sessions)).toContain(f.sessions.alice)
    expect(ids(tree.root.sessions)).not.toContain(f.sessions.bobOnAliceTask)
  })

  it('issues.deck', async () => {
    const deck = JSON.stringify(await (await alice()).issues.deck.query({ id: f.tasks.alice } as never))
    expect(deck).not.toContain(f.sessions.bobOnAliceTask)
  })
})
