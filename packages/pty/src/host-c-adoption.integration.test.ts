/**
 * A C HOST AN OLDER DAEMON STARTED IS STILL ADOPTED (POD-4986).
 *
 * The C podium-host is gone from the tree, the build and the release; the
 * Rust host is the only one a new spawn selects. Sessions that were already
 * running on a C host when a machine updated keep running in it, and the
 * daemon keeps them: `DurableProcess` locates, attaches (with the writer
 * lease), lists and kills a C host through the one protocol both hosts speak.
 * Nothing about a C host's socket depends on having its binary.
 *
 * The C host binary is a FIXTURE, built from `packages/pty/vendor/podium-host/
 * host.c` before that source was deleted (git history has it: build it with
 * `cc -std=c11 -D_POSIX_C_SOURCE=200809L -D_XOPEN_SOURCE=700 -D_DARWIN_C_SOURCE
 * -DNDEBUG '-DVERSION="1-podium"' host.c -o podium-host-c -lutil`) and named by
 * `PODIUM_TEST_C_HOST_BIN`. Without it the suite skips: there is no C source
 * left to build one from.
 *
 * Integration lane (real processes, real ptys); never the unit lane.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDurableProcess } from './durable-process.js'
import { type HostDurableAttachment, hostCreateArgs, hostSocketDir, hostSocketPath } from './host.js'
import { hostBinFeatures, resolveHostBin } from './host-bin.js'

const C_HOST = process.env.PODIUM_TEST_C_HOST_BIN
const haveCHost = !!C_HOST && existsSync(C_HOST) && hostBinFeatures(C_HOST) === 1

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

describe.skipIf(!haveCHost)('a running C host is adopted, never spawned (POD-4986)', () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const pids: number[] = []

  beforeAll(() => {
    // A private SHORT socket root: never the live hosts under the runtime dir.
    root = mkdtempSync(join(tmpdir().length < 20 ? tmpdir() : '/tmp', 'pc-'))
    for (const k of ['PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_NO_SCOPE', 'PODIUM_HOST_BIN']) {
      saved[k] = process.env[k]
    }
    process.env.PODIUM_STATE_DIR = join(root, 'st')
    process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
    process.env.PODIUM_NO_SCOPE = '1'
    delete process.env.PODIUM_HOST_BIN
    mkdirSync(hostSocketDir(), { recursive: true, mode: 0o700 })
  })

  afterAll(() => {
    // Only the host pids this suite recorded from its private sockets.
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resolveHostBin({ fresh: true })
    if (root) rmSync(root, { recursive: true, force: true })
  })

  /** What an older daemon did: `podium-host create` with the C binary. */
  function createOnCHost(label: string): void {
    const r = spawnSync(
      C_HOST as string,
      hostCreateArgs({ socketPath: hostSocketPath(label), cwd: root, cmd: '/bin/cat', cols: 90, rows: 30 }),
      { encoding: 'utf8', env: process.env },
    )
    expect(r.status, r.stderr).toBe(0)
  }

  it('locates, attaches with the lease, round-trips bytes, lists, and kills a C host', async () => {
    const label = 'c-old'
    createOnCHost(label)
    const durable = createDurableProcess()

    const located = await durable.locate(label, process.env, { waitMs: 2000 })
    expect(located?.socketPath).toBe(hostSocketPath(label))
    const found = await located?.adapter.attach({
      label,
      socketPath: located.socketPath,
      requireLease: true,
      lastKnownGeometry: { cols: 80, rows: 24 },
    })
    const attachment = found?.attachment as HostDurableAttachment
    const welcome = await attachment.ready
    pids.push(welcome.hostPid)
    try {
      // It IS the C host: its binary, its protocol level (no features byte).
      expect(readlinkSync(`/proc/${welcome.hostPid}/exe`)).toBe(C_HOST)
      expect(welcome.features).toBe(0)
      expect(welcome.screen).toBe(false)
      expect(welcome.lease).toBe(true)
      expect({ cols: welcome.cols, rows: welcome.rows }).toEqual({ cols: 90, rows: 30 })

      let out = ''
      attachment.onFrame((f) => {
        out += Buffer.from(f.data).toString('utf8')
      })
      attachment.writeBytes(Buffer.from('still C\r'))
      await waitFor(() => out.includes('still C'), 'the C host to echo through cat')

      expect(await durable.has(label)).toBe(true)
      expect(await durable.list()).toContain(label)
    } finally {
      attachment.dispose()
    }

    await durable.kill(label)
    await waitFor(() => !existsSync(hostSocketPath(label)), 'the C host to exit and unlink its socket')
    expect(await durable.has(label)).toBe(false)
  }, 30_000)

  it.skipIf(process.platform !== 'linux' || resolveHostBin() === undefined)(
    'a new spawn under a fresh label runs the Rust host, beside a live C host',
    async () => {
      createOnCHost('c-beside')
      const durable = createDurableProcess()
      const s = (await durable.spawn({
        label: 'rs-new',
        cmd: '/bin/cat',
        cols: 80,
        rows: 24,
        cwd: root,
      })) as HostDurableAttachment
      const w = await s.ready
      pids.push(w.hostPid)
      try {
        expect(readlinkSync(`/proc/${w.hostPid}/exe`)).not.toBe(C_HOST)
        expect(w.features & 1).toBe(1) // the Rust screen host
        expect(hostBinFeatures(readlinkSync(`/proc/${w.hostPid}/exe`))).toBe(2)
        expect(await durable.list()).toEqual(expect.arrayContaining(['c-beside', 'rs-new']))
      } finally {
        s.dispose()
        await durable.kill('rs-new')
        await durable.kill('c-beside')
      }
    },
    60_000,
  )
})
