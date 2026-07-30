import { describe, expect, it } from 'vitest'
import { parseAssistantJson, suggestStage } from './issueAssistant'

describe('suggestStage', () => {
  const base = { stage: 'planning' as const, hasPlanArtifact: false, anyWorking: false, allIdleDone: false, prOpen: false, merged: false }
  it('planning + plan artifact + idle -> in_progress', () => {
    expect(suggestStage({ ...base, hasPlanArtifact: true, allIdleDone: true })).toBe('in_progress')
  })
  it('pr open -> review', () => {
    expect(suggestStage({ ...base, stage: 'in_progress', prOpen: true })).toBe('review')
  })
  it('merged -> done', () => {
    expect(suggestStage({ ...base, stage: 'review', merged: true })).toBe('done')
  })
  it('returns null when no change vs current stage', () => {
    expect(suggestStage({ ...base, stage: 'review', prOpen: true })).toBeNull()
  })
})

describe('parseAssistantJson', () => {
  it('parses a fenced JSON block', () => {
    const r = parseAssistantJson('```json\n{"activityNotes":"ok","suggestedStage":"review","suggestedReason":"pr","blockedBy":[],"dependencyNote":""}\n```')
    expect(r?.activityNotes).toBe('ok')
    expect(r?.suggestedStage).toBe('review')
  })
  it('coerces an invalid suggestedStage to null and defaults arrays', () => {
    const r = parseAssistantJson('{"activityNotes":"x","suggestedStage":"bogus"}')
    expect(r?.suggestedStage).toBeNull()
    expect(r?.blockedBy).toEqual([])
  })
  it('returns null on non-JSON', () => {
    expect(parseAssistantJson('I could not produce JSON')).toBeNull()
  })
})
