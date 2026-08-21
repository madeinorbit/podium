import { describe, expect, it } from 'vitest'
import { buildVpsBootstrapCommand } from './vps-bootstrap'

describe('fresh VPS bootstrap command', () => {
  it('installs a standalone host without a join token or transfer source', () => {
    const command = buildVpsBootstrapCommand('edge')

    expect(command).toContain('--agents codex,claude-code,grok')
    expect(command).toContain('setup --vps')
    expect(command).toContain('curl -fsSL')
    expect(command).toContain('-o "$tmp"')
    expect(command.length).toBeLessThan(320)
    expect(command).not.toContain('| sh')
    expect(command).not.toContain('--join')
    expect(command).not.toContain('server-transfer')
  })

  it('keeps development onboarding on the edge release train', () => {
    expect(buildVpsBootstrapCommand('edge')).toContain('/releases/download/edge/install.sh')
    expect(buildVpsBootstrapCommand('edge')).toContain('--channel edge')
  })

  it('keeps stable onboarding on the stable release train', () => {
    const command = buildVpsBootstrapCommand('stable')
    expect(command).toContain('/releases/latest/download/install.sh')
    expect(command).toContain('--channel stable')
    expect(command).not.toContain('/releases/download/edge/install.sh')
    expect(command).not.toContain('--channel edge')
  })

  it('downloads and persists the requested channel', () => {
    for (const channel of ['stable', 'edge'] as const) {
      const command = buildVpsBootstrapCommand(channel)
      expect(command).toContain(`--channel ${channel}`)
      expect(command).toContain(
        channel === 'edge'
          ? '/releases/download/edge/install.sh'
          : '/releases/latest/download/install.sh',
      )
    }
  })
})
