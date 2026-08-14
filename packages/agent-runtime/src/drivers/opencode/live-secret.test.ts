/**
 * SPEC §6 — THE PER-SESSION SECRET IS LOAD-BEARING, AND HERE IS THE EVIDENCE
 * (POD-1761 W5).
 *
 * ---------------------------------------------------------------------------
 * THREE LAYERS, BECAUSE ONE OF THEM CANNOT RUN EVERYWHERE
 * ---------------------------------------------------------------------------
 *
 * The claim spec §6 makes is about opencode's behaviour, not ours: a loopback
 * port fronting a credentialed agent must refuse an unauthenticated client. Only
 * opencode can witness that, and opencode is not installed on every machine that
 * runs this suite. So the evidence is layered, and no layer is a substitute for
 * the one above it:
 *
 *   1. THE RECORDED MATRIX (`./__fixtures__/auth-matrix.json`) — five real
 *      requests against a real `opencode serve` 1.18.16 booted with the secret
 *      in its env. This is the observation the driver's design rests on, and it
 *      is asserted on every run so a reviewer sees the exact statuses without
 *      having to install anything.
 *   2. THE CLIENT'S OWN BEHAVIOUR — asserted against a real listener that
 *      records what arrived. It is no use knowing opencode wants Basic if our
 *      client sends something else, and "the secret is in the header on every
 *      request" is a property of OUR code that must hold with or without a
 *      binary present.
 *   3. THE LIVE RE-PROOF — opt-in via `PODIUM_OPENCODE_LIVE=1`, because booting
 *      a 183MB binary and waiting for it to listen is a minute of wall clock and
 *      a flake risk on a loaded machine, and a gate that is occasionally red for
 *      reasons unrelated to the change is a gate people learn to ignore. It is
 *      how the matrix in layer 1 gets RE-RECORDED when the pinned version moves.
 *
 * The conformance corpus's own connect-without-secret property is separate from
 * all three: it proves the DRIVER refuses to work without the secret, against
 * its own real listener. See `./opencode-server.conformance.test.ts`.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import authMatrix from './__fixtures__/auth-matrix.json'
import { createOpencodeClient } from './client.js'
import { gateOpencodeVersion, SUPPORTED_OPENCODE } from './version.js'

describe('spec §6 — the recorded refusal matrix from a real opencode', () => {
  it('was recorded from the version the driver pins', () => {
    expect(authMatrix.recordedFrom).toContain(SUPPORTED_OPENCODE.recordedAt)
  })

  it('refuses every request that is not correct Basic — including the health check', () => {
    const byCase = new Map(authMatrix.probes.map((probe) => [`${probe.case}|${probe.route}`, probe]))
    // The case spec §6 is written about.
    expect(byCase.get('no credentials|GET /global/health')?.status).toBe(401)
    expect(byCase.get('no credentials|GET /session')?.status).toBe(401)
    // A wrong password is refused exactly like a missing one.
    expect(byCase.get('wrong password|GET /global/health')?.status).toBe(401)
    /**
     * BEARER DOES NOT WORK, and this is the row worth keeping. It is the scheme
     * a client author reaches for first, and getting it wrong presents as "the
     * secret mechanism is broken" rather than "the scheme is Basic" — which is
     * how an implementer talks themselves into disabling the password.
     */
    expect(byCase.get('bearer instead of basic|GET /global/health')?.status).toBe(401)
    // …and the correct credential works, so the four refusals are about the
    // CREDENTIAL rather than about a server that refuses everything.
    expect(byCase.get('correct basic|GET /global/health')?.status).toBe(200)
  })

  it('records that the secret was supplied in the ENV, never in argv', () => {
    // /proc/<pid>/cmdline is world-readable. A secret in argv is a secret every
    // local user has, which would make the whole mechanism theatre.
    expect(authMatrix.how).toContain('ENV (never argv)')
  })
})

describe('the client puts the secret on every request, as Basic', () => {
  const seen: { path: string; authorization: string | undefined }[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('[]')
  })

  afterAll(() => {
    server.close()
  })

  it('sends Authorization: Basic and never puts the secret in the URL', async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    server.unref()
    const port = (server.address() as AddressInfo).port
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      username: 'podium',
      password: 'super-secret-value',
      directory: '/tmp/x',
    })
    await client.health()
    await client.permissions()
    await client.questions()

    expect(seen.length).toBe(3)
    for (const request of seen) {
      expect(request.authorization).toBe(
        `Basic ${Buffer.from('podium:super-secret-value').toString('base64')}`,
      )
      // A secret in a query string lands in every access log and every referer.
      expect(request.path).not.toContain('super-secret-value')
      // …and the `directory` scope that opencode silently needs is on all three.
      expect(request.path).toContain('directory=')
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 3: the live re-proof, opt-in
// ---------------------------------------------------------------------------

const liveRequested = process.env.PODIUM_OPENCODE_LIVE === '1'

function opencodeVersion(): string | null {
  try {
    return execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch {
    return null
  }
}

const liveVersion = liveRequested ? opencodeVersion() : null
const live = liveRequested && liveVersion !== null && gateOpencodeVersion(liveVersion) === null

const children: ReturnType<typeof spawn>[] = []
afterAll(() => {
  for (const child of children) child.kill('SIGKILL')
})

describe.skipIf(!live)('spec §6 — LIVE re-proof against a real opencode serve', () => {
  it('reproduces the recorded matrix, and keeps the secret out of argv', async () => {
    const secret = `podium-live-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    const port = 39_000 + Math.floor(Math.random() * 2000)
    const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: 'podium',
        OPENCODE_SERVER_PASSWORD: secret,
      },
      // PIPED, NOT IGNORED. `stdio: 'ignore'` was observed to leave the child
      // not listening on this host; the readiness banner also gives a live run
      // something to report when it does not come up.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    const baseUrl = `http://127.0.0.1:${port}`
    const basic = `Basic ${Buffer.from(`podium:${secret}`).toString('base64')}`

    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      try {
        const response = await fetch(`${baseUrl}/global/health`, {
          headers: { authorization: basic },
          signal: AbortSignal.timeout(2000),
        })
        ready = response.ok
      } catch {
        // not listening yet
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(ready, 'opencode serve did not become ready').toBe(true)

    const status = async (init?: RequestInit): Promise<number> =>
      (await fetch(`${baseUrl}/global/health`, { ...init, signal: AbortSignal.timeout(5000) })).status

    expect(await status()).toBe(401)
    expect(await status({ headers: { authorization: `Bearer ${secret}` } })).toBe(401)
    expect(
      await status({
        headers: { authorization: `Basic ${Buffer.from('podium:wrong').toString('base64')}` },
      }),
    ).toBe(401)
    expect(await status({ headers: { authorization: basic } })).toBe(200)
    expect(child.spawnargs.join(' ')).not.toContain(secret)
  }, 120_000)
})
