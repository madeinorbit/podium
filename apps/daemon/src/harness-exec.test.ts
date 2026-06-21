import { describe, expect, it } from 'vitest'
import { buildHarnessExec, type HarnessBins } from './harness-exec.js'

const bins: HarnessBins = { opencode: () => '/bin/opencode', cursor: () => '/bin/agent' }

describe('buildHarnessExec', () => {
  it('injects the system prompt via --append-system-prompt for Claude (prompt unchanged)', () => {
    const { cmd, args } = buildHarnessExec(
      'claude-code',
      { prompt: 'list my sessions', systemPrompt: 'You are Podium.' },
      bins,
    )
    expect(cmd).toBe('claude')
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('You are Podium.')
    expect(args).toContain('list my sessions') // not prepended into the prompt
    expect(args.at(-1)).toBe('list my sessions')
  })

  it('prepends the system prompt for agents without a native flag (grok)', () => {
    const { cmd, args } = buildHarnessExec(
      'grok',
      { prompt: 'do the thing', systemPrompt: 'SYS' },
      bins,
    )
    expect(cmd).toBe('grok')
    expect(args).not.toContain('--append-system-prompt')
    expect(args.at(-1)).toBe('SYS\n\n---\n\ndo the thing')
  })

  it('omits the model flag when model is auto or unset', () => {
    expect(
      buildHarnessExec('claude-code', { prompt: 'p', model: 'auto' }, bins).args,
    ).not.toContain('--model')
    expect(buildHarnessExec('grok', { prompt: 'p' }, bins).args).not.toContain('--model')
  })

  it('passes the model flag when set', () => {
    const { args } = buildHarnessExec('claude-code', { prompt: 'p', model: 'opus' }, bins)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  it('resolves opencode/cursor bins and uses their run flags', () => {
    expect(buildHarnessExec('opencode', { prompt: 'p' }, bins)).toEqual({
      cmd: '/bin/opencode',
      args: ['run', 'p'],
    })
    expect(buildHarnessExec('cursor', { prompt: 'p' }, bins).cmd).toBe('/bin/agent')
  })
})
