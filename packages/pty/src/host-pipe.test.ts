/**
 * A credential handed over on a pipe (POD-7378): the create argv and the
 * refusals that happen before any process starts. The live handover is proved
 * in `host.integration.test.ts` and the host's own `tests/pipe_env.rs`.
 */
import { describe, expect, it } from 'vitest'
import { checkedPipe, hostCreateArgs, PipeSecretRefusedError } from './host.js'

describe('podium-host --pipe-env', () => {
  it('names the variable in the argv, never the secret', () => {
    const args = hostCreateArgs({
      socketPath: '/s.sock',
      cwd: '/w',
      cmd: 'claude',
      cols: 80,
      rows: 24,
      pipeEnv: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    })
    expect(args).toEqual([
      'create',
      '--socket',
      '/s.sock',
      '--cols',
      '80',
      '--rows',
      '24',
      '--pipe-env',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
      '--cwd',
      '/w',
      '--',
      'claude',
    ])
  })

  it('refuses an empty or blank secret: the program could fall back to a stored login', () => {
    for (const contents of ['', '  ', '\n\t']) {
      expect(() => checkedPipe({ variable: 'CRED_FD', contents }, 'linux')).toThrow(
        PipeSecretRefusedError,
      )
    }
    expect(() => checkedPipe({ variable: 'CRED_FD', contents: '' }, 'linux')).toThrow(
      /empty, so the program was not started/,
    )
  })

  it('refuses Windows, a bad variable name and an oversized secret', () => {
    expect(() => checkedPipe({ variable: 'CRED_FD', contents: 'k' }, 'win32')).toThrow(/Windows/)
    expect(() => checkedPipe({ variable: 'A=B', contents: 'k' }, 'linux')).toThrow(
      /not a variable name/,
    )
    expect(() =>
      checkedPipe({ variable: 'CRED_FD', contents: 'k'.repeat(16 * 1024 + 1) }, 'linux'),
    ).toThrow(/longer than/)
  })

  it('passes a well-formed secret unchanged', () => {
    const pipe = { variable: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', contents: 'sk-ant-oat01-x' }
    expect(checkedPipe(pipe, 'darwin')).toBe(pipe)
  })
})
