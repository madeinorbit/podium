/**
 * RUNNING abduco SESSIONS ARE ADOPTED, NEVER CREATED (POD-4986).
 *
 * Every Podium release before POD-4986 ran its sessions on abduco. podium-host
 * is now the only host a spawn uses, but a customer who upgrades keeps every
 * session that is already running: `createDurableProcess()` locates an abduco
 * master by its socket, attaches to it (size-neutral, through the vendored
 * attach client), counts it in the census, and kills it — beside host sessions,
 * which is where every NEW spawn goes.
 *
 * Each master here is created the way those releases did: `abduco -n <label>
 * <cmd>` with the vendored build, no scope, in a private SHORT
 * ABDUCO_SOCKET_DIR (it exists, so abduco never falls through to
 * $HOME/.abduco). Host sockets go to a private PODIUM_HOST_SOCKET_DIR under the
 * same root, never the live runtime directory. Only the sessions and host pids
 * this file created are ever signalled.
 *
 * Integration lane (real processes, a C compile, real PTYs); never the unit
 * lane. Without a C compiler there is no abduco to build and the real-session
 * suites skip.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  abducoHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  killAbducoSession,
  parseAbducoList,
  reapAbducoTestSessions,
  waitForAbducoSocket,
} from './abduco.js'
import { buildVendoredAbduco, resolveAbducoBin } from './abduco-bin.js'
import { bunTerminalBackend } from './backends/index.js'
import { abducoAdoptionAdapter, createDurableProcess } from './durable-process.js'
import { type HostDurableAttachment, hostSocketDir, hostSocketPath } from './host.js'
import { hostBinFeatures, resolveHostBin } from './host-bin.js'
import { type DurableAttachment, spawnAgent } from './session.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const bunPty = bunTerminalBackend()
const bunBin = process.execPath
const FIXTURE = fileURLToPath(new URL('../test/fixtures/echo-title.mjs', import.meta.url))
const HEX_FIXTURE = fileURLToPath(new URL('../test/fixtures/stdin-hex.mjs', import.meta.url))
const TUI_FIXTURE = fileURLToPath(new URL('../test/fixtures/fixture-tui.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

let root = ''
let bin: string | undefined
const ENV_KEYS = [
  'PODIUM_ABDUCO',
  'ABDUCO_SOCKET_DIR',
  'PODIUM_NO_SCOPE',
  'PODIUM_HOST_SOCKET_DIR',
  'PODIUM_STATE_DIR',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
/** Host pids this file spawned, with the binary each ran. */
const hostPids: Array<{ pid: number; exe: string }> = []

beforeAll(() => {
  if (!hasCompiler) return
  // SHORT on purpose: abduco composes `<root>/abduco/<user>/<label>@<host>`
  // into a 108-byte sun_path, and a hermetic TMPDIR can be long.
  root = mkdtempSync('/tmp/pab-')
  bin = buildVendoredAbduco(join(root, 'bin', 'abduco'))
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  if (bin) process.env.PODIUM_ABDUCO = bin
  process.env.ABDUCO_SOCKET_DIR = root
  process.env.PODIUM_NO_SCOPE = '1'
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
  process.env.PODIUM_STATE_DIR = join(root, 'st')
  mkdirSync(hostSocketDir(), { recursive: true, mode: 0o700 })
  resolveAbducoBin({ fresh: true })
})

