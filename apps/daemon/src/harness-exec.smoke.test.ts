import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHarnessExec, type HarnessBins } from './harness-exec.js'

/**
 * REAL-BINARY smoke test (#84 post-mortem): the variadic --allowedTools bug
 * shipped because nothing ever ran the actual claude CLI against
 * buildHarnessExec's exact argv. This does — one trivial headless turn with the
 * real --append-system-prompt, a real --allowedTools list, and a dummy
 * mcp-config file, prompt delivered over stdin exactly like the daemon does.
 * Guarded like the other env-dependent suites: skipped when claude isn't
 * installed (or can't report a version).
 */
const hasClaude = ((): boolean => {
  try {
    execFileSync('claude', ['--version'], { timeout: 15_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

const bins: HarnessBins = { opencode: () => 'opencode', cursor: () => 'cursor' }

describe.skipIf(!hasClaude)('real claude binary smoke (issue #84)', () => {
  it('runs one headless turn through the exact daemon argv + stdin and answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-harness-smoke-'))
    const mcpConfigPath = join(dir, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }))
    try {
      const { cmd, args, stdin } = buildHarnessExec(
        'claude-code',
        {
          prompt: 'reply with the word pong',
          systemPrompt: 'You are a smoke test. Answer in one word.',
          mcpConfigPath,
          allowedTools: ['Read', 'Grep'],
        },
        bins,
      )
      const started = Date.now()
      const { code, stdout, stderr } = await new Promise<{
        code: number | null
        stdout: string
        stderr: string
      }>((resolve) => {
        // Same invocation shape as the daemon's runHarnessExec: execFile with
        // a kill budget, prompt written to stdin then EOF.
        const child = execFile(
          cmd,
          args,
          { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) =>
            resolve({
              code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
              stdout,
              stderr,
            }),
        )
        child.stdin?.end(stdin ?? '')
      })
      // eslint-disable-next-line no-console
      console.log(`[smoke] claude turn took ${((Date.now() - started) / 1000).toFixed(1)}s`)
      expect(stderr).not.toContain('Ignoring --allowedTools rule')
      expect(code).toBe(0)
      expect(stdout.toLowerCase()).toContain('pong')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
