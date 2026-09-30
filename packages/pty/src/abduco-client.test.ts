import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachAbducoAgent } from './abduco.js'
import {
  ABDUCO_MAX_PAYLOAD,
  AbducoConnection,
  AbducoPacket,
  createAbducoPacketDecoder,
  encodeAbducoPacket,
  probeAbducoPid,
} from './abduco-client.js'
import { abducoAdoptionAdapter } from './durable-process.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('socket test timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function master(onConnect?: (socket: Socket) => void) {
  const root = mkdtempSync('/tmp/ac-')
  const path = join(root, 'podium-test@old-host')
  const packets: Array<{ type: number; payload: Buffer }> = []
  const sockets: Socket[] = []
  const server = createServer((socket) => {
    sockets.push(socket)
    const decode = createAbducoPacketDecoder()
    socket.on('data', (bytes: Buffer) => packets.push(...decode(bytes)))
    const pid = Buffer.alloc(8)
    pid.writeBigUInt64LE(4242n)
    socket.write(encodeAbducoPacket(AbducoPacket.PID, pid))
    onConnect?.(socket)
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  chmodSync(path, 0o600)
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  return { path, packets, sockets, root }
}

describe('abduco socket protocol', () => {
  it('encodes the C wire layout and decodes fragmented and coalesced frames', () => {
    const packet = encodeAbducoPacket(AbducoPacket.CONTENT, Buffer.from('abc'))
    expect(packet.toString('hex')).toBe('0000000003000000616263')
    for (let split = 0; split <= packet.length; split++) {
      const decode = createAbducoPacketDecoder()
      const result = [
        ...decode(packet.subarray(0, split)),
        ...decode(Buffer.concat([packet.subarray(split), packet])),
      ]
      expect(result.map((p) => p.payload.toString())).toEqual(['abc', 'abc'])
    }
    const oversized = Buffer.alloc(8)
    oversized.writeUInt32LE(ABDUCO_MAX_PAYLOAD + 1, 4)
    expect(() => createAbducoPacketDecoder()(oversized)).toThrow('invalid abduco packet length')
    expect(() => encodeAbducoPacket(0, Buffer.alloc(4089))).toThrow()
  })

  it('adopts by the discovered path without a binary and never announces a stale size', async () => {
    const m = await master()
    expect(
      await abducoAdoptionAdapter().socketPath('podium-test', {
        ABDUCO_SOCKET_DIR: m.root,
        HOME: m.root,
      }),
    ).toBe(m.path)
    const adopted = await abducoAdoptionAdapter().attach({
      label: 'podium-test',
      socketPath: m.path,
      lastKnownGeometry: { cols: 90, rows: 20 },
    })
    cleanups.push(async () => adopted.attachment.dispose())
    expect(adopted.attachment.pid).toBe(4242)
    await waitFor(() => m.packets.length === 1)
    expect(m.packets[0]?.type).toBe(AbducoPacket.ATTACH)
    m.sockets[0]?.write(encodeAbducoPacket(AbducoPacket.RESIZE))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.packets).toHaveLength(1)
    adopted.attachment.resize(111, 37)
    await waitFor(() => m.packets.length === 2)
    expect(m.packets[1]?.payload.toString('hex')).toBe('25006f00')
  })

  it('passes terminal chrome and control bytes unchanged, chunks input, acknowledges exit once', async () => {
    const m = await master()
    const attachment = attachAbducoAgent({ label: 'native', socketPath: m.path, sizeNeutral: true })
    cleanups.push(async () => attachment.dispose())
    let output = ''
    const exits: number[] = []
    attachment.onFrame((frame) => {
      output += Buffer.from(frame.data).toString()
    })
    attachment.onExit((code) => {
      exits.push(code)
      attachment.dispose()
    })
    attachment.writeBytes(Buffer.concat([Buffer.from([0xff, 0x1c]), Buffer.alloc(9000, 65)]))
    await attachment.ready
    await waitFor(() => m.packets.length === 4)
    expect(Buffer.concat(m.packets.slice(1).map((p) => p.payload))).toEqual(
      Buffer.concat([Buffer.from([0xff, 0x1c]), Buffer.alloc(9000, 65)]),
    )
    m.sockets[0]?.write(
      encodeAbducoPacket(AbducoPacket.CONTENT, Buffer.from('\x1b[?1049h\x1b[Hhello')),
    )
    const exit = Buffer.alloc(4)
    exit.writeUInt32LE(23)
    m.sockets[0]?.write(
      Buffer.concat([
        encodeAbducoPacket(AbducoPacket.EXIT, exit),
        encodeAbducoPacket(AbducoPacket.EXIT, exit),
      ]),
    )
    await waitFor(() => exits.length > 0 && m.packets.length === 5)
    expect(output).toBe('\x1b[?1049h\x1b[Hhello')
    expect(exits).toEqual([23])
    expect(m.packets.at(-1)).toEqual({ type: AbducoPacket.EXIT, payload: exit })
  })

  it('flushes EXIT acknowledgement under backpressure when the daemon disposes immediately', async () => {
    const m = await master((socket) => socket.pause())
    const connection = new AbducoConnection(m.path)
    cleanups.push(async () => connection.kill())
    await connection.ready
    // The paused peer fills the socket and leaves CONTENT queued before EXIT.
    // Disposing must flush the acknowledgement rather than destroy that queue.
    const input = Buffer.alloc(2 * 1024 * 1024, 65)
    connection.write(input)
    connection.onExit(() => {
      connection.kill()
      m.sockets[0]?.resume()
    })
    const exit = Buffer.alloc(4)
    exit.writeUInt32LE(23)
    m.sockets[0]?.write(encodeAbducoPacket(AbducoPacket.EXIT, exit))
    await waitFor(() => m.packets.at(-1)?.type === AbducoPacket.EXIT)
    expect(m.packets.at(-1)?.payload).toEqual(exit)
    expect(
      Buffer.concat(
        m.packets.filter((p) => p.type === AbducoPacket.CONTENT).map((p) => p.payload),
      ).equals(input),
    ).toBe(true)
  })

  it('read-only attachment sets its flag and suppresses input; disposal sends DETACH', async () => {
    const m = await master()
    const connection = new AbducoConnection(m.path, { readOnly: true })
    cleanups.push(async () => connection.kill())
    connection.write(Buffer.from('ignored'))
    await connection.ready
    connection.kill()
    await waitFor(() => m.packets.length === 2)
    expect(m.packets.map((p) => p.type)).toEqual([AbducoPacket.ATTACH, AbducoPacket.DETACH])
    expect(m.packets[0]?.payload.readUInt32LE()).toBe(1)
  })

  it('probes the master PID without input, resizing or an EXIT acknowledgement', async () => {
    const m = await master()
    expect(await probeAbducoPid(m.path)).toBe(4242)
    expect(m.packets).toEqual([])
  })

  it('keeps output and exit arriving beside PID until the daemon installs listeners', async () => {
    const m = await master((socket) => {
      const exit = Buffer.alloc(4)
      exit.writeUInt32LE(7)
      socket.write(
        Buffer.concat([
          encodeAbducoPacket(AbducoPacket.CONTENT, Buffer.from('\x1b]0;legacy-title\x07early')),
          encodeAbducoPacket(AbducoPacket.EXIT, exit),
        ]),
      )
    })
    const result = await abducoAdoptionAdapter().attach({
      label: 'early',
      socketPath: m.path,
      lastKnownGeometry: { cols: 80, rows: 24 },
    })
    let output = ''
    let title: string | undefined
    let code: number | undefined
    result.attachment.onFrame((frame) => {
      output += Buffer.from(frame.data).toString()
    })
    result.attachment.onTitle((value) => {
      title = value
    })
    result.attachment.onExit((value) => {
      code = value
    })
    await waitFor(() => code !== undefined)
    expect(output).toBe('\x1b]0;legacy-title\x07early')
    expect(title).toBe('legacy-title')
    expect(result.attachment.pid).toBe(4242)
    expect(code).toBe(7)
    result.attachment.dispose()
  })

  it('rejects a failed attach and a malformed PID', async () => {
    const m = await master((socket) =>
      socket.write(encodeAbducoPacket(AbducoPacket.PID, Buffer.alloc(3))),
    )
    const connection = new AbducoConnection(m.path)
    cleanups.push(async () => connection.kill())
    // First valid PID makes this ready; a later malformed frame closes the connection.
    let ended = false
    connection.onExit(() => {
      ended = true
    })
    await connection.ready
    await waitFor(() => ended)
    const failed = new AbducoConnection(join(m.root, 'missing'))
    await expect(failed.ready).rejects.toThrow()
    failed.kill()
  })
})
