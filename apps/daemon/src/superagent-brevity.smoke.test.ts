import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { superagentResponseContract } from '../../server/src/modules/superagent/service.js'
import type { HarnessBins } from './harness-exec.js'
import { runHeadlessTurn } from './headless-drivers.js'

const hasClaude = (): boolean => {
  try {
    execFileSync('claude', ['--version'], { timeout: 15_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const bins: HarnessBins = { opencode: () => 'opencode', cursor: () => 'cursor-agent' }
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasClaude())(
  'superagent brevity real-Claude evaluation',
  () => {
    it('keeps a normal diagnostic brief after resuming a thread that previously expanded', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'podium-brevity-smoke-'))
      dirs.push(cwd)
      const sessionUuid = randomUUID()
      const expandedPrompt = 'Give me a detailed walkthrough of why the sky appears blue.'
      const first = runHeadlessTurn(
        {
          agent: 'claude-code',
          cwd,
          prompt: expandedPrompt,
          systemPrompt: superagentResponseContract(expandedPrompt),
          permissionMode: 'bypassPermissions',
          sessionUuid,
          timeoutMs: 240_000,
        },
        () => {},
        bins,
      )
      const expanded = await first.done
      expect(expanded.output.length).toBeGreaterThan(0)

      const normalPrompt = 'Why?'
      const resumed = runHeadlessTurn(
        {
          agent: 'claude-code',
          cwd,
          prompt: normalPrompt,
          systemPrompt: superagentResponseContract(normalPrompt),
          permissionMode: 'bypassPermissions',
          resumeValue: expanded.harnessSessionId,
          timeoutMs: 240_000,
        },
        () => {},
        bins,
      )
      const result = await resumed.done
      const words = result.output.trim().split(/\s+/).filter(Boolean)
      const sentences = Math.max(1, result.output.match(/[.!?](?=\s|$)/g)?.length ?? 0)

      expect(result.harnessSessionId).toBe(sessionUuid)
      expect(words.length).toBeLessThanOrEqual(80)
      expect(sentences).toBeLessThanOrEqual(3)
      expect(result.output).not.toMatch(/^\s*(?:let me|i(?:'|’)ll|i will)\b/i)
    }, 500_000)
  },
)
