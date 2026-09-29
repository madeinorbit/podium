/**
 * HostConnection's matching of ERR frames to the request they refuse, against
 * a scripted fake host on a real unix socket (no podium-host binary needed).
 *
 * An ERR carries no request id, so it used to be matched to the OLDEST pending
 * request. The Rust host (POD-4791) refuses a WRITE with ERR 5 (input queue
 * full) while earlier writes are still accepted and pending, and appends the
 * refused write's id after the message: the client must reject exactly that
 * write.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectHost,
  createHostFrameDecoder,
  encodeHostFrame,
  HostErr,
  HostError,
  HostFrame,
} from './host.js'

const C_WRITE = 0x02
const C_RESIZE = 0x03

function welcome(): Buffer {
  const p = Buffer.alloc(32)
  p.writeUInt16BE(1, 0) // version
  p.writeUInt32BE(4242, 2) // host pid
  p.writeUInt32BE(4343, 6) // child pid
  p[10] = 1 // has pty
  p.writeUInt16BE(80, 11)
  p.writeUInt16BE(24, 13)
  p[31] = 1 // lease granted
  return encodeHostFrame(HostFrame.WELCOME, p)
}

function err(code: number, msg: string, writeId?: number): Buffer {
  const m = Buffer.from(msg)
  const p = Buffer.alloc(6 + m.length + (writeId === undefined ? 0 : 4))
  p.writeUInt16BE(code, 0)
  p.writeUInt32BE(m.length, 2)
  m.copy(p, 6)
  if (writeId !== undefined) p.writeUInt32BE(writeId, 6 + m.length)
  return encodeHostFrame(HostFrame.ERR, p)
}

function written(id: number, bytes: number): Buffer {
  const p = Buffer.alloc(8)
  p.writeUInt32BE(id, 0)
  p.writeUInt32BE(bytes, 4)
  return encodeHostFrame(HostFrame.WRITTEN, p)
}

function resized(cols: number, rows: number): Buffer {
  const p = Buffer.alloc(5)
  p.writeUInt16BE(cols, 0)
  p.writeUInt16BE(rows, 2)
  p[4] = 1
  return encodeHostFrame(HostFrame.RESIZED, p)
}

type Frame = { type: number; payload: Buffer }

/** A fake host: answers HELLO with WELCOME, then hands each frame to `script`. */
function fakeHost(script: (frames: Frame[], sock: Socket) => void): Promise<{ path: string; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-host-conn-'))
  const path = join(dir, 'h.sock')
  const server: Server = createServer((sock) => {
    const decode = createHostFrameDecoder()
    const seen: Frame[] = []
    sock.on('data', (chunk: Buffer) => {
      for (const f of decode(chunk)) {
        if (f.type === 0x01) sock.write(welcome())
        else {
          seen.push({ type: f.type, payload: Buffer.from(f.payload) })
          script(seen, sock)
        }
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        path,
        close: () => {
          server.close()
          rmSync(dir, { recursive: true, force: true })
        },
      }),
    )
  })
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('HostConnection: which request an ERR refuses', () => {
  it('an ERR naming a write rejects exactly that write; earlier writes and a resize are untouched', async () => {
    const host = await fakeHost((frames, sock) => {
      // Once write 1, write 2 and the resize are all in: refuse write 2 by id,
      // then complete write 1 and the resize.
      if (frames.length !== 3) return
      const ids = frames.filter((f) => f.type === C_WRITE).map((f) => f.payload.readUInt32BE(0))
      expect(frames.map((f) => f.type)).toEqual([C_WRITE, C_WRITE, C_RESIZE])
      sock.write(err(HostErr.INPUT_FULL, 'input queue full', ids[1]))
      sock.write(written(ids[0] as number, 3))
      sock.write(resized(100, 30))
    })
    cleanups.push(host.close)
    const conn = connectHost(host.path)
    cleanups.push(() => conn.detach())
    await conn.welcome

    const first = conn.write(Buffer.from('abc'))
    const second = conn.write(Buffer.from('def'))
    const resize = conn.resize(100, 30)

    const refusal = await second.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(refusal).toBeInstanceOf(HostError)
    expect((refusal as HostError).code).toBe(HostErr.INPUT_FULL)
    await expect(first).resolves.toBe(3)
    await expect(resize).resolves.toEqual({ cols: 100, rows: 30, changed: true })
  })

  it('an ERR without a write id still answers the oldest pending request (the C host sends none)', async () => {
    const host = await fakeHost((frames, sock) => {
      if (frames.length !== 2) return
      sock.write(err(HostErr.NOT_WRITER, 'not the writer')) // for the resize
      sock.write(written(frames[1]?.payload.readUInt32BE(0) as number, 2))
    })
    cleanups.push(host.close)
    const conn = connectHost(host.path)
    cleanups.push(() => conn.detach())
    await conn.welcome

    const resize = conn.resize(90, 20)
    const write = conn.write(Buffer.from('hi'))
    await expect(resize).rejects.toMatchObject({ code: HostErr.NOT_WRITER })
    await expect(write).resolves.toBe(2)
  })

  it('an ERR naming a write this client is not waiting for falls back to the oldest request', async () => {
    const host = await fakeHost((frames, sock) => {
      if (frames.length !== 1) return
      sock.write(err(HostErr.EXITED, 'child exited', 999))
    })
    cleanups.push(host.close)
    const conn = connectHost(host.path)
    cleanups.push(() => conn.detach())
    await conn.welcome

    const write = conn.write(Buffer.from('x'))
    await expect(write).rejects.toMatchObject({ code: HostErr.EXITED })
  })
})
