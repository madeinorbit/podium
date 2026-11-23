import { HARNESS_VERSION_POLICIES } from '@podium/harness/browser'
import { DEFAULT_FLEET_UPDATE_CHANNEL, type Where } from '@podium/model'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import type { SyncRepository } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EFFECT_PUBLISHED_INPUT,
  SYSTEM_EFFECT_KINDS_OFF_FEED,
} from '../modules/effects/published-input'

const mockedModules = [
  '@podium/harness/browser',
  '@podium/protocol',
  '@podium/model',
  '@podium/runtime',
  '../harness-manifest',
  '../modules/effects/published-input',
  '../modules/issue-events/feed',
  '../modules/message-feed/feed',
]

afterEach(() => {
  for (const module of mockedModules) vi.doUnmock(module)
  vi.resetModules()
})

async function tokens(
  options: {
    policies?: unknown
    wireDigest?: string
    effectKinds?: string[]
    publicationRules?: unknown
    systemOffFeed?: readonly string[]
    handoff?: boolean
    driverFamily?: 'server' | 'terminal'
    settings?: unknown
    fleetChannel?: string
    candidateDefault?: string
    candidateLimit?: number
    workflowInstructionsDefault?: string
    evidenceSummaryDefault?: string
    eventWindow?: number
    confirmedPerSession?: number
    noIssueWhere?: Where
    generations?: { kind: string; generation: number }[]
  } = {},
) {
  vi.resetModules()
  vi.doMock('@podium/harness/browser', async (original) => ({
    ...(await original<typeof import('@podium/harness/browser')>()),
    HARNESS_VERSION_POLICIES: options.policies ?? HARNESS_VERSION_POLICIES,
  }))
  vi.doMock('@podium/protocol', async (original) => ({
    ...(await original<typeof import('@podium/protocol')>()),
    wireSchemaDigest: () => options.wireDigest ?? 'server-wire',
  }))
  vi.doMock('@podium/runtime', async (original) => ({
    ...(await original<typeof import('@podium/runtime')>()),
    DEFAULT_SETTINGS: options.settings ?? DEFAULT_SETTINGS,
  }))
  vi.doMock('@podium/model', async (original) => {
    const actual = await original<typeof import('@podium/model')>()
    const current = actual.COLLECTIONS.get('session.noIssue')
    if (current === undefined) throw new Error('session.noIssue fixture is missing')
    const noIssue =
      options.noIssueWhere === undefined ? current : { ...current, where: options.noIssueWhere }
    return {
      ...actual,
      RECORDS: actual.RECORDS.map((record) =>
        record.kind === 'session'
          ? { ...record, collections: { ...record.collections, noIssue } }
          : record,
      ),
      COLLECTIONS: new Map(actual.COLLECTIONS).set(noIssue.id, noIssue),
      DEFAULT_FLEET_UPDATE_CHANNEL: options.fleetChannel ?? DEFAULT_FLEET_UPDATE_CHANNEL,
      MAX_AGENT_PROFILE_CANDIDATES: options.candidateLimit ?? actual.MAX_AGENT_PROFILE_CANDIDATES,
      AgentCandidate:
        options.candidateDefault === undefined
          ? actual.AgentCandidate
          : actual.AgentCandidate.extend({
              model: actual.AgentCandidate.shape.model
                .removeDefault()
                .default(options.candidateDefault),
            }),
      WorkflowStep:
        options.workflowInstructionsDefault === undefined
          ? actual.WorkflowStep
          : actual.WorkflowStep.extend({
              instructions: actual.WorkflowStep.shape.instructions
                .removeDefault()
                .default(options.workflowInstructionsDefault),
            }),
      WorkflowStepEvidence:
        options.evidenceSummaryDefault === undefined
          ? actual.WorkflowStepEvidence
          : actual.WorkflowStepEvidence.extend({
              summary: actual.WorkflowStepEvidence.shape.summary
                .removeDefault()
                .default(options.evidenceSummaryDefault),
            }),
    }
  })
  vi.doMock('../harness-manifest', async (original) => {
    const actual = await original<typeof import('../harness-manifest')>()
    return {
      ...actual,
      driverFamilyForId: (id: string) =>
        id === 'generic-pty' && options.driverFamily !== undefined
          ? options.driverFamily
          : actual.driverFamilyForId(id),
      harnessCapabilitiesFor: (kind: string) => {
        const capabilities = actual.harnessCapabilitiesFor(kind)
        return kind === 'codex' && options.handoff !== undefined
          ? { ...capabilities, handoff: options.handoff }
          : capabilities
      },
    }
  })
  vi.doMock('../modules/effects/published-input', async (original) => ({
    ...(await original<typeof import('../modules/effects/published-input')>()),
    EFFECT_PUBLISHED_INPUT: options.publicationRules ?? EFFECT_PUBLISHED_INPUT,
    SYSTEM_EFFECT_KINDS_OFF_FEED: options.systemOffFeed ?? SYSTEM_EFFECT_KINDS_OFF_FEED,
  }))
  vi.doMock('../modules/issue-events/feed', async (original) => ({
    ...(await original<typeof import('../modules/issue-events/feed')>()),
    FEED_WINDOW: options.eventWindow ?? 200,
  }))
  vi.doMock('../modules/message-feed/feed', async (original) => ({
    ...(await original<typeof import('../modules/message-feed/feed')>()),
    CONFIRMED_PER_SESSION: options.confirmedPerSession ?? 20,
  }))
  const { readKindTokens } = await import('./kind-tokens')
  const sync = {
    readKindGenerations: async () => options.generations ?? [],
  } as Pick<SyncRepository, 'readKindGenerations'> as SyncRepository
  return await readKindTokens(sync, options.effectKinds ?? [])
}

