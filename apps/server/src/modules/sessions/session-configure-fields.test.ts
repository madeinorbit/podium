/**
 * WHAT THE DRIVER CAN CHANGE, PUBLISHED TO CLIENTS (POD-3087).
 *
 * The daemon reports `configureFields` on bind; the server records it on the
 * session and puts it on `SessionMeta`, where a client reads it to decide
 * whether to offer a model control. Two things about that hop are easy to get
 * wrong and invisible when you do:
 *
 *   - ABSENT vs EMPTY. Undefined means no daemon has told us — an older build,
 *     or a row that has not bound — and a client must keep its previous
 *     behaviour. Empty means a daemon DID tell us, and the answer is "nothing".
 *     A projection that dropped the empty array would collapse the two, and the
 *     control would be hidden for the wrong reason.
 *   - IT DESCRIBES A LIVE HANDLE, like `driverId`. A value that outlived the
 *     process that made it offers a control for a driver that is gone.
 */

import type { Geometry } from '@podium/model'
import { asMachineId, asSessionId, NO_SESSION_USER_STATE } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }

const makeSession = (): Session =>
  new Session({
    sessionId: asSessionId('s-configure-fields'),
    durableLabel: 'podium-s-configure-fields',
    agentKind: 'codex',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-29T00:00:00.000Z',
    geometry: geo,
    machineId: asMachineId('machine-under-test'),
    toDaemon: vi.fn(),
  })

const meta = (session: Session): { configureFields?: readonly string[] } =>
  session.toMeta(NO_SESSION_USER_STATE) as { configureFields?: readonly string[] }

describe('configureFields on the wire', () => {
  it('publishes what the daemon reported', () => {
    const session = makeSession()
    session.configureFields = ['model', 'effort']

    expect(meta(session).configureFields).toEqual(['model', 'effort'])
  })

  it('publishes an EMPTY set as an empty set, not as silence', () => {
    const session = makeSession()
    session.configureFields = []

    /**
     * THE ASSERTION THAT COSTS THE MOST TO GET WRONG. A `...(x.length ? …)`
     * guard here reads perfectly and turns a terminal session — whose daemon
     * answered "this driver changes nothing" — into one indistinguishable from a
     * daemon that never answered at all.
     */
    expect(meta(session).configureFields).toEqual([])
    expect(meta(session).configureFields).toBeDefined()
  })

  it('says NOTHING when no daemon has reported, rather than an empty set', () => {
    // Absent must survive as absent: a client reading this during a rolling
    // upgrade has to keep its previous behaviour, and an invented `[]` would
    // tell it to hide the control on every session in the fleet.
    expect(meta(makeSession()).configureFields).toBeUndefined()
  })

  it('is dropped when a spawn fails, like the driver id it travels with', () => {
    const session = makeSession()
    session.configureFields = ['model', 'effort']

    session.markSpawnError('never started')

    // No driver ever bound, so there is nothing whose capabilities these could
    // be. Leaving them standing would describe an exited row as configurable.
    expect(session.configureFields).toBeUndefined()
    expect(meta(session).configureFields).toBeUndefined()
  })
})
