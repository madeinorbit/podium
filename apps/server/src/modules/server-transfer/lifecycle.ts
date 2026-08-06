import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Replace the source server process with a daemon after the transfer reply is flushed. */
export function restartAsDaemon(serverUrl: string): void {
  const compiled = import.meta.url.includes('/$bunfs/')
  const args = compiled
    ? ['daemon', '--server', serverUrl, '--takeover']
    : [
        '--conditions=@podium/source',
        fileURLToPath(new URL('../../../../scripts/cli.ts', import.meta.url)),
        'daemon',
        '--server',
        serverUrl,
        '--takeover',
      ]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PODIUM_RUN_MODE: 'detached' },
  })
  child.unref()
  setTimeout(() => process.exit(0), 50)
}
