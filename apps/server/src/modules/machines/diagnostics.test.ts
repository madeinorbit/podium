import { asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { routeMachineDiagnostic, type MachineDiagnosticRouterDeps } from './diagnostics'

const diagnostic = {
  machineId: 'machine-a',
  code: 'codex-version-unsupported',
  title: 'Codex hooks need review',
  body: 'Codex 0.999 is not recognized; Podium left hooks.json and config.toml untouched.',
  observedVersion: 'codex-cli 0.999.0',
} as const

function deps(overrides: Partial<MachineDiagnosticRouterDeps> = {}): MachineDiagnosticRouterDeps {
  return {
    recipients: () => [asUserId('user:owner'), asUserId('user:admin'), asUserId('user:owner')],
    repoPath: () => '/repo',
    issueExists: () => false,
    createIssue: vi.fn(),
    sendMail: vi.fn(),
    notify: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  }
}

describe('routeMachineDiagnostic', () => {
  it('creates personal issue-mail and attention only for the owner/admin recipients', () => {
    const d = deps()
    routeMachineDiagnostic(diagnostic, d)

    expect(d.createIssue).toHaveBeenCalledTimes(2)
    expect(d.sendMail).toHaveBeenCalledTimes(2)
    expect(d.notify).toHaveBeenCalledTimes(2)
    expect(vi.mocked(d.createIssue).mock.calls.map(([input]) => input.ownerUserId)).toEqual([
      'user:owner',
      'user:admin',
    ])
    for (const [input] of vi.mocked(d.createIssue).mock.calls) {
      expect(input.visibility).toBe('personal')
      expect(input.brief).toContain('Machine: machine-a')
    }
  })

  it('is idempotent when the deterministic issue already exists', () => {
    const d = deps({ issueExists: () => true })
    routeMachineDiagnostic(diagnostic, d)
    expect(d.createIssue).not.toHaveBeenCalled()
    expect(d.sendMail).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('still notifies loudly when no durable issue repository exists', () => {
    const d = deps({ repoPath: () => undefined })
    routeMachineDiagnostic(diagnostic, d)
    expect(d.createIssue).not.toHaveBeenCalled()
    expect(d.notify).toHaveBeenCalledTimes(2)
    expect(d.warn).toHaveBeenCalledTimes(2)
  })
})
