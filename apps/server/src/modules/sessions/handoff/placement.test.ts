/**
 * THE PLACEMENT PHASE, TESTED WITHOUT A TRANSFER — POD-1399.
 *
 * Every case here used to require driving a two-machine handoff through a
 * SessionRegistry to completion, because the resolution was the first seventy
 * lines of a four-hundred-line method. It is now one call with a hand-built
 * ports object, which is the point of the phase existing.
 *
 * THE ARGUMENT LIST IS ITSELF AN ASSERTION. `resolveHandoffPlacement` takes
 * `HandoffPlacementPorts` — the four READ ports and nothing else — so no case
 * below has to prove that resolution wrote nothing. The type says it cannot:
 * `mutateSessionView`, `toMachine`, `persist` and `rpc` are not reachable from
 * inside the function under test.
 */

import { asMachineId, asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../../command-principal'
import { Session } from '../session'
import { type HandoffPlacementPorts, resolveHandoffPlacement } from './placement'
import type { HandoffCaller, HandoffIssue, HandoffMachine, HandoffRepo } from './ports'
import { HandoffRefusalError } from './refusal'

const SOURCE = asMachineId('m-source')
const TARGET = asMachineId('m-target')
const SESSION = asSessionId('s1')

const caller = (): HandoffCaller => {
  const principal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')
  return { capability: principal.capability, principal }
}

function makeSession(over: { cwd?: string; machineId?: string; issueId?: string } = {}): Session {
  return new Session({
    sessionId: SESSION,
    durableLabel: 'podium-s1',
    agentKind: 'claude-code',
    cwd: over.cwd ?? '/repo/wt/feature',
    title: 'feature',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-02T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: asMachineId(over.machineId ?? SOURCE),
    issueId: over.issueId,
    resume: { kind: 'claude-session', sessionId: 'conv-1' },
    toDaemon: vi.fn(),
  })
}

const repo = (over: Partial<HandoffRepo> = {}): HandoffRepo => ({
  machineId: SOURCE,
  path: '/repo',
  originUrl: null,
  repoId: 'repo-1',
  prefix: null,
  ...over,
})

const onlineTarget = (over: Partial<HandoffMachine> = {}): HandoffMachine => ({
  id: TARGET,
  name: 'target box',
  online: true,
  inventory: { agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }] },
  ...over,
})

function ports(over: {
  session?: Session | undefined
  repos?: HandoffRepo[]
  machines?: HandoffMachine[]
  issue?: HandoffIssue | undefined
}): HandoffPlacementPorts {
  const session = 'session' in over ? over.session : makeSession()
  return {
    getSession: () => session,
    listRepos: () => over.repos ?? [repo()],
    listMachines: () => over.machines ?? [onlineTarget()],
    issueMeta: () => over.issue,
  }
}

const resolve = (p: HandoffPlacementPorts, machineId: string = TARGET) =>
  resolveHandoffPlacement(p, { sessionId: SESSION, machineId }, caller())

describe('handoff placement: what it resolves', () => {
  it('carries the source repo, the machine pair and the target row forward', () => {
    const placement = resolve(ports({}))
    expect(placement.sourceRepo.repoId).toBe('repo-1')
    expect(placement.sourceMachineId).toBe(SOURCE)
    expect(placement.targetMachineId).toBe(TARGET)
    expect(placement.targetMachine.name).toBe('target box')
    expect(placement.agentKind).toBe('claude-code')
  })

  it('picks the DEEPEST registered repo the session sits under, not the first', () => {
    // A nested checkout inside a registered parent: the session lives in the
    // inner one, and exporting it as the outer repo would carry the wrong repo
    // identity and the wrong tree.
    const placement = resolve(
      ports({
        repos: [
          repo({ path: '/repo', repoId: 'outer' }),
          repo({ path: '/repo/wt', repoId: 'inner' }),
        ],
      }),
    )
    expect(placement.sourceRepo.repoId).toBe('inner')
  })

  it('ignores repos registered on another machine', () => {
    expect(() =>
      resolve(ports({ repos: [repo({ machineId: TARGET })] })),
    ).toThrow(/source repository is not registered/)
  })

  it('[spec:SP-3f7a] anchors on the issue worktree when the session cwd drifted to the repo root', () => {
    // The daemon follows the shell, so a session that ran a command against the
    // main checkout is stamped at the repo root. Its issue's worktree is still
    // its home: the move is allowed and the worktree is offered as the fallback.
    const placement = resolve(
      ports({
        session: makeSession({ cwd: '/repo', issueId: 'iss-1' }),
        issue: { machineId: SOURCE, worktreePath: '/repo/wt/feature', branch: 'feat' },
      }),
    )
    expect(placement.issueWorktree).toBe('/repo/wt/feature')
    expect(placement.issue?.branch).toBe('feat')
  })

  it('offers no fallback worktree when the issue is homed on a DIFFERENT machine', () => {
    const placement = resolve(
      ports({
        session: makeSession({ issueId: 'iss-1' }),
        issue: { machineId: TARGET, worktreePath: '/elsewhere/wt', branch: 'feat' },
      }),
    )
    expect(placement.issueWorktree).toBeUndefined()
  })
})

