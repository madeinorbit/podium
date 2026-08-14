/**
 * THE LIVE RE-PROOF FOR POD-2059: a REAL `opencode attach` against a REAL
 * `opencode serve`, under a REAL abduco master in its own systemd scope.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `opencode-attach.test.ts`
 * ---------------------------------------------------------------------------
 *
 * The unit suite next door proves everything that is OURS: the label, the argv,
 * where the secret rides, the warm window, the reaper. What it cannot prove is
 * the claim this whole issue rests on — that opencode's own client will
 * authenticate FROM THE ENVIRONMENT and come up against this session's loopback
 * server. Only opencode can witness that, and opencode is not installed on every
 * machine that runs the suite.
 *
 * OPT-IN via `PODIUM_OPENCODE_LIVE=1`, the same switch and the same argument as
 * `packages/agent-runtime/src/drivers/opencode/live-secret.test.ts`: booting a
 * ~180MB binary is a minute of wall clock and a flake risk on a loaded box, and
 * a gate that is occasionally red for reasons unrelated to the change is a gate
 * people learn to ignore.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RUN ACTUALLY OBSERVES (opencode 1.18.16, recorded 2026-08-14)
 * ---------------------------------------------------------------------------
 *
 * THE SIGNAL IS THE HANDSHAKE, NOT A PAINTED SCREEN, and that distinction is the
 * whole reason this file is worded the way it is. opencode's TUI is opentui: the
 * first thing it does on a PTY is INTERROGATE the terminal — `CSI ?…$p` mode
 * queries, `DCS +q…` capability requests, cursor-position reports, the
 * iTerm/kitty probes — and it waits for the answers before it draws. Nothing
 * answers here: the frames go to a relay, and the viewer that would reply is
 * attach v2's (see the gap note in `opencode-attach.ts`). So a correct attach on
 * this build produces a few hundred bytes of negotiation and then goes quiet,
 * and a test that asserted "the conversation is on screen" would be asserting
 * something this build cannot do.
 *
 * What DOES separate a working attach from a broken one is measurable, and both
 * halves were measured in the same window:
 *
 *   - SECRET FROM THE ENV, argv carrying nothing but the url and `--session`
 *       → 289 bytes of terminal handshake, no error, master alive. The scope
 *         listing showed `podium-oc-attach-<id>.scope` running
 *         `abduco -n podium-oc-attach-<id> opencode attach http://127.0.0.1:…
 *         --session ses_…` — the credential nowhere in that line.
 *   - A WRONG SECRET, everything else identical
 *       → `Error: opencode server GET …/session/ses_… → 401 Unauthorized`,
 *         printed in words, then the terminal restored and the client GONE —
 *         its master dies with it.
 *
 * One string changed, two completely different outcomes: that pair is what makes
 * "the credential travelled in the environment" a measurement rather than an
 * inference, and it is what the two cases below pin.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { asSessionId, type SessionId } from '@podium/model'
import { abducoHasSession } from '@podium/pty'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attributeMemory, snapshotProcesses } from '../memory-breakdown'
import { createOpencodeClientTerminals, opencodeAttachLabel } from './opencode-attach'
import { opencodeScopeLabel } from './opencode-server'

const LIVE = process.env.PODIUM_OPENCODE_LIVE === '1'
/** Two sessions, two attachments, ONE server — booting the binary twice would
 *  double the slowest part of the run for no extra evidence. */
const GOOD = asSessionId('99999999-9999-4999-8999-999999999999')
const BAD = asSessionId('88888888-8888-4888-8888-888888888888')
const SECRET = 'live-attach-secret-0123456789abcdef'
const USERNAME = 'podium'
const READY_TIMEOUT_MS = 120_000
/** Long enough for a client on a loaded box to reach the terminal, and the SAME
 *  window both cases are judged in — a shorter one for the negative case would
 *  make "no bytes" mean nothing. */
const HANDSHAKE_WINDOW_MS = 90_000
const CASE_TIMEOUT_MS = 300_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (typeof address === 'object' && address) {
        const { port } = address
        probe.close(() => resolve(port))
        return
      }
      probe.close(() => reject(new Error('no free port')))
    })
  })