// POD-107: the in-test kills sit on the happy path — a failed assertion or
// timeout leaks the detached master. Sweep every label this file creates, for
// this pid (this run, pass or fail) and for dead pids (crashed prior runs).
afterAll(async () => {
  if (!hasCompiler) return
  if (bin) {
    await reapAbducoTestSessions([
      /^podium-abduco-itest-(\d+)$/,
      /^podium-abduco-repaint-(\d+)$/,
      /^podium-abfid-(\d+)-[0-9a-f]+$/,
      /^podium-reaptest-(\d+)$/,
      /^podium-pab-(\d+)-[a-z]+$/,
    ])
  }
  // Only a host this file spawned, and only while that pid still runs it.
  for (const { pid, exe } of hostPids) {
    try {
      if (readlinkSync(`/proc/${pid}/exe`) === exe) process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resolveAbducoBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * What every Podium release before POD-4986 did to start a session: `abduco
 * -n`, which daemonizes the master and returns. Bun's execFileSync ignores
 * mid-process env changes unless handed the env, so it is passed explicitly.
 */
async function createOnAbduco(label: string, cmd: string, args: string[] = []): Promise<string> {
  execFileSync(bin as string, ['-n', label, cmd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  return waitForAbducoSocket(label, { ABDUCO_SOCKET_DIR: root })
}

/**
 * That release's create attach, right after `-n`: NOT size-neutral, since its
 * resize packet is what moved the program off abduco's own 80x25.
 */
async function createAndAttach(
  label: string,
  cmd: string,
  args: string[],
): Promise<DurableAttachment> {
  const socketPath = await createOnAbduco(label, cmd, args)
  return attachAbducoAgent({ label, socketPath, cols: 80, rows: 24 })
}

/**
 * The daemon's env for a probe, with $HOME moved aside: locate sweeps stale
 * bind temps in every rung it reads, and the user's own `~/.abduco` is not
 * this test's to sweep.
 */
const probeEnv = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: join(root, 'home') })

function masterPid(label: string): number {
  const listing = spawnSync(bin as string, [], { encoding: 'utf8', env: { ...process.env } })
  const entry = parseAbducoList(listing.stdout ?? '').find((s) => s.name === label)
  expect(entry, `abduco lists ${label}`).toBeDefined()
  return (entry as { pid: number }).pid
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
  // A zombie has ended; it only waits for its parent to reap it.
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return process.platform !== 'linux'
  }
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

describe('the abduco adapter adopts, and never creates (POD-4986)', () => {
  it('refuses every create verb; createDurableProcess spawns only on the host', async () => {
    const adapter = abducoAdoptionAdapter()
    expect(adapter.kind).toBe('abduco')
    const label = 'podium-pab-never'
    await expect(adapter.spawn({ label, cmd: '/bin/cat', cols: 80, rows: 24 })).rejects.toThrow(
      /adopted, never created/,
    )
    await expect(adapter.spawnHeadless({ label, cmd: '/bin/cat' })).rejects.toThrow(
      /adopted, never created/,
    )
    await expect(adapter.attachHeadless({ label })).rejects.toThrow(/adopted, never created/)

    const durable = createDurableProcess()
    expect(durable.backend).toBe('host')
    expect(durable.primary.kind).toBe('host')
    expect(durable.all.map((a) => a.kind)).toEqual(['host', 'abduco'])
  })
})

describe.skipIf(!hasCompiler)(
  'a running abduco session is adopted (needs a C compiler to build abduco)',
  () => {
    it('locates, attaches size-neutrally, round-trips bytes through cat, lists and kills it', async () => {
      expect(bin).toBeDefined()
      const label = `podium-pab-${process.pid}-cat`
      const socket = await createOnAbduco(label, '/bin/cat')
      const durable = createDurableProcess()

      const located = await durable.locate(label, probeEnv(), { waitMs: 2000 })
      expect(located?.adapter.kind).toBe('abduco')
      expect(located?.socketPath).toBe(socket)
      // The daemon asks for the lease on every headed attach; abduco has none to
      // grant, so the attach goes ahead without it.
      const found = await located?.adapter.attach({
        label,
        socketPath: located.socketPath,
        requireLease: true,
        lastKnownGeometry: { cols: 80, rows: 24 },
      })
      expect(found?.cmd).toBe(`abduco -a ${socket}`)
      const attachment = found?.attachment as DurableAttachment
      try {
        let out = ''
        attachment.onFrame((f) => {
          out += Buffer.from(f.data).toString('utf8')
        })
        await wait(500) // the attach client takes its pty out of canonical mode
        attachment.writeBytes(Buffer.from('still abduco\r'))
        // At least twice: the program's tty echo and cat's own copy. An echo by
        // the attach pty alone, with nothing reaching cat, says it once.
        await waitFor(
          () => occurrences(out, 'still abduco') >= 2,
          'cat to echo through the adopted master',
        )

        expect(await durable.has(label)).toBe(true)
        expect(await durable.list()).toContain(label)
        expect(durable.hasMasterSync(label, probeEnv())).toBe(true)
      } finally {
        attachment.dispose()
      }

      // The master outlives its client, as it outlived the daemon that created it.
      await wait(300)
      expect(await durable.has(label)).toBe(true)

      const master = masterPid(label)
      await durable.kill(label)
      await waitFor(() => !existsSync(socket), 'the master to exit and unlink its socket')
      await waitFor(() => !pidAlive(master), 'the master process to end')
      expect(await durable.has(label)).toBe(false)
      expect(await durable.list()).not.toContain(label)
    }, 30_000)

    it.skipIf(process.platform !== 'linux' || resolveHostBin() === undefined)(
      'a new spawn goes to podium-host beside an adopted abduco session, and the census lists both',
      async () => {
        const abLabel = `podium-pab-${process.pid}-beside`
        const hostLabel = `podium-pab-${process.pid}-host`
        const socket = await createOnAbduco(abLabel, '/bin/cat')
        const durable = createDurableProcess()
        const s = (await durable.spawn({
          label: hostLabel,
          cmd: '/bin/cat',
          cols: 80,
          rows: 24,
          cwd: root,
        })) as HostDurableAttachment
        const w = await s.ready
        const exe = readlinkSync(`/proc/${w.hostPid}/exe`)
        hostPids.push({ pid: w.hostPid, exe })
        try {
          // The Rust podium-host, by what it reports — never by its file name.
          expect(hostBinFeatures(exe)).toBe(2)
          expect(existsSync(hostSocketPath(hostLabel))).toBe(true)
          // Nothing was created on abduco for the new label.
          expect(abducoSocketPath(hostLabel, probeEnv())).toBeUndefined()

          expect((await durable.locate(hostLabel, probeEnv()))?.adapter.kind).toBe('host')
          const adopted = await durable.locate(abLabel, probeEnv())
          expect(adopted?.adapter.kind).toBe('abduco')
          expect(adopted?.socketPath).toBe(socket)
          expect(await durable.list()).toEqual(expect.arrayContaining([abLabel, hostLabel]))
          expect(await durable.has(abLabel)).toBe(true)
          expect(await durable.has(hostLabel)).toBe(true)
        } finally {
          s.dispose()
          await durable.kill(hostLabel)
          await durable.kill(abLabel)
        }
        await waitFor(() => !existsSync(socket), 'the adopted master to exit')
        await waitFor(() => !existsSync(hostSocketPath(hostLabel)), 'the host to exit')
      },
      60_000,
    )
  },
)

describe.skipIf(!hasCompiler)('abduco integration (needs a C compiler to build abduco)', () => {
  // Resource-sensitive under concurrent suite load (abduco + many PTYs); one retry.
  it('streams frames, surfaces the OSC title, round-trips input, survives detach, reattaches, kills', {
    retry: 1,
    timeout: 20000,
  }, async () => {
    const label = `podium-abduco-itest-${process.pid}`
    await killAbducoSession(label)
    const session = await createAndAttach(label, bunBin, [FIXTURE])
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data).toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    const readyStart = Date.now()
    while (!out.includes('READY') && Date.now() - readyStart < 8000) await wait(25)
    expect(out).toContain('READY') // byte-transparency
    expect(out).not.toContain('\x1b[?1049h') // client attach chrome stripped
    expect(title).toContain('FIXTURE-TITLE') // OSC passes through verbatim

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out).toContain('ECHO[6869') // input reached the agent (canonical pty: CR flushes the line)

    // dispose() kills the attach client; the abduco master + agent survive.
    session.dispose()
    await wait(300)
    expect(await abducoHasSession(label)).toBe(true)

    // Reattach: abduco does not replay history, so prove liveness via a fresh
    // input round-trip rather than a repaint.
    const re = attachAbducoAgent({ label, cols: 80, rows: 24 })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data).toString('utf8')
    })
    await wait(500)
    re.write(Buffer.from('yo\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out2).toContain('ECHO[796f')
    expect(out2).not.toContain('\x1b[?1049h')
    re.dispose()

    // explicit kill terminates the agent.
    await killAbducoSession(label)
    await wait(300)
    expect(await abducoHasSession(label)).toBe(false)
  })

  it('reattach at UNCHANGED geometry still repaints (the attach packet signals the program)', async () => {
    // The vendored master SIGWINCHes the program on every resize packet, even
    // one that changes nothing, and fixture-tui repaints exclusively on a
    // signal — so this proves a same-size reattach still repaints a TUI.
    const label = `podium-abduco-repaint-${process.pid}`
    await killAbducoSession(label)
    const session = await createAndAttach(label, bunBin, [TUI_FIXTURE])
    await wait(800)
    session.dispose()
    await wait(300)

    const re = attachAbducoAgent({ label, cols: 80, rows: 24 }) // same geometry
    let out = ''
    re.onFrame((f) => {
      out += Buffer.from(f.data).toString('utf8')
    })
    await wait(1200)
    expect(out).toContain('PODIUM-FIXTURE') // repainted despite unchanged size
    expect(out).toContain('rows=24') // and settled back at the requested geometry
    re.dispose()
    await killAbducoSession(label)
  }, 15000)

  it('teardown sweep kills own-pid and dead-spawner sessions, spares a live foreign spawner', async () => {
    // POD-107: the sweep decides by the pid embedded in the label — this process's
    // sessions die (pass or fail), a crashed prior run's die (spawner gone), and a
    // CONCURRENT run's survive (spawner alive and not us; pid 1 stands in for it).
    // All three live in this file's private socket directory.
    const mine = `podium-reaptest-${process.pid}`
    const crashed = `podium-reaptest-${2 ** 30}` // beyond pid_max — guaranteed dead
    const foreign = 'podium-reaptest-1' // pid 1 is alive and never ours
    try {
      for (const label of [mine, crashed, foreign]) await createOnAbduco(label, bunBin, [FIXTURE])
      for (const label of [mine, crashed, foreign]) {
        expect(await abducoHasSession(label)).toBe(true)
      }

      const reaped = await reapAbducoTestSessions([/^podium-reaptest-(\d+)$/])
      await wait(500)
      expect(reaped.sort()).toEqual([mine, crashed].sort())
      expect(await abducoHasSession(mine)).toBe(false)
      expect(await abducoHasSession(crashed)).toBe(false)
      expect(await abducoHasSession(foreign)).toBe(true)
    } finally {
      for (const label of [mine, crashed, foreign]) await killAbducoSession(label)
    }
  }, 15000)
})

describe.skipIf(!hasCompiler)(
  'abduco input-fidelity parity (needs a C compiler to build abduco)',
  () => {
    // The byte sequences that matter for agent control — including 0x1c (Ctrl-\),
    // abduco's DEFAULT detach key, which must arrive because we remap it to 0xff.
    const SAMPLES: Record<string, string> = {
      ctrlC: '03',
      ctrlBackslash: '1c',
      altX: '1b78', // ESC + 'x'  (Meta-x)
      upArrow: '1b5b41', // ESC [ A
      utf8: 'c3a9', // 'é'
    }

    async function received(via: 'abduco' | 'direct', hex: string): Promise<string> {
      const bytes = Buffer.from(hex, 'hex')
      let out = ''
      let session: DurableAttachment
      let label = ''
      if (via === 'abduco') {
        label = `podium-abfid-${process.pid}-${hex}`
        await killAbducoSession(label)
        // Adopted the way the daemon now attaches: size-neutral (`-N`), so the
        // detach-key remap is proven on the argv the adoption path runs.
        const socketPath = await createOnAbduco(label, bunBin, [HEX_FIXTURE])
        session = attachAbducoAgent({
          label,
          socketPath,
          sizeNeutral: true,
          fallbackGeometry: { cols: 80, rows: 24 },
          backend: bunPty,
        })
        await wait(300) // the attach client takes its pty out of canonical mode
      } else {
        session = spawnAgent({ cmd: bunBin, args: [HEX_FIXTURE], cols: 80, rows: 24 }, bunPty)
      }
      session.onFrame((f) => {
        out += Buffer.from(f.data).toString('utf8')
      })
      // Probe with a non-control byte first so setRawMode is live before Ctrl-C (0x03).
      session.write(Buffer.from([0x61]).toString('base64')) // 'a'
      const probeStart = Date.now()
      while (!out.includes('<61>') && Date.now() - probeStart < 5000) await wait(25)
      out = ''
      session.write(bytes.toString('base64'))
      const start = Date.now()
      while (!out.includes(hex) && Date.now() - start < 5000) await wait(25)
      session.dispose()
      if (via === 'abduco') await killAbducoSession(label)
      const m = out.match(/<([0-9a-f]*)>/g)
      return (m ?? []).join('')
    }

    for (const [name, hex] of Object.entries(SAMPLES)) {
      it(`delivers ${name} (${hex}) through an adopted abduco session identically to direct Bun.Terminal`, async () => {
        const direct = await received('direct', hex)
        const abduco = await received('abduco', hex)
        expect(direct).toContain(hex) // sanity: direct path delivers the bytes
        expect(abduco).toContain(hex) // PARITY: abduco delivers the same bytes
      }, 15000)
    }
  },
)
