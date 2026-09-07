import type { IssueProc, IssueTrpc } from '@podium/issue-client'
import { makeRelayIssueClient } from '@podium/issue-client'
import { asIssueId, asSessionId, type IssueId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { runIssueCli } from '../../cli/src/issue-cli'
import { createAgentRelayHub, startAgentRelayServer } from '../../daemon/src/agent-relay'
import { FIRST_ADMIN_USER_ID, resolvePrincipal } from './command-principal'

import { IssueToolProvider } from './issue-mcp'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

type LifecycleName = 'archive' | 'depRemove' | 'reparent' | 'supersede' | 'duplicate'

interface LifecycleFixture {
  root: { id: string }
  moving: { id: string }
  newParent: { id: string }
  superseded: { id: string }
  replacement: { id: string }
  duplicate: { id: string }
  canonical: { id: string }
  depFrom: { id: string }
  depTo: { id: string }
  archived: { id: string }
}

async function fixture(registry: SessionRegistry): Promise<LifecycleFixture> {
  const create = async (title: string, parentId?: IssueId) =>
    await registry.issues.create({
      repoPath: '/repo',
      title,
      startNow: false,
      ...(parentId ? { parentId } : {}),
    })
  const root = await create('root')
  const oldParent = await create('old parent', root.id)
  const newParent = await create('new parent', root.id)
  const moving = await create('moving', oldParent.id)
  const superseded = await create('superseded', root.id)
  const replacement = await create('replacement', root.id)
  const duplicate = await create('duplicate', root.id)
  const canonical = await create('canonical', root.id)
  const depFrom = await create('dep from', root.id)
  const depTo = await create('dep to', root.id)
  const archived = await create('archived', root.id)
  await registry.issues.addDep(depFrom.id, depTo.id, 'blocks')
  return {
    root,
    moving,
    newParent,
    superseded,
    replacement,
    duplicate,
    canonical,
    depFrom,
    depTo,
    archived,
  }
}

function lifecycleInputs(f: LifecycleFixture): Array<[LifecycleName, Record<string, unknown>]> {
  return [
    ['reparent', { id: f.moving.id, parentId: f.newParent.id }],
    ['supersede', { oldId: f.superseded.id, newId: f.replacement.id }],
    ['duplicate', { id: f.duplicate.id, canonicalId: f.canonical.id }],
    ['depRemove', { fromId: f.depFrom.id, toId: f.depTo.id, type: 'blocks' }],
    ['archive', { id: f.archived.id }],
  ]
}

async function verify(registry: SessionRegistry, f: LifecycleFixture): Promise<void> {
  expect((await registry.issues.get(f.moving.id))?.parentId).toBe(f.newParent.id)
  expect(await registry.issues.get(f.superseded.id)).toMatchObject({
    closedReason: 'superseded',
    supersededBy: f.replacement.id,
  })
  expect(await registry.issues.get(f.duplicate.id)).toMatchObject({
    closedReason: 'duplicate',
    duplicateOf: f.canonical.id,
  })
  expect((await registry.issues.get(f.depFrom.id))?.deps).not.toContainEqual({
    id: f.depTo.id,
    type: 'blocks',
  })
  expect((await registry.issues.get(f.archived.id))?.archived).toBe(true)
}

async function runIssueClient(client: IssueTrpc, f: LifecycleFixture): Promise<void> {
  for (const [name, input] of lifecycleInputs(f)) {
    await (client.issues[name] as IssueProc).mutate(input)
  }
}

describe('lifecycle primitives across all four command transports (#413)', () => {
  it('tRPC operator executes all five registry-derived commands', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const f = await fixture(registry)
      const caller = appRouter.createCaller({
        registry,
        repos: {} as never,
        superagent: {} as never,
        capability: OPERATOR,
        principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
      })
      await caller.issues.reparent({ id: f.moving.id, parentId: f.newParent.id })
      await caller.issues.supersede({ oldId: f.superseded.id, newId: f.replacement.id })
      await caller.issues.duplicate({ id: f.duplicate.id, canonicalId: f.canonical.id })
      await caller.issues.depRemove({ fromId: f.depFrom.id, toId: f.depTo.id, type: 'blocks' })
      await caller.issues.archive({ id: f.archived.id })
      await verify(registry, f)
    } finally {
      await registry.dispose()
    }
  })

  it('scoped in-process dispatcher executes all five inside the agent subtree', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const f = await fixture(registry)
      const client = registry.issueCommands.asIssueTrpc({
        role: 'worker',
        scope: { kind: 'subtree', rootId: asIssueId(f.root.id) },
        actorSessionId: asSessionId('test-agent'),
        onBehalfOf: FIRST_ADMIN_USER_ID,
      })
      await runIssueClient(client, f)
      await verify(registry, f)
    } finally {
      await registry.dispose()
    }
  })

  it('scoped MCP tools execute all five inside the agent subtree', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const f = await fixture(registry)
      const provider = new IssueToolProvider()
      provider.setClient(
        registry.issueCommands.asIssueTrpc({
          role: 'worker',
          scope: { kind: 'subtree', rootId: asIssueId(f.root.id) },
          actorSessionId: asSessionId('test-agent'),
          onBehalfOf: FIRST_ADMIN_USER_ID,
        }),
      )
      for (const [name, input] of lifecycleInputs(f)) {
        const tool = `issue_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`
        await provider.callMcpTool(tool, input)
      }
      await verify(registry, f)
    } finally {
      await registry.dispose()
    }
  })

  it('scoped CLI relay executes all five inside the agent subtree', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    let relayServer: Awaited<ReturnType<typeof startAgentRelayServer>> | undefined
    try {
      const f = await fixture(registry)
      await registry.issues.update(f.root.id, { worktreePath: '/wt/lifecycle-root' })
      const sessionId = (await registry.modules.sessions.createSession({
        cwd: '/wt/lifecycle-root',
        agentKind: 'shell',
      })).sessionId
      const machineId = 'lifecycle-machine'
      const hub = createAgentRelayHub((msg: DaemonMessage) =>
        registry.gateway.routeDaemonFrame(machineId, msg),
      )
      registry.gateway.attachDaemon(machineId, (msg: ControlMessage) => {
        if (msg.type === 'agentRelayResult') hub.onResult(msg)
      })
      relayServer = await startAgentRelayServer({ port: 0, relay: (req) => hub.relay(req) })
      const client = makeRelayIssueClient(relayServer.endpointFor(sessionId))

      await runIssueCli(['reparent', f.moving.id, f.newParent.id], client)
      await runIssueCli(['supersede', f.superseded.id, f.replacement.id], client)
      await runIssueCli(['duplicate', f.duplicate.id, f.canonical.id], client)
      await runIssueCli(['dep-remove', f.depFrom.id, f.depTo.id, '--type', 'blocks'], client)
      await runIssueCli(['archive', f.archived.id], client)
      await verify(registry, f)
    } finally {
      await relayServer?.close()
      await registry.dispose()
    }
  })
})
