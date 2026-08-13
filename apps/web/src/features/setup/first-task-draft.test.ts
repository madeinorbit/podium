import { describe, expect, it } from 'vitest'
import { EMPTY_FIRST_TASK_DRAFT, readFirstTaskDraft } from './first-task-draft'

describe('first-task activation draft', () => {
  it('falls back safely when the checkpoint is absent or corrupt', () => {
    expect(readFirstTaskDraft(null)).toEqual(EMPTY_FIRST_TASK_DRAFT)
    expect(readFirstTaskDraft('{')).toEqual(EMPTY_FIRST_TASK_DRAFT)
  })

  it('preserves supported composer fields and rejects an unknown harness', () => {
    expect(
      readFirstTaskDraft(
        JSON.stringify({
          repoPath: '/work/podium',
          agent: 'future-agent',
          model: 'gpt-5.6-sol',
          effort: 'high',
          title: 'Ship onboarding',
          description: 'Keep this prompt.',
        }),
      ),
    ).toEqual({
      repoPath: '/work/podium',
      agent: '',
      model: 'gpt-5.6-sol',
      effort: 'high',
      title: 'Ship onboarding',
      description: 'Keep this prompt.',
      pendingIssueId: '',
      createMutationId: '',
      startMutationId: '',
    })
  })
})
