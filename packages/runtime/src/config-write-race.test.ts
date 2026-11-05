import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { consumeConfigPairCode, saveConfig } from './config'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

function waitForFile(path: string): void {
  const deadline = Date.now() + 10_000
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`config writer barrier timed out: ${path}`)
    Atomics.wait(sleeper, 0, 0, 5)
  }
}

it('serializes a competing current writer in the acknowledged-code final-check to rename interval', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'podium-config-write-race-'))
  const path = join(root, 'config.json')
  const report = join(root, 'writer-barrier.json')
  const previous = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = root
  let child: ChildProcess | undefined
  let contended: boolean | undefined
  let completed: Promise<number | null> | undefined
  const { renameSync: rename } = await vi.importActual<typeof import('node:fs')>('node:fs')
  let errors = ''
  try {
    saveConfig({ mode: 'client', serverUrl: 'wss://relay', pairCode: 'ACKED-CODE' }, path)
    const intercept = vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === path && String(source).includes('.consume-')) {
        // The consumer already compared its original bytes. Introduce another
        // real process here, before its rename, rather than before consumption.
        const writer = spawn(
          process.execPath,
          [
            '--conditions=@podium/source',
            resolve('scripts/fixtures/config-competing-writer.ts'),
            path,
            report,
          ],
          { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] },
        )
        child = writer
        completed = new Promise((done, reject) => {
          writer.once('error', reject)
          writer.once('exit', done)
        })
        writer.stderr.on('data', (data) => {
          errors += String(data)
        })
        waitForFile(report)
        contended = JSON.parse(fs.readFileSync(report, 'utf8')).contended
        // Without shared coordination the new write completes in this gap and
        // the ACK rename overwrites it. Make that failure deterministic.
        if (!contended) waitForFile(`${report}.done`)
      }
      return rename(source, target)
    })
    try {
      consumeConfigPairCode('ACKED-CODE', path)
    } finally {
      intercept.mockRestore()
    }
    expect(await completed, errors).toBe(0)
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toMatchObject({
      mode: 'client',
      serverUrl: 'wss://relay',
      pairCode: 'NEWER-CODE',
      updateChannel: 'edge',
    })
    expect(contended).toBe(true)
  } finally {
    child?.kill()
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

it('releases shared config ownership when a writer dies without cleanup', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'podium-config-owner-crash-'))
  const path = join(root, 'config.json')
  const report = join(root, 'held')
  const previous = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = root
  const child = spawn(
    process.execPath,
    [
      '--conditions=@podium/source',
      resolve('scripts/fixtures/config-competing-writer.ts'),
      path,
      report,
      'hold',
    ],
    { env: { ...process.env }, stdio: 'ignore' },
  )
  const exited = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  try {
    waitForFile(report)
    child.kill('SIGKILL')
    await exited
    saveConfig({ mode: 'client', serverUrl: 'wss://relay', pairCode: 'AFTER-CRASH' }, path)
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).pairCode).toBe('AFTER-CRASH')
  } finally {
    child.kill()
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
