import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from './node-pty-backend.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('nodePtyBackend', () => {
  it('spawns a process, streams output bytes, and reports a clean exit', async () => {
    const b = nodePtyBackend()
    expect(b.name).toBe('node-pty')
    const p = b.spawn({
      file: 'node',
      args: ['-e', 'process.stdout.write("hi-there")'],
      cols: 80,
      rows: 24,
    })
    let out = ''
    let code: number | undefined
    p.onData((bytes) => {
      out += Buffer.from(bytes).toString('utf8')
    })
    p.onExit((e) => {
      code = e.exitCode
    })
    for (let i = 0; i < 200 && code === undefined; i++) await wait(20)
    expect(out).toContain('hi-there')
    expect(code).toBe(0)
    expect(p.pid).toBeGreaterThan(0)
  })

  it('round-trips raw input bytes through a raw-mode child', async () => {
    const b = nodePtyBackend()
    const p = b.spawn({
      file: 'node',
      args: [
        '-e',
        'process.stdin.setRawMode(true);process.stdin.on("data",d=>process.stdout.write("<"+d.toString("hex")+">"))',
      ],
      cols: 80,
      rows: 24,
    })
    let out = ''
    p.onData((bytes) => {
      out += Buffer.from(bytes).toString('utf8')
    })
    await wait(300)
    p.write(Uint8Array.of(0xff)) // a byte that is never valid UTF-8
    for (let i = 0; i < 100 && !out.includes('<ff>'); i++) await wait(20)
    expect(out).toContain('<ff>')
    p.kill()
  })
})
