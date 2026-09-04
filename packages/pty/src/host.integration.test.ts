/**
 * SPEC-6 acceptance, items 1–11: the podium-host binary driven from Node through
 * the real adapter. Every claim the host makes over abduco is exercised against a
 * child that reports its own TIOCGWINSZ and counts every SIGWINCH — only the
 * child can say whether it was signalled.
 *
 * Integration lane (a C compile, real processes, real ptys); never the unit lane.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveHostBin } from './host-bin.js'
import {
  attachHostAgent,
  connectHost,
  createHostFrameDecoder,
  encodeHello,
  encodeHostFrame,
  HOST_TAIL,
  type HostAgentSession,
  HostErr,
  HostFrame,
  hostHasSession,
  hostSocketDir,
  hostSocketPath,
  killHostSession,
  listLiveHostLabels,
  spawnHostAgent,
} from './host.js'
import type { AgentSession } from './session.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const WINSIZE_FIXTURE = fileURLToPath(new URL('../test/fixtures/winsize-log.mjs', import.meta.url))

/** Prints numbered lines as fast as it can, forever: every byte is accounted for. */
const COUNTING_SRC = `
let n = 0
const tick = () => { for (let i = 0; i < 50; i++) process.stdout.write(\`L\${n++}\\n\`) ; setTimeout(tick, 5) }
tick()
`

let root = ''
let bin = ''
let countingFixture = ''
const saved: Record<string, string | undefined> = {}
const labels: string[] = []
const sessions: AgentSession[] = []

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}
function reader(session: AgentSession): { text: () => string } {
  let buf = ''
  session.onFrame((f) => {
    buf += Buffer.from(f.data).toString('utf8')
  })
  return { text: () => buf }
}
const winches = (text: string): Array<{ n: number; cols: number; rows: number }> =>
  [...text.matchAll(/SIGWINCH#(\d+) cols=(\d+) rows=(\d+)/g)].map((m) => ({
    n: Number(m[1]),
    cols: Number(m[2]),
    rows: Number(m[3]),
  }))

function label(tag: string): string {
  const l = `podium-host-itest-${process.pid}-${tag}-${labels.length}`
  labels.push(l)
  return l
}

async function spawn(tag: string, cmd: string, args: string[], cols = 80, rows = 24): Promise<HostAgentSession> {
  const s = await spawnHostAgent({ label: label(tag), cmd, args, cols, rows })
  sessions.push(s)
  return s
}

/** Raw create, bypassing the adapter: for the stale/live socket and --no-pty cases. */
function rawCreate(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(bin, ['create', ...args], { encoding: 'utf8', env: process.env })
  return { status: r.status, stderr: r.stderr ?? '' }
}

