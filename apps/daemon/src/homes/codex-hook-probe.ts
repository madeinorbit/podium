/**
 * CODEX'S OWN HASH FOR PODIUM'S LAUNCH-FLAG HOOKS (credential management §10;
 * POD-6893 S2).
 *
 * Codex runs a hook only if its trust entry carries the hash Codex computes
 * for that handler, and the hash is Codex's own (a version of its serialised
 * hook identity, not a plain digest Podium could compute). So it is read from
 * Codex: an app-server is started with exactly the launch flags a session
 * will get, and `hooks/list` reports each flag hook's key and `currentHash`.
 * The caller caches the answer per Codex version and flag text. Here in the
 * daemon, not in the harness package: a harness never starts a process itself.
 */

import { spawn } from 'node:child_process'
import { codexSessionFlagHookHashes } from '@podium/harness'

export interface CodexHookTrustProbeInput {
  /** The Codex executable the inventory verified. */
  executable: string
  /** The whole child environment: the command env with `CODEX_HOME` set to
   *  a throwaway home. */
  env: Record<string, string>
  /** The launch flags whose hooks are to be trusted. */
  flags: readonly string[]
  /** A directory `hooks/list` inspects (the throwaway home will do). */
  cwd: string
  timeoutMs?: number
}

/** Hook key → Codex's hash, for the flag-supplied hooks; throws on failure. */
export async function probeCodexLaunchHookTrust(
  input: CodexHookTrustProbeInput,
): Promise<Record<string, string>> {
  const child = spawn(input.executable, ['app-server', ...input.flags], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line) as Record<string, unknown>
        if (typeof message.id === 'number') pending.get(message.id)?.(message)
      } catch {
        // Not a frame: Codex's own output on stdout. Ignored.
      }
    }
  })
  let nextId = 0
  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      reject(new Error(`codex app-server exited (${code}) before answering`)),
    )
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('codex app-server did not list its hooks in time')),
      input.timeoutMs ?? 30_000,
    )
  })
  // Both settle after a successful exchange too (the child is killed below):
  // observed here so that is not an unhandled rejection.
  exited.catch(() => undefined)
  timedOut.catch(() => undefined)
  try {
    const exchange = (async () => {
      await call('initialize', { clientInfo: { name: 'podium', version: '1' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
      const reply = await call('hooks/list', { cwds: [input.cwd] })
      if (reply.error) throw new Error(`hooks/list failed: ${JSON.stringify(reply.error)}`)
      return codexSessionFlagHookHashes(reply.result)
    })()
    return await Promise.race([exchange, exited, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
    child.stdin.end()
    child.kill('SIGTERM')
  }
}
