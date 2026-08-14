import { describe, expect, it } from 'vitest'
import { buildVpsBootstrapCommand } from './vps-bootstrap'

describe('fresh VPS bootstrap command', () => {
  it('installs a stable standalone host without a join token or transfer source', () => {
    const command = buildVpsBootstrapCommand('stable')

    expect(command).toContain('/releases/latest/download/install.sh')
    expect(command).toContain('--agents codex,claude-code,grok')
    expect(command).toContain('setup --vps')
    expect(command).not.toContain('--join')
    expect(command).not.toContain('server-transfer')
  })

  it('keeps development onboarding on the edge release train', () => {
    expect(buildVpsBootstrapCommand('edge')).toContain('/releases/download/edge/install.sh')
  })
})
