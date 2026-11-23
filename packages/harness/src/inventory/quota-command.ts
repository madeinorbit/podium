import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { harnessCommand } from '../bound-command.js'
import { harnessChildEnv } from '../harness-context.js'
import type { HarnessContext } from '../harness-context-types.js'
import type { LoginCommandResult, QuotaProbeOptions } from '../manifest.js'
import { noAgentTerms } from '../posture.js'

const OUTPUT_LIMIT = 1_000_000

/** Native quota reports run without a model, in a private workspace. The
 * selected installation/account is the same one a session would use. */
export function quotaCommandRunner(
  context: HarnessContext,
): NonNullable<QuotaProbeOptions['runCommand']> {
  return async (request) => {
    const directory = await mkdtemp(join(tmpdir(), 'podium-quota-'))
    try {
      const windows = process.platform === 'win32'
      for (const [name, target] of Object.entries(request.linkedDirectories ?? {})) {
        if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Invalid quota workspace link')
        await symlink(target, join(directory, name), windows ? 'junction' : 'dir')
      }
      const blocker = join(directory, windows ? 'deny-browser.cmd' : 'deny-browser')
      const script = windows ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n'
      await writeFile(blocker, script, { mode: 0o700 })
      // Some native CLIs invoke their platform browser launcher directly
      // after a failed silent refresh. Polling must never start sign-in.
      for (const name of windows
        ? ['rundll32.exe', 'explorer.exe']
        : ['open', 'xdg-open', 'sensible-browser']) {
        await writeFile(join(directory, name), script, { mode: 0o700 })
      }
      const command = harnessCommand(
        context,
        {
          args: [...(typeof request.args === 'function' ? request.args(directory) : request.args)],
        },
        noAgentTerms('reads native quota; no model turn'),
      )
      const { env } = harnessChildEnv(context, { wiringEnv: command.env })
      return await boundedCommand(
        command.cmd,
        command.args,
        directory,
        {
          ...env,
          BROWSER: blocker,
          PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        },
        request.timeoutMs,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

function boundedCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<LoginCommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let overflow = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const grouped = process.platform !== 'win32'
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: grouped,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stop = () => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already gone. */
        }
      } else child.kill('SIGKILL')
    }
    const finish = (exitCode: number | null, signal?: string, errorCode?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      stop()
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
        ...(signal ? { signal } : {}),
        ...(overflow ? { errorCode: 'ERR_QUOTA_OUTPUT_LIMIT' } : errorCode ? { errorCode } : {}),
      })
    }
    const collect = (destination: Buffer[], chunk: Buffer) => {
      if (settled || overflow) return
      bytes += chunk.byteLength
      if (bytes > OUTPUT_LIMIT) {
        overflow = true
        finish(null, 'SIGKILL')
        return
      }
      destination.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error: NodeJS.ErrnoException) => finish(null, undefined, error.code))
    child.once('close', (code, signal) => finish(code, signal ?? undefined))
    const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30_000, timeoutMs)) : 30_000
    timer = setTimeout(() => {
      timedOut = true
      finish(null, 'SIGKILL')
    }, deadline)
    timer.unref()
  })
}
