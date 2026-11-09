/**
 * PRIVATE RESOURCES ARE THEIR OWNER'S (POD-6284; docs/design/multi-user-instance.md
 * §2.3, §4.1 "Private" row, gaps 2 and 4; acceptance rows MU-08 and MU-16).
 *
 * Session and worktree file bytes, transcripts, search, approvals, superagent
 * session tools, mail and automations answer only to the person they belong to.
 * The admin role adds nothing here: Alice is the admin, and every refusal below
 * that names Alice is the "including an admin" half of MU-08.
 *
 * Each refusal sits beside a CONTROL: the same call, through the same helper,
 * by the owner, answered. A refusal-only test cannot tell a working gate from a
 * broken fixture.
 *
 * Where the caller may not know the resource exists, the refusal must look
 * like absence: those tests compare the answer for somebody else's resource
 * with the answer for one that does not exist.
 *
 * Task artifacts are the opposite case (D4): they belong to the shared task,
 * so every active member reads them, and nobody else does.
 *
 * One fixture gap shapes the session cases: until POD-6283, a session on
 * Alice's task is recorded as Alice's (`two-member-gaps.test.ts`, gap 3), so
 * these tests use each member's session on their OWN task, where the recorded
 * owner is already right.
 */

import {
  actorAgent,
  asAgentIdentityId,
  asArtifactId,
  asSessionId,
  type SessionId,
  subscriptionRowIdOf,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSuperagentTools } from './modules/superagent/tools'
