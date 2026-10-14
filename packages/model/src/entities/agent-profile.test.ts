import { describe, expect, it } from 'vitest'
import {
  AgentProfileDocumentError,
  AgentProfileName,
  formatAgentProfileMarkdown,
  parseAgentProfileMarkdown,
  pickAgentCandidate,
  resolveAgentSetup,
} from './agent-profile'

const build = {
  id: 'agp_build',
  name: 'build',
  candidates: [
    { harness: 'claude-code' as const, model: 'auto', effort: 'high' },
    { harness: 'codex' as const, model: 'gpt-6.1-sol', effort: 'xhigh' },
  ],
  machineId: 'm-profile',
  instructions: '  Build it.  ',
}

describe('resolveAgentSetup', () => {
  it('takes the profile as is when no field is set', () => {
    const setup = resolveAgentSetup(build, { agent: 'auto', model: 'auto', effort: '' })
    expect(setup.profile).toEqual({ id: 'agp_build', name: 'build' })
    expect(setup.candidates).toEqual(build.candidates)
    expect(setup.machineId).toBe('m-profile')
    expect(setup.instructions).toBe('Build it.')
  })

  it('an agent override keeps that harness’s candidates, or becomes the only one', () => {
    expect(resolveAgentSetup(build, { agent: 'codex' }).candidates).toEqual([build.candidates[1]])
    expect(resolveAgentSetup(build, { agent: 'grok' }).candidates).toEqual([
      { harness: 'grok', model: 'auto', effort: 'auto' },
    ])
  })

  it('model and effort overrides apply to every remaining candidate', () => {
    const setup = resolveAgentSetup(build, { effort: 'low', model: 'm1' })
    expect(setup.candidates.map((c) => [c.model, c.effort])).toEqual([
      ['m1', 'low'],
      ['m1', 'low'],
    ])
  })

  it('a machine field beats the profile machine', () => {
    expect(resolveAgentSetup(build, { machineId: 'm-issue' }).machineId).toBe('m-issue')
  })

  it('without a profile, the fields alone decide, and an empty setup is one auto candidate', () => {
    expect(resolveAgentSetup(null, {}).candidates).toEqual([
      { harness: 'auto', model: 'auto', effort: 'auto' },
    ])
    const setup = resolveAgentSetup(null, { agent: 'codex', effort: 'high' })
    expect(setup).toEqual({
      profile: null,
      candidates: [{ harness: 'codex', model: 'auto', effort: 'high' }],
      machineId: null,
      instructions: '',
    })
  })
})

describe('pickAgentCandidate', () => {
  it('picks the first usable candidate', async () => {
    const picked = await pickAgentCandidate(build.candidates, (c) => c.harness === 'codex')
    expect(picked).toMatchObject({ index: 1, usable: true, candidate: { harness: 'codex' } })
  })

  it('falls back to the first candidate, marked unusable, so the start reports the real reason', async () => {
    const picked = await pickAgentCandidate(build.candidates, async () => false)
    expect(picked).toMatchObject({ index: 0, usable: false, candidate: { harness: 'claude-code' } })
  })
})

describe('profile markdown', () => {
  it('round-trips the exported shape', () => {
    const doc = {
      name: 'review',
      description: 'Reviews a change: correctness first, then tests.',
      candidates: [
        { harness: 'codex' as const, model: 'gpt-6.1-sol', effort: 'xhigh' },
        { harness: 'claude-code' as const, model: 'auto', effort: 'high' },
      ],
      machine: 'flat block',
      instructions: '# Review\n\nRead the diff first.',
    }
    const text = formatAgentProfileMarkdown(doc)
    expect(text.startsWith('---\nname: review\n')).toBe(true)
    expect(parseAgentProfileMarkdown(text)).toEqual(doc)
  })

  it('reads a plain Claude Code agent file: model only means a claude-code candidate', () => {
    const doc = parseAgentProfileMarkdown(
      '---\ndescription: "Finds bugs"\nmodel: opus\ntools: Read, Grep\n---\nYou find bugs.\n',
      'bug-hunter',
    )
    expect(doc).toEqual({
      name: 'bug-hunter',
      description: 'Finds bugs',
      candidates: [{ harness: 'claude-code', model: 'opus', effort: 'auto' }],
      machine: null,
      instructions: 'You find bugs.',
    })
  })

  it('refuses a file without frontmatter, a bad name and an unknown harness', () => {
    expect(() => parseAgentProfileMarkdown('just text', 'x')).toThrow(AgentProfileDocumentError)
    expect(() => parseAgentProfileMarkdown('---\nname: Has Spaces\n---\n')).toThrow(/lowercase/)
    expect(() =>
      parseAgentProfileMarkdown('---\nname: x\ncandidates:\n  - harness: vim\n---\n'),
    ).toThrow(/harness is one of/)
  })

  it('normalizes names to lowercase', () => {
    expect(AgentProfileName.parse(' QA ')).toBe('qa')
  })
})
