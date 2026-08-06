import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig, localServerUrl, resolvePort } from '@podium/runtime/config'

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  let spawnError: unknown
  child.once('error', (error) => {
    spawnError = error
  })
  const deadline = Date.now() + 30_000
  const endpoint = `${localServerUrl(port)}/health`
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        fetch(endpoint),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('health probe timeout')), 500)
        }),
      ])
      if (response.ok && (await response.text()) === 'ok') return
    } catch {
      // The child may need several polls to finish booting.
    } finally {
      if (timer) clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('promoted server did not become healthy')
}

/**
 * Start the new server role before relinquishing the target daemon process.
 * The response is sent by the caller before this callback is scheduled; the
 * short-lived parent can therefore exit without turning a successful promotion
 * into an apparent RPC timeout.
 */
export async function restartAsServer(): Promise<void> {
  const compiled = import.meta.url.includes('/$bunfs/')
  const args = compiled
    ? ['server', '--takeover']
    : [
        '--conditions=@podium/source',
        fileURLToPath(new URL('../../../scripts/cli.ts', import.meta.url)),
        'server',
        '--takeover',
      ]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PODIUM_RUN_MODE: 'detached' },
  })
  try {
    await waitForHealth(resolvePort(loadConfig()), child)
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  child.unref()
  setTimeout(() => process.exit(0), 250)
}