describe.skipIf(!LIVE)('a real opencode client terminal', () => {
  let server: ReturnType<typeof spawn>
  let url = ''
  let conversationId = ''
  const home = process.env.HOME ?? '/tmp'

  beforeAll(async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    const auth = `Basic ${Buffer.from(`${USERNAME}:${SECRET}`).toString('base64')}`
    server = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: home,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: USERNAME,
        OPENCODE_SERVER_PASSWORD: SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    let ready = false
    while (!ready && Date.now() < deadline) {
      // EVERY PROBE IS BOUNDED, for the reason `opencode-server.ts` documents: a
      // socket that accepts and never answers turns a readiness loop into a hang
      // on its first iteration, and it reads as "the test hung" rather than "the
      // server never came up".
      ready = await fetch(`${url}/global/health`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(2000),
      })
        .then((res) => res.ok)
        .catch(() => false)
      if (!ready) await sleep(500)
    }
    expect(ready).toBe(true)

    const created = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'POD-2059 live attach' }),
    })
    conversationId = ((await created.json()) as { id: string }).id
    expect(conversationId).toBeTruthy()
  }, READY_TIMEOUT_MS + 60_000)

  afterAll(async () => {
    server?.kill('SIGKILL')
    // These attachments are DURABLE by construction. Without an explicit close
    // each run would leave a master and a scope behind for the whole warm TTL.
    const terminals = createOpencodeClientTerminals({ frames: () => {} })
    await terminals.close(GOOD)
    await terminals.close(BAD)
  }, 60_000)

  const collect = async (
    sessionId: SessionId,
    secret: string,
  ): Promise<{ bytes: string; streamId: string }> => {
    const frames: string[] = []
    const terminals = createOpencodeClientTerminals({
      frames: (_streamId, frame) => frames.push(frame),
    })
    const endpoint = await terminals.attach({
      sessionId,
      mode: 'takeover',
      target: {
        url,
        username: USERNAME,
        secret,
        opencodeSessionId: conversationId,
        workdir: home,
      },
    })
    const deadline = Date.now() + HANDSHAKE_WINDOW_MS
    const read = (): string =>
      Buffer.concat(frames.map((f) => Buffer.from(f, 'base64'))).toString('utf8')
    // BOTH cases run the SAME window to the same end condition — "the client
    // said something". A shorter or differently-terminated wait for the negative
    // case would make its verdict a statement about timing rather than auth.
    while (Date.now() < deadline && read().length === 0) await sleep(500)
    // Let a first byte be followed by the rest of what the client has to say.
    await sleep(3000)
    return { bytes: read(), streamId: endpoint.streamId }
  }

  it(
    'comes up with the secret from the ENV alone, and streams what it says',
    async () => {
      const { bytes, streamId } = await collect(GOOD, SECRET)
      expect(streamId).toBeTruthy()
      // The terminal handshake: opentui interrogating the terminal it landed on.
      // This is the byte-level evidence that the client connected — see the
      // header for why a painted screen is not available to assert on.
      expect(bytes).toContain('\x1b[')
      expect(bytes.length).toBeGreaterThan(100)
      // …and NOT the refusal the negative case below gets. This is the pair that
      // makes "the credential travelled in the env" a measurement.
      expect(bytes).not.toContain('401')

      // The durable master is real, under the label whose scope is the session's
      // sibling — this is what makes the attachment warm-parkable.
      const label = opencodeAttachLabel(GOOD)
      expect(await abducoHasSession(label)).toBe(true)

      /**
       * §5's memory rule, against the real `/proc` rather than a fixture.
       *
       * EXACTLY THE SERVER'S OWN SUBTREE, not "less than the client's" — the
       * client's master is a few hundred KB and its TUI child carries no label
       * at all, so a size comparison would pass even while the whole attachment
       * was being claimed. The number the agent is charged must BE the number
       * its own process tree accounts for.
       */
      const procs = snapshotProcesses()
      expect(procs.some((p) => p.cmdline.includes(label))).toBe(true)
      const children = new Map<number, number[]>()
      for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid])
      const serverTree = new Set<number>()
      const walk = (pid: number): void => {
        if (serverTree.has(pid)) return
        serverTree.add(pid)
        for (const child of children.get(pid) ?? []) walk(child)
      }
      if (server.pid !== undefined) walk(server.pid)
      const ownBytes = procs
        .filter((p) => serverTree.has(p.pid))
        .reduce((sum, p) => sum + p.memBytes, 0)
      const { agents } = attributeMemory(
        procs,
        [
          {
            sessionId: GOOD,
            label: opencodeScopeLabel(GOOD),
            ...(server.pid !== undefined ? { pid: server.pid } : {}),
          },
        ],
        [],
      )
      expect(agents.find((agent) => agent.sessionId === GOOD)?.bytes).toBe(ownBytes)

      // And closing the attachment takes the master with it, rather than leaving
      // a scope resident for the machine's lifetime.
      await createOpencodeClientTerminals({ frames: () => {} }).close(GOOD)
      expect(await abducoHasSession(label)).toBe(false)
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'is refused IN WORDS when the secret is wrong, and takes its master with it',
    async () => {
      const { bytes } = await collect(BAD, 'not-the-secret')
      // opencode says exactly what happened, on the terminal, in words:
      //   `Error: opencode server GET …/session/ses_… → 401 Unauthorized`
      // Paired with the case above — same argv, same env shape, one different
      // string — this is what makes "the secret arrived through the env" a
      // measurement rather than an inference.
      expect(bytes).toContain('401')
      expect(bytes.toLowerCase()).toContain('unauthorized')
      // A refused client EXITS, so its master goes too. Worth pinning: it means
      // a dead attachment cleans itself out of abduco, and the reaper's job for
      // one of these is the record and the scope, not a live process.
      const deadline = Date.now() + 15_000
      let alive = true
      while (alive && Date.now() < deadline) {
        alive = await abducoHasSession(opencodeAttachLabel(BAD))
        if (alive) await sleep(500)
      }
      expect(alive).toBe(false)
    },
    CASE_TIMEOUT_MS,
  )
})

/** Pins the header's recorded observations to the binary they were recorded
 *  from, so a version bump cannot leave this file quietly describing an older
 *  one. */
describe.skipIf(!LIVE)('the version the live re-proof was recorded against', () => {
  it(
    'is the one this machine would run',
    () => {
      // Spawning a ~180MB binary on the shared box this epic runs on has been
      // measured past 20 seconds, which the default per-test timeout would
      // report as a version mismatch.
      const version = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim()
      expect(version).toBe('1.18.16')
    },
    90_000,
  )
})
