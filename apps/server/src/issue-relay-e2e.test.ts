import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runIssueCli } from '../../../scripts/issue-cli'
import { createIssueRelayHub, startIssueRelayServer } from '../../daemon/src/issue-relay'
import { type IssueTrpc, makeRelayIssueClient } from './issue-client'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

/**
 * End-to-end proof that an agent's `podium issue` call flows the WHOLE chain with every
 * real code path wired, deterministically (no PTY, no physical WS):
 *
 *   runIssueCli (scripts/issue-cli)
 *     → makeRelayIssueClient POST                       (issue-client)
 *       → startIssueRelayServer loopback HTTP           (daemon/issue-relay)
 *         → hub.relay → send(issueRelayRequest)         (daemon/issue-relay)
 *           → registry.onDaemonMessageFrom              (server WS dispatch, REAL)
 *             → registry.runIssueRelay                  (allowlist + capability mint + P1a gate)
 *               → makeIssueCaller → appRouter.createCaller (capability-scoped tRPC caller, REAL)
 *           ← toMachine(issueRelayResult)               (server → daemon channel, REAL)
 *         ← attachDaemon send → hub.onResult            (request/response correlation, REAL)
 *       ← HTTP 200 { ok, result?|error? }
 *     ← relay client returns result / throws error
 *
 * Everything is the real module except the physical network + PTY.
 */
describe('agent issue relay end-to-end (CLI → daemon relay → server capability gate → back)', () => {
  const machineId = 'm1'
  const repoPath = '/repo'
  let registry: SessionRegistry
  let relayServer: Awaited<ReturnType<typeof startIssueRelayServer>>
  let A: { id: string; title: string }
  let B: { id: string }
  let sA: string
  let client: IssueTrpc
  let overrideClient: IssueTrpc

  beforeAll(async () => {
    registry = new SessionRegistry()

    // A is a subtree root with a worktree; a session running INSIDE it → a worker capability
    // rooted at A's subtree. B is unrelated (outside A's subtree). Mirrors the P1b-server tests.
    A = registry.issues.create({ repoPath, title: 'epic root A', startNow: false })
    registry.issues.update(A.id, { worktreePath: '/wt/A' })
    const wtA = registry.issues.get(A.id)?.worktreePath as string
    B = registry.issues.create({ repoPath, title: 'unrelated B', startNow: false })
    sA = registry.createSession({ cwd: wtA, agentKind: 'shell' }).sessionId

    // Install the capability-scoped tRPC caller factory exactly like server.ts wiring, so the
    // P1a issueCapabilityGuard middleware runs on every relayed op (the gate is NOT re-implemented).
    registry.makeIssueCaller = (capability, overrideScope) =>
      appRouter.createCaller({
        registry,
        repos: {} as never,
        superagent: {} as never,
        capability,
        overrideScope,
      }) as unknown as {
        [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined
      }

    // REAL daemon relay hub, its `send` feeding the server's REAL WS dispatch. This is the
    // daemon→server direction (the daemon initiates an issueRelayRequest on the agent's behalf).
    const hub = createIssueRelayHub((msg: DaemonMessage) =>
      registry.onDaemonMessageFrom(machineId, msg),
    )
    // REAL server→daemon channel: route the issueRelayResult the registry sends back into the hub
    // so it can resolve the correlated relay promise.
    registry.attachDaemon(machineId, (m: ControlMessage) => {
      if (m.type === 'issueRelayResult') hub.onResult(m)
    })
    // REAL loopback HTTP relay server the agent's CLI posts to.
    relayServer = await startIssueRelayServer({ port: 0, relay: (req) => hub.relay(req) })

    // The agent CLI clients: one in-scope, one that carries `--outside-scope` (overrideScope).
    // The session id is bound in the relay URL — there is deliberately no `--session` flag.
    client = makeRelayIssueClient(relayServer.endpointFor(sA))
    overrideClient = makeRelayIssueClient(relayServer.endpointFor(sA), { outsideScope: true })
  })

  afterAll(async () => {
    await relayServer.close()
    registry.dispose()
  })

  // 1. prime is bound to the session's subtree via its cwd (capabilityForSession → boundIssueId),
  //    so with NO --repoPath it still surfaces issue A's context.
  it('prime is bound to the session subtree (output contains issue A title)', async () => {
    const out = await runIssueCli(['prime'], client)
    expect(out).toContain(A.title)
  })

  // 2. ready is a read: resolves with no auth/relay error.
  it('ready resolves without an auth error', async () => {
    const out = await runIssueCli(['ready', '--repoPath', repoPath], client)
    expect(out).not.toMatch(/outside your subtree|is not permitted via relay|invalid args/)
  })

  // 3. create is an additive write (no existing issue) — a worker may create.
  it('create resolves (worker may create)', async () => {
    const out = await runIssueCli(
      ['create', '--title', 'Found bug', '--repoPath', repoPath],
      client,
    )
    expect(out).toMatch(/created #\d+/)
  })

  // 4. update on B (outside sA's subtree) is a scope violation → rejected by the P1a gate.
  //    `update --priority 1` maps to issues.update({ id, patch: { priority: 1 } }).
  it('update outside the subtree is rejected', async () => {
    await expect(
      runIssueCli(['update', '--id', B.id, '--priority', '1'], client),
    ).rejects.toThrow(/outside your subtree/)
  })

  // 5. the same update through the --outside-scope client (overrideScope) succeeds.
  it('update outside the subtree succeeds with --outside-scope', async () => {
    const out = await runIssueCli(['update', '--id', B.id, '--priority', '1'], overrideClient)
    expect(out).toMatch(/updated #\d+/)
  })
})
