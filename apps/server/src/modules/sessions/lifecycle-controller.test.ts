/**
 * The lifecycle controller's level rules (POD-6356), over fake ports: what is
 * pending, when it acts, what it acknowledges, and how passes coalesce. The
 * composed behaviour (sync.submit, the daemon) is `desired-state.test.ts`.
 */

import { asMachineId, type SessionDesired, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionLifecycleRow, SessionStatusPersisted } from '../../store'
import {
  type LifecycleControllerPorts,
  type LifecycleOutcome,
  type LifecycleSnapshot,
  NO_LONGER_ALLOWED,
  SessionLifecycleController,
  satisfied,
} from './lifecycle-controller'

const M = asMachineId('m1')
const S = 's1' as SessionId

interface Row {
  status: SessionStatusPersisted
  lifecycle: SessionLifecycleRow
}

function fixture(
  rows: Record<string, Row>,
  opts: { connected?: boolean; mayStart?: boolean } = {},
) {
  const calls: string[] = []
  /** The `selfStop` each stop was asked with, in order (POD-6422). */
  const selfStops: boolean[] = []
  const acks: { id: string; revision: number; failure?: string }[] = []
  let answer: (verb: string) => Promise<LifecycleOutcome> = async () => ({ ok: true })
  const act = (verb: string, id: SessionId) => {
    calls.push(`${verb}:${id}:${rows[id]?.lifecycle.revision}`)
    return answer(verb)
  }
  const ports: LifecycleControllerPorts = {
    read: async (id): Promise<LifecycleSnapshot | undefined> => {
      const row = rows[id]
      return row
        ? { sessionId: id, machineId: M, status: row.status, lifecycle: row.lifecycle }
        : undefined
    },
    pending: async () =>
      Object.entries(rows)
        .filter(([, r]) => r.lifecycle.revision > r.lifecycle.observedRevision)
        .map(([id]) => id as SessionId),
    connected: () => opts.connected ?? true,
    mayStart: async () => opts.mayStart ?? true,
    stop: async (id, _force, _principal, selfStop) => {
      selfStops.push(selfStop === true)
      return await act('stop', id)
    },
    hibernate: async (id) => await act('hibernate', id),
    resurrect: async (id) => await act('resurrect', id),
    acknowledge: async (id, revision, failure) => {
      acks.push({ id, revision, ...(failure ? { failure } : {}) })
      const row = rows[id]
      if (row && row.lifecycle.revision === revision) {
        row.lifecycle = {
          ...row.lifecycle,
          observedRevision: revision,
          failure: failure ? { revision, reason: failure } : null,
        }
      }
    },
  }
  return {
    controller: new SessionLifecycleController(ports),
    calls,
    selfStops,
    acks,
    answerWith: (fn: (verb: string) => Promise<LifecycleOutcome>) => {
      answer = fn
    },
  }
}

const row = (
  status: SessionStatusPersisted,
  desired: SessionDesired | null,
  revision: number,
  observedRevision: number,
): Row => ({
  status,
  lifecycle: {
    desired,
    force: false,
    revision,
    observedRevision,
    failure: null,
    byUser: null,
    byAgent: null,
  },
})

describe('satisfied', () => {
  it('running is any running status; hibernated any parked one; stopped is never status alone', () => {
    expect(satisfied('running', 'live')).toBe(true)
    expect(satisfied('running', 'starting')).toBe(true)
    expect(satisfied('running', 'hibernated')).toBe(false)
    expect(satisfied('hibernated', 'exited')).toBe(true)
    expect(satisfied('hibernated', 'live')).toBe(false)
    expect(satisfied('stopped', 'hibernated')).toBe(false)
  })
})

