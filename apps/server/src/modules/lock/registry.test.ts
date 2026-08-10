import { LOCK_COMMAND_NAMES } from '@podium/commands'
import { asSessionId, type SessionId } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'
import { lockRegistry } from './registry'

/**
 * Lock registry completeness + dispatch pipeline [spec:SP-85d1]: the def keys
 * are pinned to the protocol list, the relay dispatcher runs guard → parse →
 * handler (router-equal), the caller's session identity is stamped from the
 * capability (never from input), and the role gate holds (viewers may read
 * status but never write).
 */

const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
afterAll(() => registry.dispose())

const dispatch = (
  caller: Parameters<SessionRegistry['modules']['lockCommands']['dispatch']>[0],
  proc: string,
  input: unknown,
) => registry.modules.lockCommands.dispatch(caller, proc, input)

describe('lock registry', () => {
  it('defines exactly the canonical LOCK_COMMAND_NAMES', () => {
    expect(Object.keys(lockRegistry.defs).sort()).toEqual([...LOCK_COMMAND_NAMES].sort())
    expect(lockRegistry.namespace).toBe('lock')
  })

  it('classifies status as read and the rest as write (agent-reachable, no issue target)', () => {
    for (const [name, def] of Object.entries(lockRegistry.defs)) {
      expect(def.action).toBe(name === 'status' ? 'read' : 'write')
      expect('target' in def).toBe(false)
    }
  })

  it('operator dispatch grants a lock with operator identity', async () => {
    const r = (await dispatch({ capability: OPERATOR }, 'acquire', {
      repoPath: '/repo',
      name: 'merge:main',
    })) as { granted: boolean; lock: { holder: { sessionId: SessionId | null; label: string } } }
    expect(r.granted).toBe(true)
    expect(r.lock.holder).toMatchObject({ sessionId: null, label: 'operator' })
  })

  it('a relayed agent call is stamped with ITS session id from the capability', async () => {
    const caller = {
      capability: {
        role: 'worker' as const,
        scope: { kind: 'none' as const },
        actorSessionId: asSessionId('sess_agent'),
      },
    }
    const r = (await dispatch(caller, 'acquire', { repoPath: '/repo', name: 'agent-lock' })) as {
      granted: boolean
      lock: { holder: { sessionId: SessionId | null; label: string } }
    }
    expect(r.granted).toBe(true)
    expect(r.lock.holder).toMatchObject({
      sessionId: asSessionId('sess_agent'),
      label: 'session:sess_agent',
    })
  })

  it('viewers are role-gated out of writes but may read status', async () => {
    const viewer = { capability: { role: 'viewer' as const, scope: { kind: 'none' as const } } }
    await expect(dispatch(viewer, 'acquire', { repoPath: '/repo', name: 'x' })).rejects.toThrow(
      /not allowed/,
    )
    await expect(dispatch(viewer, 'steal', { repoPath: '/repo', name: 'x' })).rejects.toThrow(
      /not allowed/,
    )
    const status = (await dispatch(viewer, 'status', { repoPath: '/repo' })) as unknown[]
    expect(Array.isArray(status)).toBe(true)
  })

  it('a relayed caller with an UNKNOWN session is not the operator (no null-null conflation)', async () => {
    await dispatch({ capability: OPERATOR }, 'acquire', { repoPath: '/repo', name: 'op-held' })
    // Constrained caller, no actorSessionId (session not in the live map):
    // must NOT be able to release/renew the operator's lock.
    const ghost = { capability: { role: 'worker' as const, scope: { kind: 'none' as const } } }
    await expect(
      dispatch(ghost, 'release', { repoPath: '/repo', name: 'op-held' }),
    ).rejects.toThrow(/not by you/)
    await expect(dispatch(ghost, 'renew', { repoPath: '/repo', name: 'op-held' })).rejects.toThrow(
      /not by you/,
    )
    // ...while the real operator still can.
    const r = (await dispatch({ capability: OPERATOR }, 'release', {
      repoPath: '/repo',
      name: 'op-held',
    })) as { released: boolean }
    expect(r.released).toBe(true)
  })

  it('lock names are validated: control chars/newlines and over-long names are rejected', async () => {
    const bad = ['bad\nname', 'bad name', '--flag', 'a'.repeat(201), 'ütf']
    for (const name of bad) {
      await expect(
        dispatch({ capability: OPERATOR }, 'acquire', { repoPath: '/repo', name }),
      ).rejects.toThrow()
    }
    // merge:<branch> with a realistic branch name passes
    const ok = (await dispatch({ capability: OPERATOR }, 'acquire', {
      repoPath: '/repo',
      name: 'merge:feat/issue-343_v1.2',
    })) as { granted: boolean }
    expect(ok.granted).toBe(true)
  })

  /**
   * POD-672: `merge` and `merge:main` were accepted as two independent leases,
   * so two sessions each held "the merge lock" and the second reset away the
   * first's landing. The dispatcher is the enforcement point every caller shares
   * (tRPC router and daemon relay both parse through these defs), so the refusal
   * has to bite here rather than only in the CLI.
   */
  it('refuses near-misses of the merge mutex, naming the canonical lock', async () => {
    for (const name of ['merge', 'merge:', 'merge-main', 'MERGE', 'merge:origin/main']) {
      await expect(
        dispatch({ capability: OPERATOR }, 'acquire', { repoPath: '/repo', name }),
      ).rejects.toThrow(/merge:main|merge:<branch>|names no branch/)
    }
  })

  it('leaves the free-form lock namespace open', async () => {
    // The reservation is scoped to `merge` — general-purpose leases are the
    // feature, not collateral.
    for (const name of ['test:heavy', 'podium:dev-bundle', 'deploy']) {
      const r = (await dispatch({ capability: OPERATOR }, 'acquire', {
        repoPath: '/repo',
        name,
      })) as { granted: boolean }
      expect(r.granted).toBe(true)
    }
  })

  it('cancel round-trips: a queued caller can leave the queue', async () => {
    const holder = {
      capability: {
        role: 'worker' as const,
        scope: { kind: 'none' as const },
        actorSessionId: asSessionId('sess_h'),
      },
    }
    const waiter = {
      capability: {
        role: 'worker' as const,
        scope: { kind: 'none' as const },
        actorSessionId: asSessionId('sess_w'),
      },
    }
    await dispatch(holder, 'acquire', { repoPath: '/repo', name: 'c' })
    const q = (await dispatch(waiter, 'acquire', { repoPath: '/repo', name: 'c' })) as {
      granted: boolean
    }
    expect(q.granted).toBe(false)
    const c = (await dispatch(waiter, 'cancel', { repoPath: '/repo', name: 'c' })) as {
      cancelled: boolean
    }
    expect(c.cancelled).toBe(true)
    await expect(dispatch(waiter, 'cancel', { repoPath: '/repo', name: 'c' })).rejects.toThrow(
      /not queued/,
    )
  })

  it('unknown procs return undefined (relay "no such procedure" shape)', () => {
    expect(dispatch({ capability: OPERATOR }, 'nuke', {})).toBeUndefined()
  })

  it('invalid input fails zod validation with the shared schema', async () => {
    await expect(dispatch({ capability: OPERATOR }, 'acquire', { name: 'x' })).rejects.toThrow()
  })

  it('release round-trips through the same dispatcher pipeline', async () => {
    await dispatch({ capability: OPERATOR }, 'acquire', { repoPath: '/repo', name: 'rt' })
    const r = (await dispatch({ capability: OPERATOR }, 'release', {
      repoPath: '/repo',
      name: 'rt',
    })) as { released: boolean }
    expect(r.released).toBe(true)
  })
})
