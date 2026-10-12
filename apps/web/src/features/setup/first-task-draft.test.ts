import { describe, expect, it } from 'vitest'
import {
  draftForReportedModels,
  EMPTY_FIRST_TASK_DRAFT,
  readFirstTaskDraft,
} from './first-task-draft'

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
      machineId: '',
      title: 'Ship onboarding',
      description: 'Keep this prompt.',
      launchKind: '',
      pendingIssueId: '',
      createIssueId: '',
      createSessionId: '',
      createMutationId: '',
      startMutationId: '',
      attachmentPaths: [],
      launchError: '',
    })
  })
})

describe('the pills follow the machine\'s model list (POD-3911)', () => {
  const reported = [
    { value: 'gpt-5.6-sol', efforts: ['low', 'high'] },
    { value: 'gpt-5.5' },
  ]
  const draft = (model: string, effort: string) => ({ ...EMPTY_FIRST_TASK_DRAFT, model, effort })

  it('puts a model the machine does not list back to Auto, effort with it', () => {
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), reported)).toEqual(
      draft('auto', 'auto'),
    )
  })

  it('keeps a listed model and an effort the list names for it', () => {
    expect(draftForReportedModels(draft('gpt-5.6-sol', 'high'), reported)).toBeUndefined()
  })

  it('drops an effort the listed model does not name, or names none for', () => {
    expect(draftForReportedModels(draft('gpt-5.6-sol', 'xhigh'), reported)).toEqual(
      draft('gpt-5.6-sol', 'auto'),
    )
    expect(draftForReportedModels(draft('gpt-5.5', 'high'), reported)).toEqual(
      draft('gpt-5.5', 'auto'),
    )
  })

  it('drops an effort under an Auto model, whatever the list says', () => {
    expect(draftForReportedModels(draft('auto', 'high'), undefined)).toEqual(draft('auto', 'auto'))
  })

  it('changes nothing about a concrete model until the list has arrived', () => {
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), undefined)).toBeUndefined()
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), [])).toBeUndefined()
  })
})