function changedKinds(before: Record<string, string>, after: Record<string, string>) {
  return Object.keys(before).filter((kind) => before[kind] !== after[kind])
}

describe('record kind code inputs', () => {
  it('device reload audit changes the session token when the no-issue collection rule changes', async () => {
    // The rule before fd0c7568d0 included every unarchived session without an issue.
    const before = await tokens({ noIssueWhere: { archived: false, issueId: { empty: true } } })
    expect(changedKinds(before, await tokens())).toEqual(['session'])
  })

  it('changes only machine when the fleet channel default changes', async () => {
    expect(changedKinds(await tokens(), await tokens({ fleetChannel: 'dev' }))).toEqual(['machine'])
  })

  it('changes only machineAccess when the harness verification policy changes', async () => {
    const before = await tokens()
    const after = await tokens({
      policies: {
        ...HARNESS_VERSION_POLICIES,
        codex: { ...HARNESS_VERSION_POLICIES.codex, verifiedThrough: '999.0.0' },
      },
    })
    expect(changedKinds(before, after)).toEqual(['machineAccess'])
  })

  it('keeps the token for the same policies, independent of object key order', async () => {
    const before = await tokens()
    const policies = Object.fromEntries(
      Object.entries(HARNESS_VERSION_POLICIES)
        .reverse()
        .map(([kind, policy]) => [kind, Object.fromEntries(Object.entries(policy).reverse())]),
    )
    expect(await tokens({ policies })).toEqual(before)
    expect(await tokens()).toEqual(before)
  })

  it('changes only machineAccess when the running server wire digest changes', async () => {
    expect(changedKinds(await tokens(), await tokens({ wireDigest: 'new-server-wire' }))).toEqual([
      'machineAccess',
    ])
  })

  it('changes only effect for a changed served executor set, independent of registration order', async () => {
    const before = await tokens({ effectKinds: ['file.write', 'session.answer'] })
    expect(await tokens({ effectKinds: ['session.answer', 'file.write', 'file.write'] })).toEqual(
      before,
    )
    expect(changedKinds(before, await tokens({ effectKinds: ['session.answer'] }))).toEqual([
      'effect',
    ])
  })

  it('changes only effect when the system kinds kept off the feed change (POD-6941)', async () => {
    expect(changedKinds(await tokens(), await tokens({ systemOffFeed: [] }))).toEqual(['effect'])
  })

  it('changes only effect when its published input policy changes', async () => {
    const before = await tokens()
    const after = await tokens({
      publicationRules: { ...EFFECT_PUBLISHED_INPUT, 'session.answer': { fields: { via: 'via' } } },
    })
    expect(changedKinds(before, after)).toEqual(['effect'])
  })

  it('changes only session when its harness capabilities change', async () => {
    expect(changedKinds(await tokens({ handoff: false }), await tokens({ handoff: true }))).toEqual(
      ['session'],
    )
  })

  it('changes only session when a declared driver family changes', async () => {
    expect(
      changedKinds(
        await tokens({ driverFamily: 'terminal' }),
        await tokens({ driverFamily: 'server' }),
      ),
    ).toEqual(['session'])
  })

  it('changes only instancePreferences when a resolved default changes', async () => {
    const before = await tokens()
    const after = await tokens({
      settings: {
        ...DEFAULT_SETTINGS,
        hibernation: { ...DEFAULT_SETTINGS.hibernation, memoryPct: 90 },
      },
    })
    expect(changedKinds(before, after)).toEqual(['instancePreferences'])
  })

  it('changes only the affected window kind when its size changes', async () => {
    const before = await tokens()
    expect(changedKinds(before, await tokens({ eventWindow: 201 }))).toEqual(['issueEvent'])
    expect(changedKinds(before, await tokens({ confirmedPerSession: 21 }))).toEqual(['message'])
  })

  it('changes profiles and workflow run snapshots when a candidate default changes', async () => {
    expect(changedKinds(await tokens(), await tokens({ candidateDefault: 'new-default' }))).toEqual(
      ['agentProfile', 'workflowRun'],
    )
  })

  it('changes profiles and workflow run snapshots when the candidate limit changes', async () => {
    expect(changedKinds(await tokens(), await tokens({ candidateLimit: 9 }))).toEqual([
      'agentProfile',
      'workflowRun',
    ])
  })

  it('changes only workflowRevision when a stored step default changes', async () => {
    expect(
      changedKinds(await tokens(), await tokens({ workflowInstructionsDefault: 'new-default' })),
    ).toEqual(['workflowRevision'])
  })

  it('changes only workflowRun when an evidence default changes', async () => {
    expect(
      changedKinds(await tokens(), await tokens({ evidenceSummaryDefault: 'new-default' })),
    ).toEqual(['workflowRun'])
  })

  it('keeps migration generations as a separate kind-local token input', async () => {
    const before = await tokens()
    const after = await tokens({ generations: [{ kind: 'machineAccess', generation: 7 }] })
    expect(changedKinds(before, after)).toEqual(['machineAccess'])
    expect(after.machineAccess?.split(':')).toEqual([before.machineAccess?.split(':')[0], '7'])
  })
})
