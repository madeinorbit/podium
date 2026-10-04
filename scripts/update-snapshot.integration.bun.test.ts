import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

describe('update snapshot live SQLite boundary [POD-5290]', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps serving and preserves WAL locks through staging, proof and a new connection',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'podium-update-snapshot-'))
      const fixture = join(import.meta.dir, 'fixtures/update-snapshot-server.ts')
      const child = spawn(
        process.execPath,
        ['--conditions=@podium/source', fixture, 'server', root],
        {
          env: { ...process.env, PODIUM_STATE_DIR: root, PODIUM_INSTANCE: 'snapshot-5290' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      // All signals address handles returned by spawn, never process-name searches.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      let stderr = ''
      child.stderr!.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      let opener: ReturnType<typeof spawn> | undefined
      try {
        const ready = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
          let stdout = ''
          child.stdout!.on('data', (chunk) => {
            stdout += chunk.toString()
            for (const line of stdout.split('\n')) {
              try {
                const value = JSON.parse(line)
                if (value.ready) {
                  resolve(value)
                  return
                }
              } catch {}
            }
          })
          child.once('error', reject)
          child.once('exit', () => reject(new Error(`snapshot server exited: ${stderr}`)))
        })
        const url = `http://127.0.0.1:${ready.port}`
        const shm = join(root, 'live.db-shm')
        const inode = statSync(shm).ino
        const ownsDeadManLock = () =>
          readFileSync('/proc/locks', 'utf8')
            .split('\n')
            .some(
              (line) => line.includes(`READ ${ready.pid} `) && line.includes(`:${inode} 128 128`),
            )
        expect(ownsDeadManLock()).toBe(true)
        let settled = false
        const snapshot = fetch(`${url}/snapshot`)
          .then((response) => response.json())
          .finally(() => {
            settled = true
          })
        let servedDuringSnapshot = false
        while (!settled) {
          const health = (await fetch(url).then((response) => response.json())) as {
            staging: boolean
          }
          if (health.staging) {
            expect(await fetch(`${url}/write`).then((response) => response.json())).toEqual([
              '/during-snapshot',
            ])
            servedDuringSnapshot = true
            break
          }
          await Bun.sleep(5)
        }
        const proof = (await snapshot) as { ok: boolean; path: string }
        expect(proof.ok).toBe(true)
        expect(proof.path.startsWith(join(root, 'live.db.backup-vupdate-'))).toBe(true)
        expect(servedDuringSnapshot).toBe(true)
        // copyFileSync(live-shm, ...) cleared precisely this lock in the old path.
        expect(ownsDeadManLock()).toBe(true)
        const size = statSync(shm).size
        await fetch(`${url}/hold`)
        opener = spawn(process.execPath, ['--conditions=@podium/source', fixture, 'opener', root], {
          env: { ...process.env, PODIUM_STATE_DIR: root, PODIUM_INSTANCE: 'snapshot-5290' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const opened = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            opener!.once('error', reject)
            opener!.once('exit', (code, signal) => resolve({ code, signal }))
          },
        )
        expect(opened).toEqual({ code: 0, signal: null })
        expect(statSync(shm).size).toBe(size)
        expect(ownsDeadManLock()).toBe(true)
        expect(await fetch(`${url}/read`).then((response) => response.json())).toEqual({
          bytes: 20_000_000,
        })
        await fetch(`${url}/release`)
        expect(child.signalCode).toBeNull()
      } finally {
        if (opener && opener.exitCode === null && opener.signalCode === null) {
          const gone = new Promise<void>((resolve) => opener!.once('exit', () => resolve()))
          opener.kill('SIGKILL')
          await gone
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await exited
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
