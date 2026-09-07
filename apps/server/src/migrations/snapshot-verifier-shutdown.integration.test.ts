import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { barrier } from '../store/executor/harness'
import { SnapshotVerifier } from './snapshot-verifier'

it('close waits until an in-flight background scan process actually exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pod3264-child-'))
  const dbPath = join(dir, 'store.db')
  const snapshot = `${dbPath}.backup-vscan`
  const db = openDatabase(snapshot)
  db.exec('CREATE TABLE fixture (id INTEGER)')
  db.close()
  const ready = barrier()
  let child: ChildProcess | undefined
  let exited = false
  const verifier = new SnapshotVerifier(dbPath, {
    spawnProcess: (_command, _args, options) => {
      // A real child parked in a scan; SIGTERM is observed, then exit is delayed
      // so an abort-request-only close would return while the process is alive.
      child = spawn(
        process.execPath,
        [
          '-e',
          `
        process.on('SIGTERM', () => setTimeout(() => process.exit(0), 40));
        process.stdout.write('ready\\n');
        setInterval(() => {}, 1000);
      `,
        ],
        options,
      )
      child.stdout?.on('data', () => ready.release())
      child.once('exit', () => {
        exited = true
      })
      return child
    },
  })
  try {
    expect(verifier.discoverAndQueue()).toBe(true)
    await ready.wait()
    expect(exited).toBe(false)
    const closing = verifier.close()
    await closing
    expect(exited).toBe(true)
    const pid = child?.pid
    expect(pid).toBeDefined()
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    child?.kill('SIGKILL')
    await verifier.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
