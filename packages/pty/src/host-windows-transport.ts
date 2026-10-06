import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { HOST_UNAVAILABLE, resolveHostBin } from './host-bin.js'

/** The native bridge verifies the server owner and sets identification-only SQOS. */
class WindowsHostStream extends Duplex {
  private readonly child: ChildProcessWithoutNullStreams
  private diagnostic = ''

  constructor(bin: string, path: string) {
    super()
    this.child = spawn(bin, ['connect', '--socket', path], { windowsHide: true })
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) this.child.stdout.pause()
    })
    this.child.stdout.on('end', () => this.push(null))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.diagnostic += chunk.toString()
      if (this.diagnostic.startsWith('CONNECTED\n')) {
        this.diagnostic = this.diagnostic.slice('CONNECTED\n'.length)
        this.emit('connect')
      }
    })
    this.child.on('error', (error) => this.destroy(error))
    this.child.on('close', (code) => {
      if (this.destroyed) return
      if (code === 0) this.destroy()
      else {
        const error: NodeJS.ErrnoException = new Error(
          this.diagnostic.trim() || 'podium-host pipe bridge closed',
        )
        error.code = code === 4 ? 'ENOENT' : 'EACCES'
        this.destroy(error)
      }
    })
    // A failed authentication can close stdin before the first queued HELLO.
    this.child.stdin.on('error', (error) => this.destroy(error))
  }

  override _read(): void {
    this.child.stdout.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.child.stdin.write(chunk, done)
  }

  override _final(done: (error?: Error | null) => void): void {
    this.child.stdin.end(done)
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    this.child.kill()
    done(error)
  }
}

export function connectWindowsHost(path: string): Duplex {
  const bin = resolveHostBin()
  if (bin) return new WindowsHostStream(bin, path)
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } })
  queueMicrotask(() => stream.destroy(Object.assign(new Error(HOST_UNAVAILABLE), { code: 'ENOENT' })))
  return stream
}
