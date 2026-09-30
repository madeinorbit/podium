import { createConnection, type Socket } from 'node:net'
import type { PtyProcess } from './backends/types.js'

/**
 * Upgrade-only compatibility with abduco 0.6 masters started by released Podium.
 * Delete this client and the adoption adapter once no such session can remain.
 * abduco writes its C Packet struct verbatim: native-endian u32 type, u32 length,
 * then at most 4088 bytes. All released Linux/macOS targets are little-endian.
 * Integers are u32, PID is u64, winsize is u16 rows then u16 cols. No version
 * negotiation exists; the server sends PID immediately upon accepting a client.
 */
export const AbducoPacket = {
  CONTENT: 0,
  ATTACH: 1,
  DETACH: 2,
  RESIZE: 3,
  EXIT: 4,
  PID: 5,
} as const
export const ABDUCO_MAX_PAYLOAD = 4088

export function encodeAbducoPacket(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
  if (payload.byteLength > ABDUCO_MAX_PAYLOAD) throw new Error('abduco packet exceeds 4088 bytes')
  const packet = Buffer.alloc(8 + payload.byteLength)
  packet.writeUInt32LE(type, 0)
  packet.writeUInt32LE(payload.byteLength, 4)
  packet.set(payload, 8)
  return packet
}

export function createAbducoPacketDecoder(): (
  chunk: Uint8Array,
) => Array<{ type: number; payload: Buffer }> {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    const packets: Array<{ type: number; payload: Buffer }> = []
    while (pending.length >= 8) {
      const length = pending.readUInt32LE(4)
      if (length > ABDUCO_MAX_PAYLOAD) throw new Error('invalid abduco packet length')
      if (pending.length < 8 + length) break
      packets.push({ type: pending.readUInt32LE(0), payload: pending.subarray(8, 8 + length) })
      pending = pending.subarray(8 + length)
    }
    return packets
  }
}

/** A PID-only probe: no ATTACH, resize, input or exit acknowledgement. */
export function probeAbducoPid(path: string, timeoutMs = 1000): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const decode = createAbducoPacketDecoder()
    let finished = false
    const finish = (error?: Error, pid?: number): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(pid as number)
    }
    const timer = setTimeout(() => finish(new Error('abduco PID probe timed out')), timeoutMs)
    socket.on('error', (error) => finish(error))
    socket.on('end', () => finish(new Error('abduco closed before PID')))
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const packet of decode(chunk)) {
          if (packet.type !== AbducoPacket.PID) continue
          if (packet.payload.length !== 8) throw new Error('invalid abduco PID packet')
          const pid = Number(packet.payload.readBigUInt64LE())
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid abduco PID')
          finish(undefined, pid)
          return
        }
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}

/** Raw terminal bytes over a unix socket; no local PTY and no attach subprocess. */
export class AbducoConnection implements PtyProcess {
  readonly ready: Promise<number>
  pid = 0
  private readonly socket: Socket
  private readonly decode = createAbducoPacketDecoder()
  private readonly dataCbs = new Set<(bytes: Uint8Array) => void>()
  private readonly exitCbs = new Set<(e: { exitCode: number }) => void>()
  private connected = false
  private closed = false
  private exited = false
  private readonly queued: Buffer[] = []

  constructor(
    path: string,
    private readonly options: {
      readOnly?: boolean
      geometry?: { cols: number; rows: number }
    } = {},
  ) {
    let resolveReady!: (pid: number) => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Direct attachment callers may observe failure through onExit instead.
    void this.ready.catch(() => {})
    this.socket = createConnection(path)
    const timer = setTimeout(() => this.socket.destroy(new Error('abduco attach timed out')), 5000)
    timer.unref()
    this.socket.on('connect', () => {
      const flags = Buffer.alloc(4)
      flags.writeUInt32LE(options.readOnly ? 1 : 0)
      this.socket.write(encodeAbducoPacket(AbducoPacket.ATTACH, flags))
      this.connected = true
      if (options.geometry) this.resize(options.geometry.cols, options.geometry.rows)
      for (const packet of this.queued.splice(0)) this.socket.write(packet)
    })
    this.socket.on('data', (chunk: Buffer) => {
      try {
        for (const { type, payload } of this.decode(chunk)) {
          if (this.closed || this.exited) break
          switch (type) {
            case AbducoPacket.PID: {
              if (payload.length !== 8) throw new Error('invalid abduco PID packet')
              this.pid = Number(payload.readBigUInt64LE())
              if (!Number.isSafeInteger(this.pid) || this.pid <= 0)
                throw new Error('invalid abduco PID')
              clearTimeout(timer)
              resolveReady(this.pid)
              break
            }
            case AbducoPacket.CONTENT:
              for (const cb of this.dataCbs) cb(payload)
              break
            case AbducoPacket.EXIT:
              if (payload.length !== 4) throw new Error('invalid abduco EXIT packet')
              this.exited = true
              // The master holds the exit status until a client acknowledges it.
              this.socket.end(encodeAbducoPacket(AbducoPacket.EXIT, payload))
              for (const cb of this.exitCbs) cb({ exitCode: payload.readUInt32LE() })
              break
            case AbducoPacket.RESIZE:
              // A departing head asks the next client for its size. We have no
              // observed size to offer: only a viewer's explicit ask may resize.
              break
          }
        }
      } catch (error) {
        this.socket.destroy(error as Error)
      }
    })
    this.socket.on('error', (error) => rejectReady(error))
    this.socket.on('end', () => this.socket.destroy())
    this.socket.on('close', () => {
      clearTimeout(timer)
      rejectReady(new Error('abduco connection closed'))
      if (!this.closed && !this.exited) for (const cb of this.exitCbs) cb({ exitCode: 1 })
      this.closed = true
      this.queued.length = 0
    })
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.add(cb)
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.add(cb)
  }
  private send(type: number, payload?: Uint8Array): void {
    if (this.closed || this.exited) return
    const packet = encodeAbducoPacket(type, payload)
    if (this.connected) this.socket.write(packet)
    else this.queued.push(packet)
  }
  write(data: Uint8Array): void {
    if (this.options.readOnly) return
    for (let offset = 0; offset < data.byteLength; offset += ABDUCO_MAX_PAYLOAD) {
      this.send(AbducoPacket.CONTENT, data.subarray(offset, offset + ABDUCO_MAX_PAYLOAD))
    }
  }
  resize(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 65535 ||
      rows > 65535
    ) {
      throw new Error('invalid abduco terminal size')
    }
    const payload = Buffer.alloc(4)
    payload.writeUInt16LE(rows, 0)
    payload.writeUInt16LE(cols, 2)
    this.send(AbducoPacket.RESIZE, payload)
  }
  kill(): void {
    if (this.closed) return
    this.closed = true
    this.queued.length = 0
    // Closing the attachment leaves the master and child alive. Flush DETACH
    // in order, then close; destroying before connect cancels a pending attach.
    if (this.connected && !this.exited) this.socket.end(encodeAbducoPacket(AbducoPacket.DETACH))
    // EXIT already queued an acknowledgement: allow it to flush even when
    // the daemon disposes synchronously from its exit callback.
    else if (!this.exited) this.socket.destroy()
    // A wedged master must not keep a disposed attachment alive indefinitely.
    setTimeout(() => this.socket.destroy(), 500).unref()
  }
}
