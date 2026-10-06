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
  type HostItem,
  HostPictureReason,
} from './host.js'

const C_WRITE = 0x02
const C_RESIZE = 0x03

/** WELCOME; `features` appends the trailing features byte the Rust host sends. */
function welcome(features?: number): Buffer {
  const p = Buffer.alloc(features === undefined ? 32 : 33)
  if (features !== undefined) p[32] = features
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

function sizeReply(cols: number, rows: number): Buffer {
  const p = Buffer.alloc(4)
  p.writeUInt16BE(cols, 0)
  p.writeUInt16BE(rows, 2)
  return encodeHostFrame(HostFrame.SIZE_REPLY, p)
}

function data(seq: bigint, text: string): Buffer {
  const p = Buffer.alloc(8)
  p.writeBigUInt64BE(seq, 0)
  return encodeHostFrame(HostFrame.DATA, Buffer.concat([p, Buffer.from(text)]))
}

function picture(seq: bigint, reason: number, cols: number, rows: number, text: string): Buffer {
  const p = Buffer.alloc(13)
  p.writeBigUInt64BE(seq, 0)
  p[8] = reason
  p.writeUInt16BE(cols, 9)
  p.writeUInt16BE(rows, 11)
  return encodeHostFrame(HostFrame.PICTURE_DATA, Buffer.concat([p, Buffer.from(text)]))
}

type Frame = { type: number; payload: Buffer }

/** A fake host: answers HELLO with WELCOME, then hands each frame to `script`. */
function fakeHost(
  script: (frames: Frame[], sock: Socket) => void,
  features?: number,
): Promise<{ path: string; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-host-conn-'))
  const path = join(dir, 'h.sock')
  const server: Server = createServer((sock) => {
    const decode = createHostFrameDecoder()
    const seen: Frame[] = []
    sock.on('data', (chunk: Buffer) => {
      for (const f of decode(chunk)) {
        if (f.type === 0x01) sock.write(welcome(features))
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
  it('an ignored Windows signal reports a diagnostic without refusing a concurrent status', async () => {
    const host = await fakeHost((frames, sock) => {
      if (frames.length !== 2) return
      expect(frames.map((f) => f.type)).toEqual([HostFrame.SIGNAL, HostFrame.STATUS])
      sock.write(err(HostErr.UNSUPPORTED_SIGNAL, 'signal unsupported on Windows; ignored'))
      const status = Buffer.alloc(24)
      status[0] = 1
      status[22] = 1
      sock.write(encodeHostFrame(HostFrame.STATUS_REPLY, status))
    })
    cleanups.push(host.close)
    const conn = connectHost(host.path)
    cleanups.push(() => conn.destroy())
    await conn.welcome
    const errors: string[] = []
    conn.onError((e) => errors.push(e.message))
    conn.signal(28)
    expect((await conn.status()).alive).toBe(true)
    expect(errors).toEqual(['signal unsupported on Windows; ignored'])
  })

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

describe('HostConnection: pictures (POD-4909)', () => {
  it('reads the WELCOME features byte; a host without it (the C host) announces nothing', async () => {
    const rust = await fakeHost(() => {}, 1)
    const c = await fakeHost(() => {})
    cleanups.push(rust.close, c.close)
    const a = connectHost(rust.path)
    const b = connectHost(c.path)
    cleanups.push(
      () => a.detach(),
      () => b.detach(),
    )
    expect(await a.welcome).toMatchObject({ features: 1, screen: true })
    expect(await b.welcome).toMatchObject({ features: 0, screen: false })
  })

  it('requestPicture sends PICTURE only to a host that announced a screen', async () => {
    const seen: number[][] = [[], []]
    const record = (i: number) => (frames: Frame[], sock: Socket) => {
      seen[i] = frames.map((f) => f.type)
      if (frames.at(-1)?.type === HostFrame.SIZE) sock.write(sizeReply(80, 24))
    }
    const rust = await fakeHost(record(0), 1)
    const c = await fakeHost(record(1))
    cleanups.push(rust.close, c.close)
    const a = connectHost(rust.path)
    const b = connectHost(c.path)
    cleanups.push(
      () => a.detach(),
      () => b.detach(),
    )
    await Promise.all([a.welcome, b.welcome])

    expect(a.requestPicture()).toBe(true)
    expect(b.requestPicture()).toBe(false)
    // A request after it: once it is answered, each host has seen everything before it.
    await Promise.all([a.size(), b.size()])
    expect(seen[0]).toEqual([HostFrame.PICTURE, HostFrame.SIZE])
    expect(seen[1]).toEqual([HostFrame.SIZE])
    expect(b.isOpen).toBe(true)
  })

  it('a picture is an item on the same in-order path as DATA', async () => {
    const host = await fakeHost((frames, sock) => {
      if (frames.at(-1)?.type !== HostFrame.PICTURE) return
      // One socket write: the items must come out in this order, in one go.
      sock.write(
        Buffer.concat([
          data(0n, 'ab'),
          picture(2n, HostPictureReason.RESET, 80, 24, '\x1bcpic'),
          data(2n, 'cd'),
          picture(4n, HostPictureReason.CUT, 80, 24, 'cut'),
        ]),
      )
    }, 1)
    cleanups.push(host.close)
    const conn = connectHost(host.path)
    cleanups.push(() => conn.detach())
    await conn.welcome

    const items: HostItem[] = []
    const datas: string[] = []
    conn.onItem((item) => items.push(item))
    conn.onData((_seq, d) => datas.push(d.toString()))
    const got = new Promise<void>((resolve) => {
      conn.onItem((item) => {
        if (item.kind === 'picture' && item.reason === 'cut') resolve()
      })
    })
    conn.requestPicture()
    await got

    expect(
      items.map((i) =>
        i.kind === 'data' ? `data ${i.seq} ${i.data}` : `picture ${i.seq} ${i.reason}`,
      ),
    ).toEqual(['data 0 ab', 'picture 2 reset', 'data 2 cd', 'picture 4 cut'])
    expect(items[1]).toMatchObject({ kind: 'picture', cols: 80, rows: 24 })
    expect((items[1] as Extract<HostItem, { kind: 'picture' }>).bytes.toString()).toBe('\x1bcpic')
    expect(datas).toEqual(['ab', 'cd'])
    expect(conn.lastSeq).toBe(4n)
  })
})

describe('the host attachment: pictures on the item path (POD-4912)', () => {
  it('delivers pictures through onPicture in stream order with DATA through onFrame', async () => {
    const { attachHostAgent } = await import('./host.js')
    const host = await fakeHost((frames, sock) => {
      if (frames.at(-1)?.type !== HostFrame.PICTURE) return
      sock.write(
        Buffer.concat([
          data(0n, 'ab'),
          picture(2n, HostPictureReason.RESET, 100, 30, '\x1bcpic'),
          data(2n, 'cd'),
          picture(4n, HostPictureReason.CUT, 100, 30, 'cut'),
        ]),
      )
    }, 1)
    cleanups.push(host.close)
    const attachment = attachHostAgent({ label: 'pic', socketPath: host.path, fromSeq: 'tail' })
    cleanups.push(() => attachment.dispose())
    await attachment.ready
    expect(attachment.keepsScreen?.()).toBe(true)
    expect(attachment.attachedAtTail).toBe(true)
    const order: string[] = []
    attachment.onFrame((f) => order.push(`data ${Buffer.from(f.data).toString()}`))
    const done = new Promise<void>((resolve) => {
      attachment.onPicture?.((p) => {
        order.push(`picture ${p.reason} ${p.cols}x${p.rows} ${Buffer.from(p.bytes).toString()}`)
        if (p.reason === 'cut') resolve()
      })
    })
    expect(attachment.requestPicture?.()).toBe(true)
    await done
    expect(order).toEqual([
      'data ab',
      'picture reset 100x30 \x1bcpic',
      'data cd',
      'picture cut 100x30 cut',
    ])
  })

  it('a C host keeps no screen and is never asked; an attach from seq 0 is not at the tail', async () => {
    const { attachHostAgent } = await import('./host.js')
    const seen: number[] = []
    const host = await fakeHost((frames) => {
      seen.push(...frames.map((f) => f.type))
    })
    cleanups.push(host.close)
    const attachment = attachHostAgent({ label: 'c', socketPath: host.path, fromSeq: 0n })
    cleanups.push(() => attachment.dispose())
    await attachment.ready
    expect(attachment.keepsScreen?.()).toBe(false)
    expect(attachment.attachedAtTail).toBe(false)
    expect(attachment.requestPicture?.()).toBe(false)
    expect(seen).not.toContain(HostFrame.PICTURE)
  })
})
