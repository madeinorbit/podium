import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { BoundCommand } from './bound-command.js'
import type { HarnessContext } from './harness-context-types.js'

const execFileAsync = promisify(execFile)

/** Metadata commands run the pinned installation with the selected account's
 * environment. Adapters declare argv and decode replies; this layer owns the
 * process, deadlines and cleanup. No prompt or conversation is allocated. */
export interface MetadataCommand {
  context: Pick<HarnessContext, 'env'>
  command: BoundCommand
  cwd?: string
}

export async function executeMetadataQuery(
  input: MetadataCommand & { stdin?: string },
  timeoutMs: number,
): Promise<string> {
  const result = execFileAsync(input.command.cmd, input.command.args, {
    cwd: input.cwd,
    env: { ...input.context.env, ...input.command.env },
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  result.child.stdin?.end(input.stdin)
  return (await result).stdout
}

export async function queryMetadataServer<T>(
  input: MetadataCommand & {
    endpoint(line: string): string | undefined
    read(url: string, signal: AbortSignal): Promise<T>
  },
  timeoutMs: number,
): Promise<T> {
  const grouped = process.platform !== 'win32'
  const child = spawn(input.command.cmd, input.command.args, {
    env: { ...input.context.env, ...input.command.env },
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: grouped,
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const signal = AbortSignal.timeout(timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const url = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Harness model probe timed out')), timeoutMs)
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Harness model probe exited')))
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const endpoint = input.endpoint(line)
            if (endpoint) resolve(endpoint)
          } catch (error) {
            reject(error)
          }
        }
      })
    })
    return await input.read(url, signal)
  } finally {
    clearTimeout(timer)
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (grouped) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* Already exited. */
      }
    }
    child.stdin.end()
    kill('SIGTERM')
    const force = setTimeout(() => kill('SIGKILL'), 250)
    await closed
    clearTimeout(force)
  }
}
