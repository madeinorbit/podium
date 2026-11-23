import { ISSUE_COMMANDS, type IssueTrpc } from '@podium/issue-client'
import {
  asMutationId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type IssueId,
  type MachineId,
  pinRowId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { fixtureInventory } from './test-support/daemon-inventory'
import { attachHostDaemon } from './test-support/host-daemon'

/**
 * `podium issue update <id> --pinned true|false` FROM AN AGENT (POD-6692).
 *
 * A pin is the human's own pin record of the task. The CLI command runs over
 * the agent relay, as an agent's CLI does: `issues.get` names the human the
 * agent acts for, and the pin is `records.pin.create` / `.remove` on the sync
 * write entry point. Nothing here is a proxy that answers every procedure: the
 * relay frames go through the real gateway, gate and dispatch. Mirrors the
 * approvals relay harness (approvals-relay-e2e.test.ts).
 */

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe('issue pins from an agent, over the relay (POD-6692)', () => {
  const registries: SessionRegistry[] = []
  let machineId: MachineId
  let registry: SessionRegistry
  let sessionId: string
  let issueId: IssueId
  let issueSeq: number
  let daemonInbox: ControlMessage[]
  let relayReplies: Map<string, (reply: RelayResult) => void>

  beforeEach(async () => {
    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    machineId = registry.sessionStore.hostMachineId
    daemonInbox = []
    relayReplies = new Map()
    await attachHostDaemon(
      registry,
      (msg) => {
        daemonInbox.push(msg)
        if (msg.type === 'agentRelayResult') {
          const resolve = relayReplies.get(msg.requestId)
          relayReplies.delete(msg.requestId)
          resolve?.(msg)
        }
      },
      { repos: ['/r'] },
    )
    await registry.modules.machines.recordInventory(machineId, fixtureInventory())
    const writer = registry.issues.reports.store.serverWriter
    const issue = await registry.issues.crud.create(writer, {
      repoPath: '/r',
      title: 'pin me',
      startNow: false,
    })
    await registry.issues.crud.update(writer, issue.id, { worktreePath: '/r/.worktrees/issue-1' })
    issueId = issue.id
    issueSeq = issue.seq
    sessionId = (
      await registry.modules.sessions.createSession({
        cwd: '/r/.worktrees/issue-1',
        agentKind: 'shell',
      })
    ).sessionId
  })

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  /** One relay call from the agent session, answered by the real gate. */
  const relay = (router: string, proc: string, input: unknown): Promise<unknown> => {
    const requestId = `pin${daemonInbox.length}-${relayReplies.size}-${router}.${proc}`
    return new Promise<RelayResult>((resolve) => {
      relayReplies.set(requestId, resolve)
      void registry.gateway.routeDaemonFrame(machineId, {
        type: 'agentRelayRequest',
        requestId,
        sessionId: asSessionId(sessionId),
        router,
        proc,
        input,
      })
    }).then((reply) => {
      if (!reply.ok) throw new Error(reply.error ?? 'relay failed')
      return reply.result
    })
  }

  /** The agent's CLI client: every router call rides the relay, as `makeRelayIssueClient`'s do. */
  const agentClient = (): IssueTrpc =>
    new Proxy(
      {},
      {
        get: (_t, router) =>
          typeof router !== 'string'
            ? undefined
            : new Proxy(
                {},
                {
                  get: (_p, proc) => {
                    if (typeof proc !== 'string') return undefined
                    const call = (input: unknown) => relay(router, proc, input)
                    return { mutate: call, query: call }
                  },
                },
              ),
      },
    ) as IssueTrpc

  const update = ISSUE_COMMANDS.find((command) => command.name === 'update')!
  const runUpdate = async (args: Record<string, unknown>) =>
    await update.run(agentClient(), update.args.parse(args) as Record<string, unknown>)

  const human = () => firstAdminMemberId()
  const pinnedAt = async () =>
    await registry.sessionStore.sessions.pinnedAt(human(), 'issue', issueId)

  it('--pinned true pins the task for the agent’s human, --pinned false unpins it', async () => {
    expect(await pinnedAt()).toBeUndefined()

    const pinned = await runUpdate({ id: String(issueSeq), pinned: 'true' })
    expect(pinned.text).toBe(`pinned #${issueSeq}`)
    expect(await pinnedAt()).toEqual(expect.any(String))
    // Pinning a pinned task keeps the first pin.
    const first = await pinnedAt()
    await runUpdate({ id: String(issueSeq), pinned: 'true' })
    expect(await pinnedAt()).toBe(first)

    const unpinned = await runUpdate({ id: String(issueSeq), pinned: 'false' })
    expect(unpinned.text).toBe(`unpinned #${issueSeq}`)
    expect(await pinnedAt()).toBeUndefined()
  })

  it('issues.get names the human the agent acts for', async () => {
    const issue = (await relay('issues', 'get', { id: issueId })) as { viewerUserId?: string }
    expect(issue.viewerUserId).toBe(human())
  })

  it('an agent cannot create a pin row for another person', async () => {
    const someoneElse = asUserId('u-someone-else')
    const reply = (await relay('sync', 'submit', {
      mutationId: asMutationId('m-pin-theirs'),
      command: 'records.pin.create',
      version: 1,
      input: {
        id: pinRowId(someoneElse, 'issue', issueId),
        fields: { userId: someoneElse, kind: 'issue', entityId: issueId },
      },
    })) as { outcome: string; refusal?: { kind: string } }
    // The same answer as over tRPC: a row that is not mine has no target for me.
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(await registry.sessionStore.sessions.pinnedAt(someoneElse, 'issue', issueId)).toBe(
      undefined,
    )
    // Nor remove one: an unpin of another person's row is just as unknown.
    const remove = (await relay('sync', 'submit', {
      mutationId: asMutationId('m-unpin-theirs'),
      command: 'records.pin.remove',
      version: 1,
      input: { id: pinRowId(someoneElse, 'issue', issueId) },
    })) as { outcome: string; refusal?: { kind: string } }
    expect(remove).toMatchObject({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('the relay reaches only the pin record kind', async () => {
    await expect(
      relay('sync', 'submit', {
        mutationId: asMutationId('m-tab-order'),
        command: 'records.tabOrder.edit',
        version: 1,
        input: { id: 'x', patch: { sessionIds: [sessionId] } },
      }),
    ).rejects.toThrow(/not permitted via relay/)
  })
})