describe('SessionLifecycleController', () => {
  it('acts on a pending session once and acknowledges its revision', async () => {
    const f = fixture({ [S]: row('live', 'stopped', 2, 1) })
    expect(await f.controller.reconcile(S)).toMatchObject({ kind: 'acknowledged', revision: 2 })
    expect(f.calls).toEqual(['stop:s1:2'])
    expect(await f.controller.reconcile(S)).toEqual({ kind: 'idle' })
    expect(f.calls).toHaveLength(1)
  })

  it('does nothing for a session that is not pending, whatever its status says', async () => {
    // Desired running, exited on its own: no edit asked for anything since.
    const f = fixture({ [S]: row('exited', 'running', 2, 2) })
    expect(await f.controller.reconcile(S)).toEqual({ kind: 'idle' })
    await f.controller.reconcileMachine(M)
    expect(f.calls).toEqual([])
    expect(f.acks).toEqual([])
  })

  it('acknowledges without acting when the observed state already is the desired one', async () => {
    const f = fixture({ [S]: row('live', 'running', 2, 1) })
    expect(await f.controller.reconcile(S)).toMatchObject({ kind: 'acknowledged', revision: 2 })
    expect(f.calls).toEqual([])
    expect(f.acks).toEqual([{ id: S, revision: 2 }])
  })

  it('waits, without acting or acknowledging, while the machine has no daemon', async () => {
    const f = fixture({ [S]: row('live', 'stopped', 2, 1) }, { connected: false })
    expect(await f.controller.reconcile(S)).toEqual({
      kind: 'waiting',
      revision: 2,
      why: 'offline',
    })
    expect(f.calls).toEqual([])
    expect(f.acks).toEqual([])
  })

  it('records a refusal as the revision’s failure, and a throw as nothing at all', async () => {
    const f = fixture({ [S]: row('live', 'hibernated', 2, 1) })
    f.answerWith(async () => ({ ok: false, reason: 'agent is working' }))
    await f.controller.reconcile(S)
    expect(f.acks).toEqual([{ id: S, revision: 2, failure: 'agent is working' }])

    const g = fixture({ [S]: row('live', 'hibernated', 2, 1) })
    g.answerWith(async () => {
      throw new Error('daemon went away')
    })
    expect(await g.controller.reconcile(S)).toEqual({
      kind: 'waiting',
      revision: 2,
      why: 'transient',
    })
    expect(g.acks).toEqual([])
  })

  it('an edit committed during a pass is acted on after it, each revision once', async () => {
    const rows = { [S]: row('live', 'stopped', 2, 1) }
    const f = fixture(rows)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.answerWith(async (verb) => {
      if (verb === 'stop') await gate
      return { ok: true }
    })
    const first = f.controller.reconcile(S)
    while (f.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    // A start lands while the stop is still running.
    const target = rows[S]
    if (!target) throw new Error('fixture row')
    const second = f.controller.reconcile(S)
    target.lifecycle = { ...target.lifecycle, desired: 'running', revision: 3 }
    target.status = 'hibernated'
    release()
    await Promise.all([first, second])

    expect(f.calls).toEqual(['stop:s1:2', 'resurrect:s1:3'])
    // The stop's acknowledgement of revision 2 was a no-op: 3 had landed.
    expect(f.acks.map((a) => a.revision)).toEqual([2, 3])
    expect(target.lifecycle.observedRevision).toBe(3)
    expect(f.controller.outcomeFor(S, 3)).toEqual({ ok: true })
  })

  it('re-checks the writer before a start, never before a stop', async () => {
    const f = fixture({ [S]: row('hibernated', 'running', 2, 1) }, { mayStart: false })
    expect(await f.controller.reconcile(S)).toMatchObject({ kind: 'acknowledged', revision: 2 })
    expect(f.calls).toEqual([])
    expect(f.acks).toEqual([{ id: S, revision: 2, failure: NO_LONGER_ALLOWED }])

    const g = fixture({ [S]: row('live', 'stopped', 2, 1) }, { mayStart: false })
    await g.controller.reconcile(S)
    expect(g.calls).toEqual(['stop:s1:2'])
    expect(g.acks).toEqual([{ id: S, revision: 2 }])
  })

  it('a reconnect reconciles every pending session on the machine, once', async () => {
    const f = fixture({
      a: row('live', 'stopped', 2, 1),
      b: row('hibernated', 'running', 4, 3),
      c: row('live', 'running', 1, 1),
    })
    await f.controller.reconcileMachine(M)
    expect([...f.calls].sort()).toEqual(['resurrect:b:4', 'stop:a:2'])
    await f.controller.reconcileMachine(M)
    expect(f.calls).toHaveLength(2)
  })

  describe('a session stopping itself (POD-6422)', () => {
    /** A stop at `revision` written by `byAgent`. */
    const stopBy = (byAgent: SessionId | null, revision = 2): Row => {
      const r = row('live', 'stopped', revision, revision - 1)
      return { ...r, lifecycle: { ...r.lifecycle, byAgent } }
    }

    it('defers the kill on a commit’s pass when the session’s own agent wrote the stop', async () => {
      const f = fixture({ [S]: stopBy(S) })
      await f.controller.reconcile(S)
      expect(f.calls).toEqual(['stop:s1:2'])
      expect(f.selfStops).toEqual([true])
    })

    it('stops and kills as any stop when another agent or a person wrote it', async () => {
      const f = fixture({ [S]: stopBy('other' as SessionId), t: stopBy(null) })
      await f.controller.reconcile(S)
      await f.controller.reconcile('t' as SessionId)
      expect(f.selfStops).toEqual([false, false])
    })

    it('a reconnect’s pass answers nobody, so it kills even the agent’s own stop', async () => {
      const f = fixture({ [S]: stopBy(S) })
      await f.controller.reconcileMachine(M)
      expect(f.calls).toEqual(['stop:s1:2'])
      expect(f.selfStops).toEqual([false])
    })

    it('a reconnect queued behind a commit’s request still answers the commit', async () => {
      const rows = { [S]: row('live', 'hibernated', 2, 1) }
      const f = fixture(rows)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      f.answerWith(async (verb) => {
        if (verb === 'hibernate') await gate
        return { ok: true }
      })
      const first = f.controller.reconcile(S)
      while (f.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      // The agent's own stop commits while the hibernate runs, and its machine
      // reconnects before the next pass starts.
      const target = rows[S]
      if (!target) throw new Error('fixture row')
      target.lifecycle = { ...target.lifecycle, desired: 'stopped', revision: 3, byAgent: S }
      const commit = f.controller.reconcile(S)
      const reconnect = f.controller.reconcile(S, { reconnect: true })
      release()
      await Promise.all([first, commit, reconnect])
      expect(f.calls).toEqual(['hibernate:s1:2', 'stop:s1:3'])
      expect(f.selfStops).toEqual([true])
    })
  })
})
