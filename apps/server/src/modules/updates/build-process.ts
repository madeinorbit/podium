import { spawn } from 'node:child_process'
import { buildSignal, throwIfBuildAborted } from './build-attempt'

/** Cancel this command and its descendants when the overall attempt expires. */
export function runBuildCommand(
  file: string,
  args: readonly string[],
  opts: {
    cwd?: string
    env: NodeJS.ProcessEnv
    label: string
    stdio?: 'inherit' | 'ignore' | 'pipe'
  },
): Promise<{ stdout: string; stderr: string }> {
  throwIfBuildAborted()
  const signal = buildSignal()
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : (opts.stdio ?? 'inherit'),
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const stop = (error: Error): void => {
      if (settled) return
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.once('error', () => child.kill('SIGKILL'))
          killer.unref()
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }
      // Do not wait forever for close if a descendant retained a pipe or the
      // kernel cannot immediately reap a process blocked in I/O.
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish(error)
    }
    // Do not truncate captured Git output: partial source identity evidence
    // must fail closed. Install diagnostics are bounded by the same limit.
    let outputBytes = 0
    const capture = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 1024 * 1024) {
        stop(new Error(`${opts.label} output exceeded 1 MiB; the build command was terminated.`))
        return
      }
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => capture(chunk, 'stdout'))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => capture(chunk, 'stderr'))
    const onAbort = (): void => stop(signal?.reason ?? new Error('Build attempt canceled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.once('error', finish)
    child.once('close', (status, signal) =>
      finish(
        status === 0
          ? undefined
          : Object.assign(
              new Error(
                `${opts.label} ${signal ? `was terminated by ${signal}` : `exited with status ${status ?? 'unknown'}`}${stderr ? `\n${stderr}` : ''}`,
              ),
              { status, signal, stderr },
            ),
      ),
    )
  })
}
