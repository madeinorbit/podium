// Run ONLY under `bun test` (imports `bun:test`). Lives in test/ (outside the package
// tsconfig's `src` include) so tsc doesn't try to resolve `bun:test`. Validates that the
// terminal-PTY feature probe reports TRUE on a real, current Bun and that the auto backend
// selection resolves to bun-terminal — the guard a stale/old Bun (proc.terminal undefined →
// black remote terminals) would trip. The Node side is covered in src/pty/index.test.ts.
import { describe, expect, it } from 'bun:test'
import { defaultPtyBackend, hasBunTerminal, isUnderBun } from '../../src/pty/index'

describe('bun terminal feature-detection (under Bun)', () => {
  it('detects the working terminal PTY API and auto-selects bun-terminal', () => {
    expect(isUnderBun()).toBe(true)
    expect(hasBunTerminal()).toBe(true) // dev/CI Bun is >= 1.3.5
    const prev = process.env.PODIUM_PTY_BACKEND
    delete process.env.PODIUM_PTY_BACKEND
    try {
      expect(defaultPtyBackend().name).toBe('bun-terminal')
    } finally {
      if (prev === undefined) delete process.env.PODIUM_PTY_BACKEND
      else process.env.PODIUM_PTY_BACKEND = prev
    }
  })
})
