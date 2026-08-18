import { describe, expect, it } from 'vitest'
import {
  buildVpsBootstrapCommand,
  STABLE_INSTALLER_PUBLISHED,
  vpsInstallerChannel,
} from './vps-bootstrap'

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

  /**
   * THE DEFECT (POD-1288): a stable-resolving instance handed the VPS
   * `releases/latest/download/install.sh`, which 404s while only the edge
   * prerelease is published — the paste failed on a fresh VM.
   */
  it('never emits the stable installer while no stable release is published', () => {
    expect(STABLE_INSTALLER_PUBLISHED).toBe(false)
    expect(vpsInstallerChannel('stable')).toBe('edge')

    const command = buildVpsBootstrapCommand('stable')
    expect(command).not.toContain('/releases/latest/download/install.sh')
    expect(command).not.toContain('--channel stable')
    expect(command).toContain('/releases/download/edge/install.sh')
    expect(command).toContain('--channel edge')
  })

  it('installs the channel it downloaded, so the VPS keeps updating on that train', () => {
    for (const channel of ['stable', 'edge'] as const) {
      const installing = vpsInstallerChannel(channel)
      const command = buildVpsBootstrapCommand(channel)
      expect(command).toContain(`--channel ${installing}`)
      expect(command).toContain(
        installing === 'edge'
          ? '/releases/download/edge/install.sh'
          : '/releases/latest/download/install.sh',
      )
    }
  })

  it('leaves edge alone: the substitution is only for a channel nothing is published on', () => {
    expect(vpsInstallerChannel('edge')).toBe('edge')
  })
})