beforeAll(() => {
  if (!hasCompiler) return
  root = mkdtempSync(join(tmpdir(), 'podium-host-it-'))
  for (const k of ['PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_NO_SCOPE', 'PODIUM_HOST_BIN']) {
    saved[k] = process.env[k]
  }
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 'sock')
  process.env.PODIUM_NO_SCOPE = '1' // the scope is abduco's test, not the host's
  delete process.env.PODIUM_HOST_BIN
  bin = resolveHostBin({ fresh: true }) as string
  countingFixture = join(root, 'counting.mjs')
  writeFileSync(countingFixture, COUNTING_SRC)
})

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try {
      s.dispose()
    } catch {
      // already gone
    }
  }
  for (const l of labels.splice(0)) {
    try {
      await killHostSession(l)
    } catch {
      // already gone
    }
  }
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resolveHostBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasCompiler)('podium-host: SPEC-6 acceptance', () => {
  it('builds and answers version', () => {
    expect(bin).toBeDefined()
    expect(spawnSync(bin, ['version'], { encoding: 'utf8' }).stdout).toMatch(/^podium-host \S+ features=1/)
  })

  it('1. create + attach: WELCOME carries the child pid and the birth size, which the child sees', async () => {
    const s = await spawn('birth', process.execPath, [WINSIZE_FIXTURE], 101, 31)
    const w = await s.ready
    expect(w.childPid).toBeGreaterThan(0)
    expect(w.hostPid).toBeGreaterThan(0)
    expect(w.hasPty).toBe(true)
    expect({ cols: w.cols, rows: w.rows }).toEqual({ cols: 101, rows: 31 })
    expect(s.pid).toBe(w.childPid)
    expect(s.appliedGeometry).toEqual({ cols: 101, rows: 31 })
    const t = reader(s)
    await waitFor(() => /WINSZ /.test(t.text()), 'the child to report its size')
    // The child's own TIOCGWINSZ IS the birth size: no attach resize moved it there.
    expect(t.text()).toMatch(/WINSZ cols=101 rows=31/)
    expect(winches(t.text())).toHaveLength(0)
    expect(s.adopted).toBeUndefined()
  }, 30_000)

  it('2. RESIZE: a change is acknowledged with the kernel size and one SIGWINCH; the same size is changed=0 and no signal', async () => {
    const s = await spawn('resize', process.execPath, [WINSIZE_FIXTURE], 80, 24)
    await s.ready
    const t = reader(s)
    await waitFor(() => /WINSZ /.test(t.text()), 'startup')

    const r1 = await s.connection.resize(120, 40)
    expect(r1).toEqual({ cols: 120, rows: 40, changed: true })
    await waitFor(() => winches(t.text()).length === 1, 'exactly one SIGWINCH')
    expect(winches(t.text())[0]).toMatchObject({ n: 1, cols: 120, rows: 40 })

    const r2 = await s.connection.resize(120, 40)
    expect(r2).toEqual({ cols: 120, rows: 40, changed: false })
    await wait(500)
    expect(winches(t.text())).toHaveLength(1) // zero new signals

    // Through the AgentSession: resize() sets appliedGeometry from RESIZED.
    s.resize(90, 30)
    await waitFor(() => s.appliedGeometry?.cols === 90, 'appliedGeometry to follow RESIZED')
    expect(s.appliedGeometry).toEqual({ cols: 90, rows: 30 })
    expect(s.geometry()).toEqual({ cols: 90, rows: 30 })
    await waitFor(() => winches(t.text()).length === 2, 'the second real change to signal once')
    expect(await s.connection.size()).toEqual({ cols: 90, rows: 30 })
  }, 30_000)

  it('3. attaching and detaching a second client (writer and reader) signals nothing and writes nothing', async () => {
    const s = await spawn('neutral', process.execPath, [WINSIZE_FIXTURE], 80, 24)
    await s.ready
    const t = reader(s)
    await waitFor(() => /WINSZ /.test(t.text()), 'startup')
    const before = t.text()

    const path = hostSocketPath(labels[0] as string)
    for (const mode of ['writer', 'reader'] as const) {
      const c = connectHost(path, { mode })
      const w = await c.welcome
      expect(w.lease).toBe(false) // the session holds the lease; a second writer is a reader
      c.detach()
      await wait(300)
    }
    // A second attach at a wholly different size, through the adapter, changes nothing either.
    const again = attachHostAgent({ label: labels[0] as string, fromSeq: 'tail' })
    await again.ready
    again.dispose()
    await wait(500)
    expect(winches(t.text())).toHaveLength(0)
    expect(t.text()).toBe(before) // no echoed bytes: nothing reached the child
  }, 30_000)

  it('4. writer lease: a second writer gets lease=0 and ERR 1 on WRITE; after the first detaches a new writer is granted', async () => {
    const s = await spawn('lease', 'cat', [], 80, 24)
    await s.ready
    const path = hostSocketPath(labels[0] as string)

    const second = connectHost(path, { mode: 'writer' })
    expect((await second.welcome).lease).toBe(false)
    await expect(second.write(Buffer.from('x'))).rejects.toMatchObject({ code: HostErr.NOT_WRITER })
    await expect(second.resize(10, 10)).rejects.toMatchObject({ code: HostErr.NOT_WRITER })
    second.detach()

    s.dispose() // DETACH: the lease is released
    await wait(300)
    const third = connectHost(path, { mode: 'writer' })
    let echoed = ''
    third.onData((_seq, d) => {
      echoed += d.toString()
    })
    expect((await third.welcome).lease).toBe(true)
    expect(await third.write(Buffer.from('hello\n'))).toBe(6)
    await waitFor(() => echoed.includes('hello'), 'cat to echo through the ring')
    third.detach()
  }, 30_000)

  it('5. resume: reconnecting with fromSeq = last seq duplicates and misses nothing; an ancient fromSeq gets GAP then data from seqLow', async () => {
    const s = await spawn('resume', process.execPath, [countingFixture], 80, 24)
    const w = await s.ready
    expect(w.seqLow).toBe(0n)
    const path = hostSocketPath(labels[0] as string)
    let all = ''
    s.onFrame((f) => {
      all += Buffer.from(f.data).toString('utf8')
    })
    await waitFor(() => all.length > 20_000, 'some output')
    const resumeAt = s.connection.lastSeq as bigint
    expect(resumeAt).toBe(BigInt(Buffer.byteLength(all)))
    s.dispose()

    // Reconnect from exactly where we left off.
    const again = attachHostAgent({ label: labels[0] as string, socketPath: path, fromSeq: resumeAt })
    sessions.push(again)
    // Listeners BEFORE awaiting WELCOME: the first DATA frames can share its chunk.
    let gap = false
    again.connection.onGap(() => {
      gap = true
    })
    let firstSeq: bigint | undefined
    again.connection.onData((seq, d) => {
      firstSeq ??= seq
      all += d.toString('utf8')
    })
    await again.ready
    await waitFor(() => all.length > 60_000, 'more output after the resume')
    expect(gap).toBe(false)
    expect(firstSeq).toBe(resumeAt)
    // Every line number appears exactly once, in order: no duplicate, no hole.
    const nums = all.split('\n').filter(Boolean).map((l) => Number(l.slice(1)))
    for (let i = 0; i < nums.length; i++) expect(nums[i]).toBe(i)
    again.dispose()

    // Overflow a small ring, then ask for the beginning: GAP, then data from seqLow.
    const l = label('ring')
    const sock = hostSocketPath(l)
    expect(rawCreate(['--socket', sock, '--ring-bytes', '4096', '--', process.execPath, countingFixture]).status).toBe(0)
    const probe = connectHost(sock, { mode: 'reader', fromSeq: HOST_TAIL })
    await probe.welcome
    await waitFor(() => (probe.lastSeq ?? 0n) > 10_000n, 'the small ring to wrap', 10_000)
    probe.destroy()
    const old = connectHost(sock, { mode: 'reader', fromSeq: 0n })
    const gaps: bigint[] = []
    const seqs: bigint[] = []
    old.onGap((low) => gaps.push(low))
    old.onData((seq) => seqs.push(seq))
    const ow = await old.welcome
    expect(ow.seqLow).toBeGreaterThan(0n)
    expect(ow.seqHigh - ow.seqLow).toBeLessThanOrEqual(4096n)
    await waitFor(() => seqs.length > 0, 'data after the gap')
    expect(gaps).toEqual([ow.seqLow])
    expect(seqs[0]).toBe(ow.seqLow)
    old.destroy()
  }, 40_000)

  it('REPLAY: the last N bytes come back with their original seqs, bracketed, and the child sees nothing', async () => {
    const s = await spawn('replay', process.execPath, [countingFixture], 80, 24)
    await s.ready
    let all = ''
    s.onFrame((f) => {
      all += Buffer.from(f.data).toString('utf8')
    })
    await waitFor(() => all.length > 30_000, 'some output')
    s.dispose()
    await wait(200)

    // A fresh client from the tail knows nothing; REPLAY hands it the last 10 000 bytes.
    const c = connectHost(hostSocketPath(labels[0] as string), { mode: 'writer', fromSeq: HOST_TAIL })
    const got: Array<{ seq: bigint; data: Buffer }> = []
    c.onData((seq, d) => got.push({ seq, data: Buffer.from(d) }))
    const w = await c.welcome
    const before = w.seqHigh
    // Pause the child so seqHigh is stable while we compare (SIGSTOP is not
    // SIGWINCH). SIGNAL has no ack and the pty buffer keeps draining after the
    // stop, so PROVE the stop landed: poll STATUS until seqHigh is identical
    // across two reads 150 ms apart, and compute the expectation from that.
    c.signal(19)
    try {
      let st = await c.status()
      const deadline = Date.now() + 5000
      for (;;) {
        await wait(150)
        const again = await c.status()
        if (again.seqHigh === st.seqHigh) break
        st = again
        if (Date.now() > deadline) throw new Error('seqHigh never settled after SIGSTOP')
      }
      // Only frames that arrive AFTER the request are the replay's: the live
      // frames already received cover the same seqs with other chunk boundaries.
      const mark = got.length
      const r = await c.replay(10_000)
      expect(r.from).toBe(st.seqHigh - 10_000n)
      expect(r.bytes).toBe(10_000)
      const replayed = got.slice(mark)
      expect(replayed.at(-1)!.seq + BigInt(replayed.at(-1)!.data.length)).toBe(st.seqHigh)
      expect(replayed[0]?.seq).toBe(r.from)
      // Contiguous, original seqs.
      for (let i = 1; i < replayed.length; i++) {
        const prev = replayed[i - 1] as { seq: bigint; data: Buffer }
        expect(replayed[i]?.seq).toBe(prev.seq + BigInt(prev.data.length))
      }
      const text = Buffer.concat(replayed.map((g) => g.data)).toString('utf8')
      // The line numbers in the replayed tail are the ones that were current: they
      // continue exactly into the live stream's next line.
      const lines = text.split('\n').filter(Boolean)
      const first = Number((lines[1] as string).slice(1)) // lines[0] may be a partial line
      for (let i = 2; i < lines.length - 1; i++) expect(Number((lines[i] as string).slice(1))).toBe(first + i - 1)
      // lastSeq is a max: the replay did not move the resume point backwards.
      expect(c.lastSeq).toBeGreaterThanOrEqual(before)
    } finally {
      // Always resume and tear down, or a retry attaches to a stopped child. The
      // STATUS round trip proves the SIGCONT frame was processed before the
      // socket is destroyed (destroy drops unflushed writes).
      c.signal(18)
      await c.status().catch(() => {})
      c.destroy()
    }

    // Bigger than the ring: everything from seqLow, and the child sees no SIGWINCH.
    const l = label('replay-ring')
    const sock = hostSocketPath(l)
    expect(
      rawCreate(['--socket', sock, '--ring-bytes', '4096', '--cols', '80', '--rows', '24', '--', process.execPath, WINSIZE_FIXTURE]).status,
    ).toBe(0)
    const c2 = connectHost(sock, { mode: 'writer', fromSeq: 0n })
    let out = ''
    c2.onData((_s, d) => {
      out += d.toString()
    })
    await c2.welcome
    await waitFor(() => /WINSZ /.test(out), 'startup')
    const st2 = await c2.status()
    const r2 = await c2.replay(1 << 30)
    expect(r2.from).toBe(st2.seqLow)
    expect(BigInt(r2.bytes)).toBe(st2.seqHigh - st2.seqLow)
    await wait(400)
    expect(winches(out)).toHaveLength(0)
    c2.destroy()
  }, 40_000)

  it('6. exit: the real code reaches every client; STATUS during linger returns it; after linger the socket and host are gone', async () => {
    const l = label('exit')
    const sock = hostSocketPath(l)
    expect(
      rawCreate(['--socket', sock, '--linger-secs', '2', '--', 'sh', '-c', 'echo bye; exit 7']).status,
    ).toBe(0)
    const a = connectHost(sock, { mode: 'writer', fromSeq: 0n })
    const b = connectHost(sock, { mode: 'reader', fromSeq: 0n })
    const exits: Array<[number, number]> = []
    a.onExit((c, sgn) => exits.push([c, sgn]))
    b.onExit((c, sgn) => exits.push([c, sgn]))
    let out = ''
    a.onData((_s, d) => {
      out += d.toString()
    })
    const w = await a.welcome
    await waitFor(() => exits.length === 2, 'EXITED at both clients')
    expect(exits).toEqual([
      [7, 0],
      [7, 0],
    ])
    expect(out).toContain('bye')
    const st = await a.status()
    expect(st).toMatchObject({ alive: false, exitCode: 7, signal: 0 })
    a.destroy()
    b.destroy()
    // A late client during linger still gets the replay and the exit.
    const late = connectHost(sock, { mode: 'reader', fromSeq: 0n })
    const lateExit = new Promise<number>((r) => late.onExit((c) => r(c)))
    await late.welcome
    expect(await lateExit).toBe(7)
    late.destroy()
    await waitFor(
      () => {
        try {
          statSync(sock)
          return false
        } catch {
          return true
        }
      },
      'the socket to be unlinked after linger',
      6000,
    )
    await waitFor(
      () => {
        try {
          process.kill(w.hostPid, 0)
          return false
        } catch {
          return true
        }
      },
      'the host process to exit',
      3000,
    )
  }, 30_000)

  it('7. KILL: SIGTERM first; a child that ignores it is SIGKILLed after 5 s; EXITED carries the signal', async () => {
    const l = label('kill')
    const sock = hostSocketPath(l)
    expect(
      rawCreate([
        '--socket',
        sock,
        '--',
        'sh',
        '-c',
        'trap "echo ignored-term" TERM; echo up; while :; do sleep 0.2; done',
      ]).status,
    ).toBe(0)
    const c = connectHost(sock, { mode: 'writer', fromSeq: 0n })
    let out = ''
    c.onData((_s, d) => {
      out += d.toString()
    })
    await c.welcome
    await waitFor(() => out.includes('up'), 'the child to start')
    const exit = new Promise<[number, number]>((r) => c.onExit((code, sgn) => r([code, sgn])))
    const t0 = Date.now()
    c.kill()
    await waitFor(() => out.includes('ignored-term'), 'SIGTERM to reach the child')
    const [code, sgn] = await exit
    const took = Date.now() - t0
    expect(sgn).toBe(9)
    expect(code).toBe(128 + 9)
    expect(took).toBeGreaterThanOrEqual(4500)
    expect(took).toBeLessThan(9000)
    c.destroy()
  }, 30_000)

  it('8. --no-pty: stdin/stdout round trip through the ring; RESIZE is refused with ERR 2', async () => {
    const l = label('nopty')
    const sock = hostSocketPath(l)
    expect(rawCreate(['--socket', sock, '--no-pty', '--', 'cat']).status).toBe(0)
    const c = connectHost(sock, { mode: 'writer', fromSeq: 0n })
    let out = ''
    c.onData((_s, d) => {
      out += d.toString()
    })
    const w = await c.welcome
    expect(w.hasPty).toBe(false)
    expect(await c.write(Buffer.from('ping\n'))).toBe(5)
    await waitFor(() => out === 'ping\n', 'cat to echo through pipes')
    await expect(c.resize(10, 10)).rejects.toMatchObject({ code: HostErr.NO_PTY })
    await expect(c.size()).rejects.toMatchObject({ code: HostErr.NO_PTY })
    c.destroy()
  }, 30_000)

  it('9. a stale socket file is replaced by create; a live one makes create exit 3', async () => {
    const l = label('stale')
    const sock = hostSocketPath(l)
    // Live: something listens there, so create refuses with exit 3.
    const srv = createServer()
    await new Promise<void>((r) => srv.listen(sock, r))
    expect(rawCreate(['--socket', sock, '--', 'sleep', '30']).status).toBe(3)
    await new Promise<void>((r) => srv.close(() => r()))
    // Stale: a listener that exits without unlinking leaves a file nobody answers.
    spawnSync(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`,
    ])
    expect(statSync(sock).isSocket()).toBe(true)
    expect(rawCreate(['--socket', sock, '--', 'sleep', '30']).status).toBe(0)
    expect(await hostHasSession(l)).toBe(true)
    expect(await listLiveHostLabels()).toContain(l)
  }, 30_000)

  it('10. framing: one-byte chunks work; a bad type closes only that connection', async () => {
    const s = await spawn('framing', 'cat', [], 80, 24)
    await s.ready
    const path = hostSocketPath(labels[0] as string)
    const raw = createConnection(path)
    await new Promise<void>((r) => raw.once('connect', r))
    const decode = createHostFrameDecoder()
    const got: number[] = []
    raw.on('data', (d: Buffer) => {
      for (const f of decode(d)) got.push(f.type)
    })
    const hello = encodeHello('reader', HOST_TAIL)
    for (const byte of hello) {
      raw.write(Buffer.from([byte]))
      await wait(2)
    }
    const status = encodeHostFrame(HostFrame.STATUS)
    for (const byte of status) {
      raw.write(Buffer.from([byte]))
      await wait(2)
    }
    await waitFor(() => got.includes(HostFrame.STATUS_REPLY), 'a reply to byte-by-byte frames')
    expect(got[0]).toBe(HostFrame.WELCOME)

    const closed = new Promise<void>((r) => raw.once('close', () => r()))
    raw.write(encodeHostFrame(0x7f)) // no such type
    await closed
    expect(got.at(-1)).toBe(HostFrame.ERR)
    // The session's own connection is untouched.
    expect(await s.connection.status()).toMatchObject({ alive: true })
  }, 30_000)

  it('11. the socket is 0600 in a 0700 directory; a foreign uid is refused (skipped without a second uid)', async () => {
    const s = await spawn('mode', 'cat', [], 80, 24)
    await s.ready
    const sock = hostSocketPath(labels[0] as string)
    expect(statSync(sock).mode & 0o777).toBe(0o600)
    expect(statSync(hostSocketDir()).mode & 0o777).toBe(0o700)
    // A second uid needs root or sudo -n; neither is assumed here.
    const canSudo = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
    if (!canSudo || process.getuid?.() === 0) {
      console.log('SKIP peer-uid refusal: no second uid available on this host (sudo -n refused)')
      return
    }
    const r = spawnSync(
      'sudo',
      ['-n', '-u', 'nobody', process.execPath, '-e', `require('node:net').createConnection(${JSON.stringify(sock)}).on('close',()=>process.exit(0)).on('error',()=>process.exit(2)).write(Buffer.from([0,0,0,1,5]))`],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(r.status).toBe(0) // connected, then closed by the host without an answer
  }, 30_000)
})