import { fileApproval } from './test-support/approvals'
import {
  MEMBERS,
  type MemberName,
  REPO_PATH,
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

const trpc = async (name: MemberName) => (await f.as(name)).trpc
const registry = () => f.handle.registry
const store = () => registry().sessionStore

/** The file paths the server asked a machine's daemon for, so a refusal can be
 *  shown to have never reached the machine. */
const askedPaths = (machine: 'alice' | 'bob') =>
  f
    .daemonFrames(f.machines[machine])
    .flatMap((frame) =>
      frame.type === 'fileAssetRequest' || frame.type === 'fileReadRequest' ? [frame.path] : [],
    )

/** A task grant from Alice to Bob, the way sharing a task wrote one. It must open
 *  nothing private: sessions are never readable through their task. */
const withTaskGrantToBob = async (run: () => Promise<void>) => {
  const grants = store().grants
  await grants.upsert({
    resourceKind: 'issue',
    resourceId: f.tasks.alice,
    grantee: MEMBERS.bob.id,
    verb: 'read',
    owner: MEMBERS.alice.id,
    visibility: 'shared',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: MEMBERS.alice.id,
    onBehalfOf: MEMBERS.alice.id,
  })
  try {
    await run()
  } finally {
    await grants.remove('issue', f.tasks.alice, MEMBERS.bob.id, 'read')
  }
}

describe('MU-08: session and worktree file bytes are the owner’s', () => {
  const assetUrl = (params: Record<string, string>) =>
    `/files/asset?${new URLSearchParams(params).toString()}`

  it('control: Bob downloads a file of his own session', async () => {
    const response = await (await f.as('bob')).fetch(
      assetUrl({ sessionId: f.sessions.bob, path: 'own-session.txt' }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fixture bytes of own-session.txt')
  })

  it('admin Alice gets a not-found for a file of Bob’s session, and his machine is never asked', async () => {
    const response = await (await f.as('alice')).fetch(
      assetUrl({ sessionId: f.sessions.bob, path: 'admin-probe.txt' }),
    )
    expect(response.status).toBe(404)
    const missing = await (await f.as('alice')).fetch(
      assetUrl({ sessionId: 'no-such-session', path: 'admin-probe.txt' }),
    )
    expect(missing.status).toBe(404)
    expect(await response.text()).toBe(await missing.text())
    expect(askedPaths('bob')).not.toContain('admin-probe.txt')
  })

  it('control: Bob downloads a file of a checkout on his own machine', async () => {
    const response = await (await f.as('bob')).fetch(
      assetUrl({ root: REPO_PATH, machineId: f.machines.bob, path: 'own-root.txt' }),
    )
    expect(response.status).toBe(200)
  })

  it('admin Alice cannot download from a checkout on Bob’s machine', async () => {
    const response = await (await f.as('alice')).fetch(
      assetUrl({ root: REPO_PATH, machineId: f.machines.bob, path: 'admin-root-probe.txt' }),
    )
    expect(response.status).toBe(404)
    expect(askedPaths('bob').some((path) => path.endsWith('admin-root-probe.txt'))).toBe(false)
  })

  it('control: Bob reads his own session’s file over tRPC', async () => {
    const read = await (await trpc('bob')).files.read.query({
      sessionId: f.sessions.bob,
      path: 'trpc-own.txt',
    })
    expect(read).toMatchObject({ ok: true, content: 'fixture text of trpc-own.txt' })
  })

  it('admin Alice cannot read, list or search Bob’s session or machine files over tRPC', async () => {
    const alice = await trpc('alice')
    await expect(
      alice.files.read.query({ sessionId: f.sessions.bob, path: 'trpc-probe.txt' }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
    await expect(
      alice.files.read.query({ root: REPO_PATH, machineId: f.machines.bob, path: 'trpc-root.txt' }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
    await expect(
      alice.files.list.query({ root: REPO_PATH, machineId: f.machines.bob } as never),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
    expect(askedPaths('bob')).not.toContain('trpc-probe.txt')
  })
})

describe('MU-08: transcripts are the owner’s, and a task grant opens none', () => {
  const transcript = async (name: MemberName, sessionId: SessionId) =>
    await (await trpc(name)).sessions.transcriptRead.query({
      sessionId,
      direction: 'before',
      limit: 10,
    })

  const texts = (slice: { items: Array<{ text?: string }> }) => slice.items.map((item) => item.text)

  it('control: each member reads their own session’s transcript', async () => {
    expect(texts(await transcript('bob', f.sessions.bob))).toEqual([
      `fixture transcript of ${f.sessions.bob}`,
    ])
    expect(texts(await transcript('alice', f.sessions.alice))).toEqual([
      `fixture transcript of ${f.sessions.alice}`,
    ])
  })

  it('admin Alice gets a not-found for Bob’s transcript', async () => {
    await expect(transcript('alice', f.sessions.bob)).rejects.toThrow(/NOT_FOUND/)
  })

  it('Bob holding a grant on Alice’s task still cannot read her session there', async () => {
    await withTaskGrantToBob(async () => {
      await expect(transcript('bob', f.sessions.alice)).rejects.toThrow(/NOT_FOUND/)
      await expect(
        (await trpc('bob')).sessions.read.query({ sessionId: f.sessions.alice }),
      ).rejects.toThrow(/NOT_FOUND/)
      await expect(
        (await trpc('bob')).files.read.query({ sessionId: f.sessions.alice, path: 'grant.txt' }),
      ).rejects.toThrow(/NOT_FOUND|not found/i)
    })
  })
})

describe('MU-08: search returns only the caller’s own sessions', () => {
  const sessionHits = async (name: MemberName, text: string) =>
    ((await (await trpc(name)).search.query.query({ text })) as Array<{ kind: string; id: string }>)
      .filter((hit) => hit.kind === 'session')
      .map((hit) => hit.id)

  it('control: Bob finds his own session by title', async () => {
    expect(await sessionHits('bob', 'bob-own')).toContain(f.sessions.bob)
  })

  it('admin Alice does not find Bob’s session', async () => {
    expect(await sessionHits('alice', 'bob-own')).not.toContain(f.sessions.bob)
  })

  it('a grant on Alice’s task does not put her session in Bob’s results', async () => {
    await withTaskGrantToBob(async () => {
      expect(await sessionHits('bob', 'alice-own')).not.toContain(f.sessions.alice)
    })
  })
})

describe('MU-08: an approval is routed to who may decide it, and decided by them only', () => {
  /** Bob may manage his own machine, so he may decide its `stop`. */
  const request = async (sessionId: SessionId, machine: 'alice' | 'bob', op: object = { kind: 'stop' }) =>
    await fileApproval(registry(), { op, sessionId, machineId: f.machines[machine] })
  /** A record as a request filed before a grant or role moved would have left it. */
  const filedEarlier = async (sessionId: SessionId, machine: 'alice' | 'bob', person: string, op: object) => {
    const id = `apr_${crypto.randomUUID()}`
    await store().effects.insert(
      fixtureWriteScope(),
      {
        id,
        kind: 'approval',
        target: { kind: 'session', id: sessionId },
        input: { op, machineId: f.machines[machine], sessionId, issueId: null },
        deadlineAt: undefined,
        createdBy: person as never,
        actor: `session:${sessionId}`,
        gated: true,
        stage: 'awaiting-approval',
      },
      Date.now(),
    )
    return id
  }
  /** A decision as the app sends it, over the member's own `sync.submit`. */
  const decide = async (name: MemberName, id: string, decision: 'approve' | 'deny') => {
    const shown = await store().effects.get(id)
    const reply = (await (await trpc(name)).sync.submit.mutate({
      mutationId: `m-${crypto.randomUUID()}`,
      command: 'records.effect.edit',
      version: 1,
      input: { id, patch: { decision }, expectedRevision: shown?.revision ?? 1 },
    } as never)) as { outcome: string; refusal?: { kind: string } }
    return reply.outcome === 'rejected' ? `rejected:${reply.refusal?.kind}` : reply.outcome
  }
  it('a request is routed to its owner when they may run it, and a missing one refuses like a forbidden one', async () => {
    const bobs = await request(f.sessions.bob, 'bob')
    // Bob manages his own machine, so its stop is routed to him alone.
    expect((await store().effects.get(bobs.id))?.deciders).toEqual([MEMBERS.bob.id])
    // Not one of its people and no admin: the same answer as an unknown record.
    for (const decision of ['approve', 'deny'] as const) {
      expect(await decide('bob', 'apr_missing', decision)).toMatch(/^rejected:/)
    }
    expect((await store().effects.get(bobs.id))?.decision).toBe('awaiting')
    // Control: Bob decides his own.
    expect(await decide('bob', bobs.id, 'deny')).toBe('applied')
    expect((await store().effects.get(bobs.id))?.status).toBe('cancelled')
  })

  it('the record reaches its person, and others only as readers of the requesting task', async () => {
    const aliceFeed = await (await f.as('alice')).feed()
    const bobFeed = await (await f.as('bob')).feed()
    try {
      const bobs = await request(f.sessions.bob, 'bob')
      const record = await store().effects.get(bobs.id)
      // Routed to Bob, the owner of the asking session.
      expect(record?.createdBy).toBe(MEMBERS.bob.id)
      const effectIds = (feed: typeof bobFeed) =>
        feed
          .deltas()
          .filter((change) => change.entity === 'effect')
          .map((change) => change.entityId)
      await bobFeed.until(() => effectIds(bobFeed).includes(bobs.id))
      // Routed to Bob alone: Alice receives it only if she may read the task it
      // was asked on (design 1.8).
      const target = record?.target
      const aliceReads =
        target?.kind === 'issue' &&
        (await (await trpc('alice')).issues.get.query({ id: target.id } as never).then(
          () => true,
          () => false,
        ))
      if (aliceReads) await aliceFeed.until(() => effectIds(aliceFeed).includes(bobs.id))
      else expect(effectIds(aliceFeed)).not.toContain(bobs.id)
    } finally {
      aliceFeed.close()
      bobFeed.close()
    }
  })

  // The decider must also hold the operation's own permission (POD-6674 review).
  it('a member’s agent asks for a server update: an admin is offered it and approves it, the member is not and cannot', async () => {
    const aliceFeed = await (await f.as('alice')).feed()
    try {
      const bobs = await request(f.sessions.bob, 'bob', { kind: 'update' })
      const record = await store().effects.get(bobs.id)
      // Bob may not run a server update, so it is routed to the admins who may.
      expect(record?.createdBy).toBe(MEMBERS.bob.id)
      expect(record?.deciders).toEqual([MEMBERS.alice.id])
      // Alice receives it though she may not read Bob's session or task.
      await aliceFeed.until(() =>
        aliceFeed
          .deltas()
          .some((change) => change.entity === 'effect' && change.entityId === bobs.id),
      )
      expect(await decide('bob', bobs.id, 'approve')).toMatch(/^rejected:/)
      expect((await store().effects.get(bobs.id))?.decision).toBe('awaiting')
      expect(await decide('alice', bobs.id, 'approve')).toBe('applied')
      expect((await store().effects.get(bobs.id))?.decision).toBe('approve')
    } finally {
      aliceFeed.close()
    }
  })

  it('the decision is checked live: its person may not decide what they may not run', async () => {
    // Filed when Bob could (say, before a role change), still routed to him.
    const id = await filedEarlier(f.sessions.bob, 'bob', MEMBERS.bob.id, { kind: 'update' })
    expect(await decide('bob', id, 'approve')).toMatch(/^rejected:/)
    expect((await store().effects.get(id))?.decision).toBe('awaiting')
  })

  it('an admin approves a server update their own agent asked for', async () => {
    const alices = await request(f.sessions.alice, 'alice', { kind: 'update' })
    expect(await decide('alice', alices.id, 'approve')).toBe('applied')
    expect((await store().effects.get(alices.id))?.decision).toBe('approve')
  })

  it('a machine manager approves a stop on that machine', async () => {
    const bobs = await request(f.sessions.bob, 'bob', { kind: 'stop' })
    expect(await decide('bob', bobs.id, 'approve')).toBe('applied')
    expect((await store().effects.get(bobs.id))?.decision).toBe('approve')
  })
})

describe('MU-08: superagent session tools reach only the thread owner’s sessions', () => {
  const toolsFor = async (owner: MemberName) => {
    const threadId = `thr_fixture_${owner}`
    await store().superagent.upsertSuperagentThread({
      id: threadId,
      ownerUserId: MEMBERS[owner].id,
      kind: 'btw',
    })
    const tools = await buildSuperagentTools(
      {
        modules: registry().modules,
        repos: { list: async () => [REPO_PATH] },
        store: store(),
        waitPollMs: 10,
      },
      '',
      threadId as never,
    )
    return async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find((candidate) => candidate.spec.name === name)
      if (!tool) throw new Error(`no tool ${name}`)
      return await tool.run(args as never)
    }
  }

  it('list_sessions lists only the owner’s sessions', async () => {
    const alice = await toolsFor('alice')
    const listed = JSON.parse(await alice('list_sessions')) as Array<{ sessionId: string }>
    const ids = listed.map((row) => row.sessionId)
    expect(ids).toContain(f.sessions.alice)
    expect(ids).not.toContain(f.sessions.bob)
  })

  it('Alice’s thread cannot read, recap, rename or stop Bob’s session; it can reach her own', async () => {
    const alice = await toolsFor('alice')
    const unknown = await alice('rename_session', { sessionId: 'no-such-session', name: 'x' })
    expect(unknown).toBe('unknown session')
    for (const [tool, args] of [
      ['read_session_transcript', {}],
      ['recap_session', {}],
      ['rename_session', { name: 'renamed by alice' }],
      ['set_work_state', { workState: 'done' }],
      ['snooze_session', { until: 'next-message' }],
      ['wait_for_session', { timeoutSeconds: 0 }],
      ['hibernate_session', {}],
      ['kill_session', {}],
      ['send_to_agent', { text: 'hi' }],
    ] as const) {
      expect(await alice(tool, { sessionId: f.sessions.bob, ...args }), tool).toBe(
        'unknown session',
      )
    }
    const bobRow = await store().sessions.getSession(f.sessions.bob)
    expect(bobRow?.name ?? null).not.toBe('renamed by alice')
    // Control: her own session answers.
    expect(
      await alice('rename_session', { sessionId: f.sessions.alice, name: 'alice renamed' }),
    ).toBe('renamed')
  })
})

describe('Bob cannot read Alice’s superagent threads', () => {
  it('her thread is absent from his list and his reads', async () => {
    const threadId = 'thr_alice_private'
    await store().superagent.upsertSuperagentThread({
      id: threadId,
      ownerUserId: MEMBERS.alice.id,
      kind: 'btw',
    })
    await store().superagent.appendSuperagentMessage(threadId as never, {
      role: 'user',
      content: 'alice’s private thought',
    })
    const alice = await trpc('alice')
    const bob = await trpc('bob')
    // Control: Alice reads her own thread.
    const own = await alice.superagent.history.query({ threadId: threadId as never })
    expect(own.map((row) => row.content)).toContain('alice’s private thought')
    // The thread list is a synced record delivered to its owner alone
    // (`superagentThread`, per-user-state, POD-6675): thread-records.test.ts.
    await expect(bob.superagent.history.query({ threadId: threadId as never })).rejects.toThrow(
      /unknown thread/,
    )
    await expect(
      bob.superagent.history.query({ threadId: 'thr_does_not_exist' as never }),
    ).rejects.toThrow(/unknown thread/)
  })
})

describe('mail and inbox reads return only the caller’s own mail', () => {
  /** Bob's agent asks "the operator": that is Bob, and nobody else. */
  const bobsAgentAsksItsHuman = async (body: string) =>
    (
      await registry().modules.messages.send(
        registry().issues.reports.store.serverWriter,
        {
          kind: 'agent',
          issueId: f.tasks.bob,
          sessionId: f.sessions.bob,
          attribution: {
            actor: actorAgent(asAgentIdentityId(`session:${f.sessions.bob}`)),
            onBehalfOf: MEMBERS.bob.id,
          },
        },
        { to: { kind: 'operator' }, body },
      )
    ).message.id

  const inboxBodies = async (name: MemberName) =>
    ((await (await trpc(name)).messages.inbox.mutate({})) as Array<{ body: string }>).map(
      (row) => row.body,
    )

  it('Bob’s agent’s question reaches Bob’s inbox and not admin Alice’s', async () => {
    await bobsAgentAsksItsHuman('bob, please look')
    expect(await inboxBodies('bob')).toContain('bob, please look')
    expect(await inboxBodies('alice')).not.toContain('bob, please look')
  })

  it('admin Alice can neither open it, nor see it in the ledger, nor clear it', async () => {
    const id = await bobsAgentAsksItsHuman('private to bob')
    const alice = await trpc('alice')
    const bob = await trpc('bob')
    // Control: Bob opens it and finds it in his session's ledger.
    await expect(bob.messages.show.query({ id })).resolves.toMatchObject({ body: 'private to bob' })
    const ledgerIds = async (who: typeof alice) =>
      (
        (await who.messages.ledger.query({ sessionId: f.sessions.bob })) as Array<{ id: string }>
      ).map((row) => row.id)
    expect(await ledgerIds(bob)).toContain(id)
    await expect(alice.messages.show.query({ id })).rejects.toThrow()
    await expect(alice.messages.status.query({ id })).rejects.toThrow()
    expect(await ledgerIds(alice)).not.toContain(id)
    await expect(alice.messages.dismiss.mutate({ id })).rejects.toThrow(/only the recipient/)
    await expect(bob.messages.dismiss.mutate({ id })).resolves.toMatchObject({ id })
  })
})

describe('usage and plan quota are read by the people who run on the machine', () => {
  it('the answering machine’s token usage goes to its user only, and the other is never asked', async () => {
    const answering = await registry().modules.machines.defaultMachine()
    const [user, other] = (
      answering === f.machines.alice ? ['alice', 'bob'] : ['bob', 'alice']
    ) as [MemberName, MemberName]
    const usageAsks = () =>
      f.daemonFrames(answering).filter((frame) => frame.type === 'usageRequest').length
    // Control: the machine's own user gets its buckets.
    expect(await (await trpc(user)).usage.summary.query()).toMatchObject({ hostname: answering })
    const before = usageAsks()
    expect(await (await trpc(other)).usage.summary.query()).toEqual({ hostname: '', buckets: [] })
    expect(usageAsks()).toBe(before)
  })

  it('each member sees the plan quota of their own machine only', async () => {
    const machines = async (name: MemberName) =>
      ((await (await trpc(name)).quota.summary.query()) as Array<{ machineId: string }>).map(
        (row) => row.machineId,
      )
    expect(await machines('alice')).toEqual([f.machines.alice])
    expect(await machines('bob')).toEqual([f.machines.bob])
  })
})

describe('MU-16: an automation is its owner’s for read, edit, run and transfer', () => {
  const create = async (owner: MemberName, over: Record<string, unknown> = {}) =>
    (await (
      await trpc(owner)
    ).automations.create.mutate({
      name: `${owner}'s nightly`,
      cron: '0 3 * * *',
      agentKind: 'claude-code',
      prompt: 'tidy up',
      ...over,
    } as never)) as { id: string; ownerUserId: string }

  it('Bob’s automation is invisible to admin Alice and refuses her edits like a missing one', async () => {
    const automation = await create('bob')
    const alice = await trpc('alice')
    const bob = await trpc('bob')
    // Control: the owner reads and edits it.
    expect((await bob.automations.list.query()).map((row) => row.id)).toContain(automation.id)
    await bob.automations.update.mutate({
      id: automation.id,
      patch: { name: 'renamed by bob' },
    } as never)

    expect((await alice.automations.list.query()).map((row) => row.id)).not.toContain(automation.id)
    expect(await alice.automations.runs.query({ automationId: automation.id })).toEqual([])

    const missing = 'aut_no_such_automation'
    const message = async (call: () => Promise<unknown>) =>
      await call().then(
        () => 'resolved',
        (error: Error) =>
          error.message.replaceAll(automation.id, '<id>').replaceAll(missing, '<id>'),
      )
    for (const attempt of [
      (id: string) => alice.automations.update.mutate({ id, patch: { name: 'alice' } } as never),
      (id: string) => alice.automations.setEnabled.mutate({ id, enabled: true } as never),
    ]) {
      const refused = await message(() => attempt(automation.id))
      expect(refused).not.toBe('resolved')
      expect(refused).toBe(await message(() => attempt(missing)))
    }
    // Removing it answers exactly like removing one that does not exist.
    expect(
      await message(() => alice.automations.remove.mutate({ id: automation.id } as never)),
    ).toBe(await message(() => alice.automations.remove.mutate({ id: missing } as never)))
    expect((await bob.automations.list.query()).map((row) => row.id)).toContain(automation.id)
  })

  it('nobody can hand an automation to someone else by editing its owner', async () => {
    const automation = await create('alice')
    await (await trpc('alice')).automations.update.mutate({
      id: automation.id,
      patch: { ownerUserId: MEMBERS.bob.id, name: 'still alice’s' },
    } as never)
    const row = await store().automations.get(automation.id)
    expect(row?.ownerUserId).toBe(MEMBERS.alice.id)
    expect((await (await trpc('bob')).automations.list.query()).map((r) => r.id)).not.toContain(
      automation.id,
    )
  })

  it('an automation can run only into its owner’s own sessions', async () => {
    // Control: Bob may aim his automation at his own session.
    await expect(create('bob', { targetSessionId: f.sessions.bob })).resolves.toMatchObject({
      ownerUserId: MEMBERS.bob.id,
    })
    // Aiming it at Alice's session answers like aiming at one that does not exist.
    const refused = await create('bob', { targetSessionId: f.sessions.alice }).then(
      () => 'resolved',
      (error: Error) => error.message.replaceAll(f.sessions.alice, '<id>'),
    )
    const absent = await create('bob', { targetSessionId: asSessionId('no-such-session') }).then(
      () => 'resolved',
      (error: Error) => error.message.replaceAll('no-such-session', '<id>'),
    )
    expect(refused).not.toBe('resolved')
    expect(refused).toBe(absent)
    const own = await create('bob')
    await expect(
      (await trpc('bob')).automations.update.mutate({
        id: own.id,
        patch: { targetSessionId: f.sessions.alice },
      } as never),
    ).rejects.toThrow(/unknown session/)
  })
})

describe('task artifacts belong to the shared task (D4)', () => {
  const upload = async (task: 'alice' | 'bob') =>
    await registry().modules.issueArtifacts.upload({
      issueId: f.tasks[task],
      filename: `${task}-notes.txt`,
      dataBase64: Buffer.from(`${task}'s notes`).toString('base64'),
    })
  const artifactPath = (task: 'alice' | 'bob', artifactId: string) =>
    `/files/artifact/${f.tasks[task]}/${asArtifactId(artifactId)}/${task}-notes.txt`

  it('Alice and Bob each download the other’s task artifacts', async () => {
    const alices = await upload('alice')
    const bobs = await upload('bob')
    const fromBob = await (await f.as('bob')).fetch(artifactPath('alice', alices.artifactId))
    expect(fromBob.status).toBe(200)
    expect(await fromBob.text()).toBe("alice's notes")
    const fromAlice = await (await f.as('alice')).fetch(artifactPath('bob', bobs.artifactId))
    expect(fromAlice.status).toBe(200)
    expect(await fromAlice.text()).toBe("bob's notes")
  })

  it('an unauthenticated caller and disabled Carol cannot', async () => {
    const alices = await upload('alice')
    const anonymous = await fetch(new URL(artifactPath('alice', alices.artifactId), f.origin))
    expect(anonymous.status).toBe(401)
    // Carol holds a password but no sign-in: disabling her ended every one.
    expect((await f.login('carol')).ok).toBe(false)
    expect(await store().auth.listClientSessionsOfUser(MEMBERS.carol.id)).toEqual([])
  })
})

/**
 * NO ADMIN REACH OVER A PERSON'S MAIL OR SUBSCRIPTIONS (POD-6288, design §4.1).
 * Mail is private and subscriptions are per-user state: replying to Bob's
 * agent, reading its mail to his task, or subscribing his session to events is
 * driving Bob's agent, which admin Alice may not do.
 */
describe('admin Alice gets no reach over Bob’s mail or subscriptions', () => {
  /** Bob's agent mails `to` on Bob's behalf. */
  const bobsAgentMails = async (to: { kind: 'operator' } | { kind: 'issue'; id: string }, body: string) =>
    (
      await registry().modules.messages.send(
        registry().issues.reports.store.serverWriter,
        {
          kind: 'agent',
          issueId: f.tasks.bob,
          sessionId: f.sessions.bob,
          attribution: {
            actor: actorAgent(asAgentIdentityId(`session:${f.sessions.bob}`)),
            onBehalfOf: MEMBERS.bob.id,
          },
        },
        { to, body },
      )
    ).message.id

  it('Alice cannot reply to a message Bob’s agent sent to Bob; Bob can', async () => {
    const id = await bobsAgentMails({ kind: 'operator' }, 'bob, a question for you')
    await expect(
      (await trpc('alice')).messages.reply.mutate({ id, body: 'alice answers' } as never),
    ).rejects.toThrow(/only the recipient/)
    await expect(
      (await trpc('bob')).messages.reply.mutate({ id, body: 'bob answers' } as never),
    ).resolves.toMatchObject({ ok: true })
  })

  it('Alice’s peek at Bob’s task mailbox shows none of Bob’s agent’s mail; Bob’s shows it', async () => {
    await bobsAgentMails({ kind: 'issue', id: f.tasks.bob }, 'mail to bob’s task')
    const bodies = async (name: MemberName) => ({
      inbox: (
        (await (await trpc(name)).messages.inbox.mutate({ issue: f.tasks.bob } as never)) as Array<{
          body: string
        }>
      ).map((row) => row.body),
      taskMailbox: (
        (await (await trpc(name)).issues.mailInbox.mutate({ id: f.tasks.bob } as never)) as Array<{
          body: string
        }>
      ).map((row) => row.body),
    })
    const bob = await bodies('bob')
    expect(bob.inbox).toContain('mail to bob’s task')
    expect(bob.taskMailbox).toContain('mail to bob’s task')
    const alice = await bodies('alice')
    expect(alice.inbox).not.toContain('mail to bob’s task')
    expect(alice.taskMailbox).not.toContain('mail to bob’s task')
  })

  it('Alice can neither add, list, toggle nor remove a subscription for Bob’s session; Bob can', async () => {
    const alice = (await trpc('alice')).issues
    const bob = (await trpc('bob')).issues
    const forBob = {
      event: 'issue.closed',
      source: { kind: 'relationship', ref: 'children' },
      subscriber: { kind: 'session', id: f.sessions.bob },
    }
    await expect(alice.subscriptionAdd.mutate(forBob as never)).rejects.toThrow(
      /only your own sessions/,
    )
    // Control, and the Automations UI path: Bob names his own session.
    const sub = (await bob.subscriptionAdd.mutate(forBob as never)) as {
      id: string
      subscriberKind: 'session'
      subscriberId: string
    }
    const listed = async (who: typeof alice) =>
      ((await who.subscriptionList.query({} as never)) as Array<{ id: string }>).map((row) => row.id)
    expect(await listed(bob)).toContain(sub.id)
    expect(await listed(alice)).not.toContain(sub.id)
    // A toggle and a removal are the record's generic edits (POD-6676).
    const id = subscriptionRowIdOf(sub)
    const submit = async (name: MemberName, command: string, input: unknown) =>
      (
        (await (await trpc(name)).sync.submit.mutate({
          mutationId: `mut_${name}_${command}`,
          command,
          version: 1,
          input,
        } as never)) as { outcome: string }
      ).outcome
    expect(await submit('alice', 'records.subscription.edit', { id, patch: { enabled: false } })).toBe(
      'rejected',
    )
    expect(await submit('alice', 'records.subscription.remove', { id })).toBe('rejected')
    expect(await submit('bob', 'records.subscription.edit', { id, patch: { enabled: false } })).toBe(
      'applied',
    )
    expect(await submit('bob', 'records.subscription.remove', { id })).toBe('applied')
    expect(await listed(bob)).not.toContain(sub.id)
  })
})
