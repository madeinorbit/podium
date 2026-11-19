/** Real HTTP/WS server and workers in an owned Bun child, for Vitest wire tests. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { UserId } from '@podium/model'

export interface SyncWorkerTestServer {
  port: number
  owner: UserId
  cookie: string
  machineId: string
  close(): Promise<void>
}
export async function startSyncWorkerTestServer(input: {
  stateDir: string
  repos?: string[]
  member?: { email: string; password: string }
}): Promise<SyncWorkerTestServer> {
  const child = spawn(
    process.execPath,
    [
      '--conditions=@podium/source',
      fileURLToPath(new URL('./sync-worker-server-process.ts', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        PODIUM_STATE_DIR: input.stateDir,
        PODIUM_MODE: 'all-in-one',
        PODIUM_SYNC_SERVER_FIXTURE: JSON.stringify(input),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  const capture = (data: Buffer) => {
    output = (output + data.toString()).slice(-16_000)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', resolve)
  })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.connected) child.send('close')
    else child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try {
      const code = await exited
      if (code !== 0) throw new Error(`sync fixture exited ${code}: ${output}`)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const facts = await new Promise<Omit<SyncWorkerTestServer, 'close'>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`sync server did not start: ${output}`)),
        30_000,
      )
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`sync server exited ${code}: ${output}`))
      })
      child.once('message', (value) => {
        clearTimeout(timeout)
        resolve(value as Omit<SyncWorkerTestServer, 'close'>)
      })
    })
    return { ...facts, close }
  } catch (error) {
    child.kill('SIGTERM')
    await close().catch(() => {})
    throw error
  }
}
