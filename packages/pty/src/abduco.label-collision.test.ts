import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  abducoHasSession,
  isAbducoAvailable,
  killAbducoSession,
  reapAbducoTestSessions,
  spawnAbducoAgent,
} from './abduco.js'

/**
 * A durable label is a CONSTANT of its session (`podium-<sessionId>`), so every
 * respawn of that session — every Resume — asks abduco to create a session under a
 * name a previous master may still own. abduco refuses that with the raw
 * "create-session: Address already in use", and the daemon surfaces it as a spawn
 * failure: the session is then unresumable for good, which is exactly how POD-1945-A
 * died while its agent was still running in its scope.
 *
 * Two owners can hold the name, and neither is a reason to fail:
 *   - a LIVE master (its socket has neither exec bit set, or S_IXUSR for "a client is
 *     attached"): the agent is alive, so the honest answer to "resume" is to ATTACH;
 *   - a TERMINATED master (S_IXGRP): the app is gone and the master lingers only to
 *     hand out its exit status. Podium's own liveness index skips those, so the code
 *     believes the label is free while abduco does not — reap it, then create.
 *
 * Scope reclaim is disabled here so the label collision is what is under test: on a
 * systemd host `systemctl stop <label>.scope` would otherwise clear a terminated
 * master as a side effect, and the create path would be proven by the wrong mechanism.
 */
process.env.PODIUM_NO_SCOPE = '1'

const hasAbduco = isAbducoAvailable()
const FIXTURE = fileURLToPath(new URL('../test/fixtures/echo-title.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterAll(async () => {
  if (!hasAbduco) return
  await reapAbducoTestSessions([/^podium-ab-collide-(\d+)-[a-z]+$/])
})

describe.skipIf(!hasAbduco)('spawning onto a squatted durable label', () => {
  it('reaps a terminated master and creates the new agent', { timeout: 20000 }, async () => {
    const label = `podium-ab-collide-${process.pid}-dead`
    await killAbducoSession(label)
    // An app that exits immediately leaves the master parked on its exit status:
    // the socket exists, is marked terminated, and blocks a bare create.
    const dead = await spawnAbducoAgent({
      label,
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cols: 80,
      rows: 24,
    })
    dead.dispose()
    await wait(500)
    expect(await abducoHasSession(label)).toBe(false) // podium reads the label as free

    const session = await spawnAbducoAgent({
      label,
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    try {
      let out = ''
      session.onFrame((f) => {
        out += Buffer.from(f.data).toString('utf8')
      })
      const startedAt = Date.now()
      while (!out.includes('READY') && Date.now() - startedAt < 8000) await wait(25)
      expect(out).toContain('READY') // a NEW agent runs under the reclaimed label
      expect(session.adopted).toBeUndefined()
    } finally {
      session.dispose()
      await killAbducoSession(label)
    }
  })

  it('adopts the live master instead of failing the spawn', { timeout: 20000 }, async () => {
    const label = `podium-ab-collide-${process.pid}-live`
    await killAbducoSession(label)
    const first = await spawnAbducoAgent({
      label,
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    let out = ''
    first.onFrame((f) => {
      out += Buffer.from(f.data).toString('utf8')
    })
    const startedAt = Date.now()
    while (!out.includes('READY') && Date.now() - startedAt < 8000) await wait(25)
    expect(out).toContain('READY')
    // The client dies (daemon restart, detach) but the master keeps the agent —
    // the state a Resume of an "exited" row finds.
    first.dispose()
    await wait(300)
    expect(await abducoHasSession(label)).toBe(true)

    const resumed = await spawnAbducoAgent({
      label,
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    try {
      // Adoption is reported, not silent: the caller must be able to say
      // "reattached" rather than claim it started something.
      expect(resumed.adopted).toBe(true)
      let out2 = ''
      resumed.onFrame((f) => {
        out2 += Buffer.from(f.data).toString('utf8')
      })
      await wait(500)
      // Round-trip input to prove this is the SAME, still-live agent (abduco
      // replays no history, so liveness is the only observable).
      resumed.write(Buffer.from('yo\r', 'utf8').toString('base64'))
      // An adopted attach is size-neutral, so it repaints with Ctrl-L (0x0c)
      // instead of a resize [spec:SP-6144]. That keystroke can still be in flight
      // when this input goes out, and the agent then reads both as one chunk —
      // harmless, but it means the echo is not always the typed bytes alone.
      const typed = /ECHO\[(?:0c)?796f/
      const echoStart = Date.now()
      while (!typed.test(out2) && Date.now() - echoStart < 8000) await wait(25)
      expect(out2).toMatch(typed)
    } finally {
      resumed.dispose()
      await killAbducoSession(label)
    }
  })
})