describe('handoff placement: the refusals, all before anything moves', () => {
  it('an absent session is the command`s pinned unknown-session throw', () => {
    expect(() => resolve(ports({ session: undefined }))).toThrow('unknown session')
  })

  it('a session with no resume ref cannot be placed — the conversation would not survive', () => {
    const session = makeSession()
    session.resume = undefined
    expect(() => resolve(ports({ session }))).toThrow('unknown session')
  })

  it('handing a session to the machine it is already on is refused', () => {
    expect(() => resolve(ports({}), SOURCE)).toThrow('session is already on that machine')
  })

  it('an unregistered source repository names the machine and the anchors it tried', () => {
    expect(() => resolve(ports({ repos: [] }))).toThrow(
      `source repository is not registered (machine=${SOURCE}, anchors=/repo/wt/feature)`,
    )
  })

  it('a session sitting at the repo root with no issue worktree is refused', () => {
    expect(() => resolve(ports({ session: makeSession({ cwd: '/repo' }) }))).toThrow(
      'only worktree sessions can be handed off',
    )
  })

  it('an OFFLINE target is unreachable — a different answer from unauthorized (M5)', () => {
    let thrown: unknown
    try {
      resolve(ports({ machines: [onlineTarget({ online: false })] }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HandoffRefusalError)
    expect((thrown as HandoffRefusalError).message).toBe('target machine is offline')
    expect((thrown as HandoffRefusalError).refusal).toBe('unreachable')
  })

  it('a target that does not exist answers the same way as one that is offline', () => {
    expect(() => resolve(ports({ machines: [] }))).toThrow('target machine is offline')
  })

  it('a target without the harness installed is refused, naming the kind', () => {
    expect(() =>
      resolve(
        ports({
          machines: [
            onlineTarget({
              inventory: {
                agents: [{ kind: 'claude-code', installed: false, login: { state: 'in' } }],
              },
            }),
          ],
        }),
      ),
    ).toThrow('target machine cannot run logged-in claude-code')
  })

  it('a target where the harness is LOGGED OUT is refused too — installed is not enough', () => {
    expect(() =>
      resolve(
        ports({
          machines: [
            onlineTarget({
              inventory: {
                agents: [{ kind: 'claude-code', installed: true, login: { state: 'out' } }],
              },
            }),
          ],
        }),
      ),
    ).toThrow('target machine cannot run logged-in claude-code')
  })

  it('a system principal cannot place a handoff — a bundle needs a real owning human', () => {
    expect(() =>
      resolveHandoffPlacement(
        ports({}),
        { sessionId: SESSION, machineId: TARGET },
        {
          capability: caller().capability,
          principal: { kind: 'system', job: 'steward' },
        },
      ),
    ).toThrow('system principal cannot export a personal handoff bundle')
  })

  it('an agent principal places the move on behalf of its human, not itself', () => {
    const human = asUserId(FIRST_ADMIN_USER_ID)
    const placement = resolveHandoffPlacement(
      ports({}),
      { sessionId: SESSION, machineId: TARGET },
      {
        capability: caller().capability,
        principal: {
          kind: 'agent',
          agentSessionId: asSessionId('agent-1'),
          onBehalfOf: human,
          capability: caller().capability,
          chain: [asSessionId('agent-1')],
        },
      },
    )
    expect(placement.exportIdentity.owner).toBe(human)
    expect(placement.exportIdentity.exportedBy.onBehalfOf).toBe(human)
    expect(placement.exportIdentity.exportedBy.actor.kind).toBe('agent')
  })
})
