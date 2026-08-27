import { describe, expect, it } from 'vitest'
import { describeApplyOutcome } from './MachinesPanel'

/**
 * THE ROW'S OWN APPLY BUTTON (POD-2783).
 *
 * The global offer is gone for a machine the release predates, but its Settings
 * row still has an Apply button — and a human who has just been told their Mac
 * is behind will press it. The server answers with the platform fact instead of
 * a grant; this is the sentence they read, and it has to say the two things the
 * old copy got wrong: nobody has anything to fix, and trying again will not
 * help.
 */
describe('describeApplyOutcome', () => {
  it('says a release predates the machine, and that a later one will not', () => {
    const said = describeApplyOutcome(
      { result: 'platform-not-in-release', platform: 'darwin-aarch64' },
      'mini',
    )
    expect(said.tone).toBe('error')
    expect(said.message).toContain('mini')
    expect(said.message).toContain('darwin-aarch64')
    expect(said.message).toMatch(/next update/i)
    expect(said.message).not.toMatch(/try again|operator/i)
  })

  it('does not promise a later release for a platform Podium never publishes', () => {
    const said = describeApplyOutcome(
      { result: 'platform-not-published', platform: 'windows-x86_64' },
      'surface',
    )
    expect(said.message).toContain('windows-x86_64')
    expect(said.message).not.toMatch(/next update|will include/i)
  })

  it('distinguishes a legacy verifier from a wrong or rotated key', () => {
    const said = describeApplyOutcome(
      { result: 'legacy-instance-trust', version: '0.1.1-dev.3+2595a90' },
      'flatblock',
    )
    expect(said.tone).toBe('error')
    expect(said.message).toContain('flatblock')
    expect(said.message).toMatch(/predates channel-keyed update trust/i)
    expect(said.message).toMatch(/baked release key/i)
    expect(said.message).toMatch(/pinned instance key/i)
    expect(said.message).toMatch(/changing or rotating.*cannot/i)
    expect(said.message).toMatch(/host-local.*repair/i)
  })

  /** The arms that were already right stay right. */
  it('still names an offline machine as offline', () => {
    expect(describeApplyOutcome({ result: 'offline' }, 'mini').tone).toBe('error')
  })
})
