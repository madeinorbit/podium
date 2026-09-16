import { describe, expect, it, vi } from 'vitest'
import {
  HARNESS_VERSION_POLICIES,
  parseHarnessVersion,
} from '../packages/harness/src/version-policy'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../packages/harness/src/version-probe'
import { lintHarnessVersions } from './lint-harness-versions'

const policies = Object.entries(HARNESS_VERSION_POLICIES)

function newer(verifiedThrough: string): string {
  const version = parseHarnessVersion(verifiedThrough)
  if (!version) throw new Error('Policy version must parse')
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

describe('harness fixture freshness lint', () => {
  it.each(policies)('warns once for newer %s and succeeds', async (name, policy) => {
    const installed = newer(policy.verifiedThrough)
    const probe = vi.fn((command: string) => ({
      ok: command === name,
      output: `${command} ${installed}`,
    }))
    const warn = vi.fn()
    expect(await lintHarnessVersions(probe, warn)).toBe(0)
    expect(probe.mock.calls.map(([command]) => command).sort()).toEqual(
      policies.map(([command]) => command).sort(),
    )
    expect(probe).toHaveBeenCalledWith(name, AGENT_VERSION_PROBE_TIMEOUT_MS)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `WARNING: ${name} ${installed} installed, verified through ${policy.verifiedThrough} - re-record fixtures in packages/agent-runtime/src/drivers/${name === 'grok' ? 'grok-acp' : name}/__fixtures__ when convenient${name === 'codex' ? ' (codex app-server generate-ts --out DIR)' : ''}`,
    )
  })

  it.each([
    'equal',
    'older',
  ] as const)('is silent for %s versions and succeeds', async (relation) => {
    const warn = vi.fn()
    expect(
      await lintHarnessVersions((command) => {
        const policy = HARNESS_VERSION_POLICIES[command as keyof typeof HARNESS_VERSION_POLICIES]
        const version = parseHarnessVersion(policy.verifiedThrough)
        if (!version) throw new Error('Policy version must parse')
        const older = `${version.major}.${version.minor}.${version.patch - 1}`
        return { ok: true, output: relation === 'equal' ? policy.verifiedThrough : older }
      }, warn),
    ).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['absent', { ok: false, output: '' }],
    [
      'timed out with partial output',
      { ok: false, output: newer(HARNESS_VERSION_POLICIES.codex.verifiedThrough) },
    ],
    ['unparseable', { ok: true, output: 'unknown version' }],
  ])('is silent when %s and succeeds', async (_name, result) => {
    const warn = vi.fn()
    expect(await lintHarnessVersions(() => result, warn)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores rejected probes without suppressing another harness warning', async () => {
    const warn = vi.fn()
    expect(
      await lintHarnessVersions(async (command) => {
        if (command !== 'codex') throw new Error('ENOENT or ETIMEDOUT')
        return { ok: true, output: newer(HARNESS_VERSION_POLICIES.codex.verifiedThrough) }
      }, warn),
    ).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
