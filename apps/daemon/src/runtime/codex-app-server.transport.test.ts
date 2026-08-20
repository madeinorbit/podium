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
import { CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS, connectCodexWebSocket } from './codex-app-server'

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
 */
function listen(
  path: string,
  answer: (key: string) => string | undefined,
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
      if (reply !== undefined) socket.write(reply)
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
     * WHERE THE CONSTANT IS ACTUALLY OBSERVABLE — and it needs a deadline
     * LONGER than the constant to be so. Given a shorter one, `attemptMs` is
     * clamped to the deadline either way, so raising the constant to 60s
     * changes nothing a test can see. That is exactly how an earlier version of
     * this suite came to claim it pinned the bound when it did not.
     *
     * With room to breathe, two things separate a 2s attempt bound from one
     * raised past the wait: the stalled peer is reconnected to more than once,
     * and the reported cause names the constant rather than the deadline.
     */
    const deadline = CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS * 2 + 1_000
    const peer = listen(socketPath(), () => undefined)

    const err = await failureOf(connectCodexWebSocket(peer.path, alive, noBanner, deadline))

    expect(err.message).toContain(`within ${CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS}ms`)
    expect(peer.accepted()).toBeGreaterThan(1)
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
