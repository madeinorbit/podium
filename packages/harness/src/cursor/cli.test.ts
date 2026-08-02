import { describe, expect, it } from 'vitest'
import {
  cursorBinCandidates,
  isCursorCliAvailable,
  resolveCursorBin,
  validateCursorCliHelp,
} from './cli.js'

describe('cursor cli', () => {
  it('lists ~/.local/bin/agent before bare agent', () => {
    expect(cursorBinCandidates('/home/tester')).toEqual(['/home/tester/.local/bin/agent', 'agent'])
  })

  it.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !isCursorCliAvailable())(
    '[real-agent:cursor] resolves a working agent binary when installed',
    () => {
      expect(resolveCursorBin()).toMatch(/agent$/)
      expect(validateCursorCliHelp()).toBe(true)
    },
  )
})
