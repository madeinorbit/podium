/**
 * PRE-FLIGHT BASE NEGOTIATION — the stale healthy-checkout incident (POD-1940).
 *
 * Handoff used to propose only the source checkout's named tips. A target whose
 * `main` was behind shared all of its history with the source but could not prove
 * the newer source tip, so the move was refused before export. The target's own
 * tip is a sound base once the source independently proves it has that object.
 */

import { asMachineId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../../command-principal'
import { Session } from '../session'
import { exportedIdentity } from './attribution'
import type { HandoffPlacement } from './placement'
import { HandoffPreflight, type HandoffPreflightPorts } from './preflight'

const SOURCE_MACHINE = asMachineId('m-source')
const TARGET_MACHINE = asMachineId('m-target')
const SESSION = asSessionId('session-1')
const SOURCE_REPO = '/home/mgw/src/other/podium'
const TARGET_REPO = '/home/mgw/src/podium'
const SOURCE_TIP = 'a'.repeat(40)
const TARGET_TIP = 'b'.repeat(40)

function placement(): HandoffPlacement {
  const principal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')
  return {
    session: new Session({
      sessionId: SESSION,
      durableLabel: 'podium-session-1',
      agentKind: 'claude-code',
      cwd: SOURCE_REPO + '/.worktrees/feature',
      title: 'feature',
      origin: { kind: 'spawn' },
      createdAt: '2026-08-12T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 },
      machineId: SOURCE_MACHINE,
      resume: { kind: 'claude-session', value: 'native-1' },
      toDaemon: vi.fn(),
    }) as HandoffPlacement['session'],
    agentKind: 'claude-code',
    exportIdentity: exportedIdentity({ capability: principal.capability, principal }),
    transferId: 'transfer-1',
    sourceMachineId: SOURCE_MACHINE,
    targetMachineId: TARGET_MACHINE,
    sourceRepo: {
      machineId: SOURCE_MACHINE,
      path: SOURCE_REPO,
      originUrl: 'git@github.com:madeinorbit/podium.git',
      repoId: 'repo-podium',
      prefix: 'POD',
    },
    issue: undefined,
    issueWorktree: undefined,
    targetMachine: {
      id: TARGET_MACHINE,
      name: 'flatblock',
      online: true,
      inventory: {
        agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
      },
    },
  }
}

describe('handoff pre-flight bundle-base negotiation', () => {
  it('uses a stale target main tip that the source proves is in its history', async () => {
    const repoOp = vi.fn(
      async (_op: 'revParseVerify', repoPath: string, args: { ref: string }, machineId: string) => {
        expect(machineId).toBe(repoPath === SOURCE_REPO ? SOURCE_MACHINE : TARGET_MACHINE)
        if (repoPath === SOURCE_REPO) {
          if (args.ref === TARGET_TIP) return { ok: true, output: TARGET_TIP }
          return { ok: true, output: SOURCE_TIP }
        }
        if (args.ref === SOURCE_TIP) return { ok: false, output: 'missing' }
        if (args.ref === 'main' || args.ref === 'origin/main') {
          return { ok: true, output: TARGET_TIP }
        }
        return { ok: false, output: 'missing' }
      },
    )
    const mutateSessionView = vi.fn()
    const broadcastSessions = vi.fn()
    const ensureTargetRepo = vi.fn(async () => ({ path: TARGET_REPO }))
    const ports: HandoffPreflightPorts = {
      rpc: { repoOp } as unknown as HandoffPreflightPorts['rpc'],
      ensureTargetRepo,
      mutateSessionView,
      broadcastSessions,
    }
    const authorized: string[] = []

    const result = await new HandoffPreflight(ports).prepare(
      placement(),
      { sessionId: SESSION, machineId: TARGET_MACHINE },
      (machineId) => authorized.push(machineId),
    )

    expect(ensureTargetRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: SOURCE_REPO, repoId: 'repo-podium' }),
      TARGET_MACHINE,
    )
    expect(result.targetRepo.path).toBe(TARGET_REPO)
    expect(result.baseShas).toEqual([TARGET_TIP])
    expect(authorized).toEqual([SOURCE_MACHINE, TARGET_MACHINE])
    expect(mutateSessionView).toHaveBeenCalledTimes(1)
    expect(broadcastSessions).toHaveBeenCalledTimes(1)
  })

  it('still refuses repositories with no object proven on both machines', async () => {
    const ports: HandoffPreflightPorts = {
      rpc: {
        repoOp: vi.fn(async (_op, path, args) => {
          if (path === TARGET_REPO && args.ref !== SOURCE_TIP) {
            return { ok: true, output: TARGET_TIP }
          }
          if (path === SOURCE_REPO && args.ref !== TARGET_TIP) {
            return { ok: true, output: SOURCE_TIP }
          }
          return { ok: false, output: 'missing' }
        }),
      } as unknown as HandoffPreflightPorts['rpc'],
      ensureTargetRepo: vi.fn(async () => ({ path: TARGET_REPO })),
      mutateSessionView: vi.fn(),
      broadcastSessions: vi.fn(),
    }

    await expect(
      new HandoffPreflight(ports).prepare(
        placement(),
        { sessionId: SESSION, machineId: TARGET_MACHINE },
        vi.fn(),
      ),
    ).rejects.toThrow('target repository has no verified common bundle base')
    expect(ports.mutateSessionView).toHaveBeenCalledTimes(2)
    expect(ports.broadcastSessions).toHaveBeenCalledTimes(2)
  })
})
