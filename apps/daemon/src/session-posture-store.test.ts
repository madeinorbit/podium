/**
 * THE SPAWN FRAME'S POSTURE, RESOLVED AND KEPT (POD-6858 Task 9).
 *
 * A spawn frame that states a posture starts the session on it; one from an
 * older server, which states none, starts it on the default. The daemon
 * records what it resolved, so a later launch with no frame in hand (a
 * headless reattach, a client terminal) runs on the same terms while the
 * server is unreachable.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { asSessionId } from '@podium/model'
import { DEFAULT_SESSION_POSTURE } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionSpecForSpawn } from './control/session'
import {
  forgetSessionPosture,
  recordSessionPosture,
  SESSION_POSTURE_NAMESPACE,
  storedSessionPosture,
} from './session-posture-store'

let stateRoot: string
beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'podium-posture-'))
  vi.stubEnv('PODIUM_STATE_DIR', stateRoot)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(stateRoot, { recursive: true, force: true })
})

function spawnFrame(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'spawn',
    sessionId: asSessionId(sessionId),
    agentKind: 'claude-code',
    cwd: '/work/podium-test',
    geometry: { cols: 80, rows: 24 },
    ...extra,
  } as never
}

describe('the spawn frame states the session posture', () => {
  it('starts the session on the posture the frame states', () => {
    const spec = sessionSpecForSpawn(
      spawnFrame('s-spawn-supervised', { posture: { mode: 'supervised' } }),
      { auth: 'unknown', role: 'interactive' },
      testHarnessContext({ kind: 'claude-code' }),
      stateRoot,
    )
    expect(spec.posture).toEqual({ mode: 'supervised' })
  })

  it('starts the session on the default when an older server states none', () => {
    const spec = sessionSpecForSpawn(
      spawnFrame('s-spawn-old'),
      { auth: 'unknown', role: 'interactive' },
      testHarnessContext({ kind: 'claude-code' }),
      stateRoot,
    )
    expect(spec.posture).toEqual(DEFAULT_SESSION_POSTURE)
  })
})

describe('the recorded session posture', () => {
  it('reads back the posture a session was recorded with', () => {
    const id = asSessionId('s-recorded')
    recordSessionPosture(id, { mode: { native: 'plan' } })
    expect(storedSessionPosture(id)).toEqual({ mode: { native: 'plan' } })
  })

  it('survives the daemon: the record is a file under the state folder', () => {
    const id = asSessionId('s-on-disk')
    recordSessionPosture(id, { mode: 'supervised' })
    const path = join(stateRoot, SESSION_POSTURE_NAMESPACE, `${encodeURIComponent(id)}.json`)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      sessionId: id,
      posture: { mode: 'supervised' },
    })
  })

  it('is the default for a session with no record', () => {
    expect(storedSessionPosture(asSessionId('s-never-recorded'))).toEqual(DEFAULT_SESSION_POSTURE)
  })

  it('is the default for a record that does not hold a posture', () => {
    const id = asSessionId('s-garbled')
    mkdirSync(join(stateRoot, SESSION_POSTURE_NAMESPACE), { recursive: true })
    writeFileSync(
      join(stateRoot, SESSION_POSTURE_NAMESPACE, `${encodeURIComponent(id)}.json`),
      JSON.stringify({ sessionId: id, posture: { mode: 'yolo' } }),
    )
    expect(storedSessionPosture(id)).toEqual(DEFAULT_SESSION_POSTURE)
  })

  it('forgets a retired session', () => {
    const id = asSessionId('s-retired')
    recordSessionPosture(id, { mode: 'supervised' })
    forgetSessionPosture(id)
    expect(storedSessionPosture(id)).toEqual(DEFAULT_SESSION_POSTURE)
  })
})
