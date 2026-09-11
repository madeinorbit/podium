import { describe, expect, it } from 'vitest'
import { judgeCommand, reason } from './agent-command-guard'

const blocked = (command: string) => judgeCommand(command)?.offender
const allowed = (command: string) => judgeCommand(command) === null

describe('agent command guard', () => {
  it('refuses the compiler and the runners in every common spelling', () => {
    for (const command of [
      'tsc --noEmit',
      'tsgo --noEmit -p apps/web',
      './node_modules/.bin/tsc --noEmit',
      'bunx tsgo --noEmit',
      'bun x tsc',
      'npx tsc -p .',
      'pnpm exec tsc',
      'vitest run apps/web',
      'bunx vitest run',
      'bun --bun node_modules/vitest/vitest.mjs run --config vitest.config.ts x.test.ts',
      'node node_modules/.bin/vitest run',
      'bun test packages/runtime/test/sqlite.bun.test.ts',
      'turbo run typecheck',
      'bunx turbo run test',
      'npx playwright test',
      'FOO=1 tsc --noEmit',
      'git status && tsc --noEmit',
      'tsc --noEmit | tail -5',
      'time tsgo --noEmit',
    ]) {
      expect(blocked(command), command).toBeTruthy()
    }
  })

  it('refuses package-directory lanes that skip the root wrappers', () => {
    expect(blocked('cd apps/web && bun run typecheck')).toBe(
      'bun run typecheck in a package directory',
    )
    expect(blocked('cd apps/server && bun run test:store')).toBe(
      'bun run test:store in a package directory',
    )
    expect(blocked('bun run --cwd apps/web typecheck')).toBeTruthy()
    expect(blocked('bun run --filter @podium/web test')).toBeTruthy()
    expect(blocked('bun run typecheck:tsc')).toBe('typecheck:tsc')
  })

  it('allows the sanctioned lanes and unrelated commands', () => {
    for (const command of [
      'bun run typecheck',
      'bun run typecheck -- --filter @podium/web',
      'bun run test',
      'bun run test:file -- apps/server/src/relay.test.ts -t "routes"',
      'bun run test:lane -- server-store',
      'bun run test:related -- packages/sync/src/span.ts',
      'bun run test:full -- --full-because="wire schema changed"',
      'bun scripts/test-lean.ts',
      'grep -rn tsgo scripts/',
      'cat scripts/typecheck.ts | head',
      'git log --oneline -5',
      'cd apps/web && ls src',
      'cd apps/web && bun run build',
      'bun run --cwd apps/web build',
      'cd .. && bun run typecheck',
    ]) {
      expect(allowed(command), command).toBe(true)
    }
  })

  it('names the offender and the lane to use instead', () => {
    const verdict = judgeCommand('bunx vitest run apps/web')
    expect(verdict).not.toBeNull()
    const text = reason(verdict as NonNullable<typeof verdict>)
    expect(text).toContain('bunx vitest')
    expect(text).toContain('bun run test:file')
    expect(text).toContain('docs/agents/testing.md')
  })
})
