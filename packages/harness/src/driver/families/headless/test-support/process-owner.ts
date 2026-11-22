/** Test-only process owner with real children, durable ring replay and writer leases. */
import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { flattenEngineSpawn, type TestEngineSpawn } from '../../../testing/binding-records.js'
import type { EngineAttachment, EngineProcessOwner } from '../../engine-supervision.js'

interface Conn {
  data: Set<(seq: bigint, data: Buffer) => void>
  exit: Set<(code: number, signal: number) => void>
  live: boolean
}

interface FakeHost {
  label: string
  child: ChildProcess
  chunks: { seq: bigint; data: Buffer }[]
  seqHigh: bigint
  exited?: { code: number; signal: number }
  conns: Set<Conn>
  writer?: Conn
  exitedPromise: Promise<void>
}

export function createFakeHosts() {
  const hosts = new Map<string, FakeHost>()
  const starts: TestEngineSpawn[] = []
  const destroyed: string[] = []

  const attach = (
    host: FakeHost,
    fromSeq: bigint | 'tail',
    lateJoin: boolean,
  ): EngineAttachment => {
    const conn: Conn = { data: new Set(), exit: new Set(), live: true }
    const lease = !host.writer
    if (lease) host.writer = conn
    // Frames arrive on a later tick, as they do over a socket.
    setTimeout(
      () => {
        if (!conn.live) return
        if (fromSeq !== 'tail') {
          for (const chunk of host.chunks) {
            if (chunk.seq >= fromSeq) for (const cb of conn.data) cb(chunk.seq, chunk.data)
          }
        }
        host.conns.add(conn)
        if (host.exited) for (const cb of conn.exit) cb(host.exited.code, host.exited.signal)
      },
      lateJoin ? 30 : 0,
    )
    return {
      ready: Promise.resolve({ lease, ...(host.child.pid ? { childPid: host.child.pid } : {}) }),
      connection: {
        onData(cb) {
          conn.data.add(cb)
          return () => conn.data.delete(cb)
        },
        onExit(cb) {
          conn.exit.add(cb)
          return () => conn.exit.delete(cb)
        },
        signal(signum) {
          // The real host answers ERR NOT_WRITER; the signal never lands.
          if (host.writer !== conn || host.exited || !host.child.pid) return
          try {
            process.kill(-host.child.pid, signum)
          } catch {
            // already gone
          }
        },
        async write(data) {
          if (host.writer !== conn) throw new Error('not the writer')
          host.child.stdin?.write(Buffer.from(data))
          return data.length
        },
      },
      dispose() {
        conn.live = false
        host.conns.delete(conn)
        if (host.writer === conn) host.writer = undefined
      },
    }
  }

  const noHost = (): EngineAttachment => ({
    ready: Promise.reject(new Error('connect ENOENT (no host)')),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
    },
    dispose: () => {},
  })

  const owner: EngineProcessOwner = {
    async startEngine(req) {
      const existing = hosts.get(req.label)
      // A live OR lingering host under the label is adopted, never replaced.
      if (existing) return { attachment: attach(existing, 'tail', true) }
      starts.push(flattenEngineSpawn(req))
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...req.env }
      for (const key of req.stripEnv) delete env[key]
      const child = spawn(req.command.cmd, req.command.args, {
        cwd: req.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      let resolveExited!: () => void
      const host: FakeHost = {
        label: req.label,
        child,
        chunks: [],
        seqHigh: 0n,
        conns: new Set(),
        exitedPromise: new Promise((resolve) => {
          resolveExited = resolve
        }),
      }
      hosts.set(req.label, host)
      const onBytes = (data: Buffer): void => {
        const seq = host.seqHigh
        host.chunks.push({ seq, data })
        host.seqHigh += BigInt(data.length)
        for (const conn of host.conns) for (const cb of conn.data) cb(seq, data)
      }
      child.stdout?.on('data', onBytes)
      child.stderr?.on('data', onBytes)
      child.on('close', (code, signal) => {
        host.exited = {
          code: code ?? 0,
          signal: signal ? (constants.signals[signal] ?? 0) : 0,
        }
        for (const conn of host.conns)
          for (const cb of conn.exit) cb(host.exited.code, host.exited.signal)
        resolveExited()
      })
      return { attachment: attach(host, 'tail', true) }
    },
    async reattachEngine(input) {
      const host = hosts.get(input.label)
      return { attachment: host ? attach(host, input.fromSeq, false) : noHost() }
    },
    async engineAlive(label) {
      const host = hosts.get(label)
      return host !== undefined && host.exited === undefined
    },
    async destroyEngine(label) {
      destroyed.push(label)
      const host = hosts.get(label)
      if (!host) return
      if (!host.exited && host.child.pid) {
        try {
          process.kill(-host.child.pid, 'SIGTERM')
        } catch {
          // already gone
        }
        await host.exitedPromise
      }
      hosts.delete(label)
    },
  }
  return {
    owner,
    hosts,
    starts,
    destroyed,
    async killAll() {
      for (const label of [...hosts.keys()]) await owner.destroyEngine(label)
    },
  }
}
