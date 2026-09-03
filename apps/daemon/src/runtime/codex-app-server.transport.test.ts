/**
 * THE WAIT FOR CODEX'S UNIX LISTENER, AND ITS BOUND (POD-2484).
 *
 * `launch()` is not finished when the child is spawned — it is finished when a
 * WebSocket is open on the child's `--listen unix://…`. Everything about that
 * wait is a promise the daemon hands to a session, so the one property it must
 * have is that it SETTLES: a listener that never arrives, a child that died on
 * the way, a peer that accepts the connection and then says nothing must each
 * produce an error naming the cause.
 *
 * The last of those is what shipped broken. `ws` waits on a stalled handshake
 * forever and the retry loop only consulted its deadline BETWEEN attempts, so
 * the first stalled attempt was also the last one — `launch()` never settled,
 * and the home-isolation test that drives it hung for its whole timeout instead
 * of failing. The rig made it look like a Codex bug: its fake harness answered
 * the upgrade out of a `node:http` server, and under Bun — the runtime the
 * daemon and this suite both run on — those bytes never reach the client.
 *
 * So these tests speak to RAW `node:net` listeners. That is the wire a real
 * `codex app-server` presents, it is what the fake harness now presents too, and
 * it does not route the assertion through a runtime's HTTP layer.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import {
  CodexAppServerLaunchRefused,
  CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS,
  connectCodexWebSocket,
} from './codex-app-server'

/** RFC 6455 §1.3, concatenated with the client's key to derive the accept value. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A child that is still running: the loop's normal precondition. */
const alive = { exitCode: null, signalCode: null }
const noBanner = (): string => ''

let root: string | undefined
const servers: Server[] = []
const opened: WebSocket[] = []

