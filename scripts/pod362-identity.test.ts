import { asAccountId, asArtifactId, asIssueId, asRepoId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'

/**
 * POD-362 wrapped ~900 fixture values in `asX(...)`. That is only behaviour-free
 * if every brand helper is RUNTIME IDENTITY. Pinned here so a later change that
 * gave one of them a normalizing body (trim, lowercase, prefix) would be caught
 * as the behaviour change it would be, rather than passing as "just a type".
 */
describe('POD-362: brand helpers are runtime identity', () => {
  const helpers = { asSessionId, asIssueId, asRepoId, asAccountId, asArtifactId }
  const probes = ['s1', '', 'iss_a', '__local__', 'a\nb', ' padded ', 'MiXeD']

  it.each(Object.entries(helpers))('%s returns its argument unchanged', (_name, fn) => {
    for (const p of probes) expect(fn(p)).toBe(p)
  })

  it('the probe list includes the values a normalizer would change', () => {
    // Non-vacuity: if these were absent, a trimming/lowercasing body would pass.
    expect(probes).toContain(' padded ')
    expect(probes).toContain('MiXeD')
    expect(probes).toContain('')
  })
})
