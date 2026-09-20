/**
 * PTY-LESS podium-host create argv (POD-4433).
 *
 * Headless engines (codex app-server, opencode serve, grok stdio) run under
 * podium-host with `--no-pty`: pipes instead of a pty, stdout+stderr merged
 * into the same sequence-numbered ring. This pins the argv shape hermetically;
 * the live round-trip is proved in `host.integration.test.ts` (§12–15).
 */
import { describe, expect, it } from 'vitest'
import { hostCreateArgs } from './host.js'

describe('pty-less podium-host create argv', () => {
  it('--no-pty carries no geometry', () => {
    expect(
      hostCreateArgs({
        socketPath: '/tmp/sock/engine.sock',
        cwd: '/work',
        cmd: 'codex',
        args: ['app-server', '--listen', 'unix:///tmp/sock/c.sock'],
        noPty: true,
      }),
    ).toEqual([
      'create',
      '--socket',
      '/tmp/sock/engine.sock',
      '--no-pty',
      '--cwd',
      '/work',
      '--',
      'codex',
      'app-server',
      '--listen',
      'unix:///tmp/sock/c.sock',
    ])
  })

  it('a pty create keeps --cols/--rows and never --no-pty', () => {
    expect(
      hostCreateArgs({ socketPath: '/s.sock', cwd: '/w', cmd: 'sh', cols: 80, rows: 24 }),
    ).toEqual(['create', '--socket', '/s.sock', '--cols', '80', '--rows', '24', '--cwd', '/w', '--', 'sh'])
  })

  it('refuses geometry beside --no-pty instead of letting the binary fail it', () => {
    expect(() =>
      hostCreateArgs({ socketPath: '/s.sock', cwd: '/w', cmd: 'sh', noPty: true, cols: 80, rows: 24 }),
    ).toThrow(/--no-pty and --cols\/--rows are exclusive/)
  })

  it('refuses a pty create without geometry rather than forking at a junk size', () => {
    expect(() => hostCreateArgs({ socketPath: '/s.sock', cwd: '/w', cmd: 'sh' })).toThrow(
      /needs --cols\/--rows/,
    )
  })
})