afterEach(() => {
  for (const socket of opened.splice(0)) socket.terminate()
  for (const server of servers.splice(0)) server.close()
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** A short root, because a Unix socket path has about 100 bytes to live in. */
function socketPath(): string {
  root = mkdtempSync(join(tmpdir(), 'pod2484-'))
  return join(root, 'l.sock')
}

/**
 * A listener that answers each connection's request head with whatever `answer`
 * returns — or, returning `undefined`, with nothing at all.
 *
 * `delayMs` models the third state between unbound and serving: a peer that has
 * bound and ACCEPTS at once, but takes its time over the upgrade. That is where
 * the per-attempt bound actually bites, so it is where the bound's value has to
 * be argued.
 */
function listen(
  path: string,
  answer: (key: string) => string | undefined,
  delayMs = 0,
): {
  path: string
  frames: Buffer[]
  write: (frame: Buffer) => void
  /** How many times the caller opened a connection — one per attempt. */
  accepted: () => number
} {
  const frames: Buffer[] = []
  let accepted = 0
  let peer: Socket | undefined
  const server = createServer((socket) => {
    accepted += 1
    peer = socket
    let pending = ''
    let upgraded = false
    socket.on('data', (chunk: Buffer) => {
      if (upgraded) {
        frames.push(chunk)
        return
      }
      pending += chunk.toString('latin1')
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      upgraded = true
      const key =
        /sec-websocket-key:[ \t]*([^\r\n]+)/i.exec(pending.slice(0, end))?.[1]?.trim() ?? ''
      const reply = answer(key)
      if (reply === undefined) return
      if (delayMs === 0) socket.write(reply)
      else setTimeout(() => !socket.destroyed && socket.write(reply), delayMs)
    })
    socket.on('error', () => undefined)
  })
  servers.push(server)
  server.listen(path)
  return { path, frames, write: (frame) => peer?.write(frame), accepted: () => accepted }
}

/** The bytes a conforming acceptor answers with — Codex's included. */
function accepted(key: string): string {
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n')
}

/** One unfragmented text frame, server→client, so unmasked (RFC 6455 §5.1). */
function serverTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  return Buffer.concat([Buffer.from([0x81, body.length]), body])
}

/** The error a connect rejected with — and a failure if it did not reject. */
async function failureOf(connecting: Promise<WebSocket>): Promise<Error> {
  return await connecting.then(
    (socket) => {
      opened.push(socket)
      return new Error('the connect resolved when it should have failed')
    },
    (reason: Error) => reason,
  )
}

/** Poll until a condition holds, so an assertion never races the wire. */
async function until(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the expected traffic never arrived')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Decode one client→server text frame, reporting whether it was masked. */
function readClientFrame(frame: Buffer): { masked: boolean; text: string } {
  const masked = ((frame[1] ?? 0) & 0x80) !== 0
  const length = (frame[1] ?? 0) & 0x7f
  let offset = 2
  const mask = masked ? frame.subarray(offset, offset + 4) : undefined
  if (mask) offset += 4
  const body = Buffer.from(frame.subarray(offset, offset + length))
  if (mask) for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0)
  return { masked, text: body.toString('utf8') }
}

describe('connecting to a listener that behaves', () => {
  it('opens on the upgrade and carries JSON-RPC both ways', async () => {
    const peer = listen(socketPath(), accepted)

    const socket = await connectCodexWebSocket(peer.path, alive, noBanner, 5_000)
    opened.push(socket)

    const reply = new Promise<string>((resolve) => {
      socket.once('message', (data: Buffer) => resolve(data.toString()))
    })
    socket.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
    await until(() => peer.frames.length > 0)
    peer.write(serverTextFrame('{"jsonrpc":"2.0","id":1,"result":{}}'))

    expect(await reply).toBe('{"jsonrpc":"2.0","id":1,"result":{}}')
    // Codex's acceptor is tungstenite, which drops an UNMASKED client frame and
    // closes. Nothing else in this suite would notice a client that stopped
    // masking, and the session would simply go quiet.
    expect(readClientFrame(peer.frames[0] as Buffer)).toEqual({
      masked: true,
      text: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    })
  })

  it('waits out a listener that is not bound yet', async () => {
    // The real sequence: the child is spawned, and the socket appears some
    // milliseconds later. Refused connects must be retried, not reported.
    const path = socketPath()
    setTimeout(() => listen(path, accepted), 300)

    const socket = await connectCodexWebSocket(path, alive, noBanner, 5_000)
    opened.push(socket)

    expect(socket.readyState).toBe(1 /* OPEN */)
  })

  it('OPENS against a peer that takes 2s over a correct handshake', async () => {
    /**
     * THE PER-ATTEMPT BOUND, PINNED FROM BELOW — the risky direction, and the
     * one nothing else here covers. Every other test in this file drives a peer
     * that fails; all of them keep passing as the bound is trimmed, so trimming
     * it back to 500ms would look free. It is not: this bound is a ceiling on
     * how long a WORKING handshake may take, and a peer that has bound and
     * accepts immediately but answers late lands squarely on it.
     *
     * Run against the REAL default rather than an injected bound, because the
     * default's value is the thing at stake. 2s is chosen well above anything
     * measured (real codex binds in ~400–630ms) and well under the 5s bound, so
     * this fails only if someone trims the constant toward the peer's latency.
     */
    const peer = listen(socketPath(), accepted, 2_000)

    const socket = await connectCodexWebSocket(peer.path, alive, noBanner)
    opened.push(socket)

    expect(socket.readyState).toBe(1 /* OPEN */)
    expect(peer.accepted()).toBe(1) // opened on the first attempt, not after retries
  }, 30_000)

  it('keeps the per-attempt bound in a defensible band', () => {
    /**
     * A VALUE ASSERTION, because the behavioural ones cannot reach the whole
     * range on their own — and because this constant has now been wrong in one
     * direction and unpinned in both. The reasoning lives at the constant; this
     * is the guard rail.
     *
     * FLOOR: a working handshake that takes a couple of seconds on a starved box
     * must survive, and retries do not rescue it — whatever slows one attempt is
     * a sustained condition, not an independent draw.
     * CEILING: the loop only re-checks whether the child died between attempts,
     * so the bound must leave several attempts inside the 20s wait.
     */
    expect(CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000)
    expect(CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(7_000)
  })
})

describe('connecting to a listener that cannot complete', () => {
  it('FAILS within the deadline when the peer accepts and then says nothing', async () => {
    // THE BUG, PINNED. Not "eventually fails" — fails inside the wait it was
    // given. An unbounded attempt here is indistinguishable from a hang, and a
    // hang is what a session's caller cannot recover from.
    const peer = listen(socketPath(), () => undefined)

    const started = Date.now()
    await expect(connectCodexWebSocket(peer.path, alive, noBanner, 3_000)).rejects.toThrow(
      /Unix listener was not ready.*did not complete the upgrade/s,
    )
    // TIED TO THE DEADLINE IT WAS GIVEN, not to a round number — this bound is
    // what separates "fails" from "hangs". It does NOT pin the per-attempt
    // constant: while the deadline is shorter than the constant, the clamp
    // makes the two indistinguishable from out here. The next test does that.
    expect(Date.now() - started).toBeLessThan(3_000 * 2)
  }, 20_000)

  it('gives each attempt the per-attempt bound, not the whole wait', async () => {
    /**
     * LITERAL NUMBERS ON BOTH SIDES, DELIBERATELY. The version of this test that
     * derived its deadline from `CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS` and then
     * asserted against that same constant was scale-invariant: raising the
     * constant fourfold moved the deadline with it and everything passed, so it
     * pinned nothing while claiming to pin the bound. Fixed numbers here mean
     * the clamp is checked against a wait it cannot move.
     *
     * Two things then separate a per-attempt bound from one raised past the
     * wait: the stalled peer is reconnected to more than once, and the reported
     * cause names the attempt bound rather than the deadline.
     */
    const peer = listen(socketPath(), () => undefined)

    const err = await failureOf(connectCodexWebSocket(peer.path, alive, noBanner, 2_500, 600))

    expect(err.message).toContain('within 600ms')
    expect(peer.accepted()).toBeGreaterThan(1)
  }, 30_000)

  it('keeps the attempt bound INSIDE the deadline when the deadline is shorter', async () => {
    // The other half of the clamp: a per-attempt bound larger than the whole
    // wait must not extend it. This is the direction that let the original hang
    // through, so it is asserted rather than assumed.
    const peer = listen(socketPath(), () => undefined)

    const started = Date.now()
    const err = await failureOf(connectCodexWebSocket(peer.path, alive, noBanner, 700, 30_000))

    expect(err.message).toContain('within 700ms')
    expect(Date.now() - started).toBeLessThan(700 * 3)
  }, 30_000)

  it('FAILS within the deadline when nothing ever binds the path', async () => {
    const started = Date.now()
    await expect(connectCodexWebSocket(socketPath(), alive, noBanner, 500)).rejects.toThrow(
      /Unix listener was not ready/,
    )
    expect(Date.now() - started).toBeLessThan(500 + 2_000)
  })

  it('NAMES THE CAUSE of an ordinary connect failure', async () => {
    /**
     * The failure an operator actually reads, and the one that shipped mute:
     * Bun's `ws` rejects with a DOM `ErrorEvent`, which is not an `Error`, so an
     * `instanceof Error` test fell through to `String()` and rendered
     * `[object ErrorEvent]` — discarding the reason sitting one property away.
     * Nothing here asserted that a cause was PRESENT, which is how it survived.
     *
     * This also pins the cause PREFERENCE: the report blames the connect, never
     * the upgrade, for a socket nothing ever bound. (The clipped-timer race that
     * guard exists for is not itself tested — under Bun a connect rejection
     * lands in a microtask ahead of any timer, so such a test passes with the
     * guard removed and discriminates nothing.)
     */
    const err = await failureOf(connectCodexWebSocket(socketPath(), alive, noBanner, 500))

    expect(err.message).toMatch(/Unix listener was not ready at .+: \S/)
    expect(err.message).not.toMatch(/\[object \w+\]/)
    expect(err.message).not.toMatch(/did not complete the upgrade/)
  })

  it('turns a retired config value into a typed refusal naming the setting', async () => {
    const err = await failureOf(
      connectCodexWebSocket(
        join(tmpdir(), 'never-bound.sock'),
        { exitCode: 1, signalCode: null },
        () =>
          'Error: approval_policy = "untrusted" is no longer supported; remove this setting',
        5_000,
      ),
    )

    expect(err).toBeInstanceOf(CodexAppServerLaunchRefused)
    expect((err as CodexAppServerLaunchRefused).refusal).toEqual({
      reason: 'unsupported-setting',
      setting: 'approval_policy',
    })
    expect(err.message).toBe(
      "codex app-server refused unsupported setting 'approval_policy'; remove that setting from its launch configuration",
    )
    expect(err.message).not.toContain('untrusted')
  })

  it('blames the CHILD, with its stderr, when the child is already gone', async () => {
    // A codex that refused its own arguments is the common case, and the banner
    // is the only place its reason exists. Reporting "listener was not ready"
    // for it would send the reader looking at the socket instead.
    await expect(
      connectCodexWebSocket(
        join(tmpdir(), 'never-bound.sock'),
        { exitCode: 2, signalCode: null },
        () => 'error: unexpected argument --listen',
        5_000,
      ),
    ).rejects.toThrow(/exited before its Unix listener was ready: error: unexpected argument/)
  })
})
