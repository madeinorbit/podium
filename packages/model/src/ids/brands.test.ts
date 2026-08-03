import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutomationRunWire, AutomationWire } from '../entities/automation'
import { ConversationSummaryWire } from '../entities/conversation'
import { HandoffManifest } from '../entities/handoff'
import { IssueDepWire, IssueWire } from '../entities/issue'
import { AgentMemoryWire, GitRepositoryWire, MachineWire } from '../entities/machine'
import { SessionMeta, SessionOrigin } from '../entities/session'
import {
  agentIdentityFromSessionId,
  asSessionId,
  MachineId,
  MachineIdField,
  SessionId,
  SessionIdField,
  sessionIdFromAgentIdentity,
} from './brands'

/**
 * WHY THIS FILE EXISTS: branding is a compile-time construct, and the two things
 * that could quietly make it a RUNTIME change are pinned here — the validator
 * tightening under a field, and the MachineId sentinel carve-out being
 * "cleaned up" by a later sweep.
 */

describe('the field schema does not tighten what parses', () => {
  it('accepts the empty string, and the validating boundary schema does not', () => {
    // The counterfactual that makes this test mean something: the SAME id, under
    // the schema POD-361 could have used instead, is REJECTED. Without this half,
    // "the field accepts ''" is just a restatement of z.string().
    expect(SessionIdField.safeParse('').success).toBe(true)
    expect(SessionId.safeParse('').success).toBe(false)
  })

  it('parses a value through unchanged — the brand adds no transformation', () => {
    expect(SessionIdField.parse('s1')).toBe('s1')
    expect(MachineIdField.parse('m1')).toBe('m1')
  })
})

/**
 * POD-1164: for a Podium agent session the actor brand and the work brand share
 * one minted string. These helpers are the ONLY legal conversion; inventing a
 * second id (or substituting a harness-native agent_id) is the defect they
 * exist to make unrepresentable at call sites.
 */
describe('agent identity shares the session mint (POD-1164)', () => {
  it('round-trips the same string both ways', () => {
    const session = asSessionId('sess-minted-by-server')
    const actor = agentIdentityFromSessionId(session)
    expect(actor).toBe('sess-minted-by-server')
    expect(sessionIdFromAgentIdentity(actor)).toBe(session)
    expect(sessionIdFromAgentIdentity(actor)).toBe('sess-minted-by-server')
  })

  it('does not invent a second id — the conversion is pure reclassification', () => {
    // Mutating either helper to prefix/suffix/hash would break the live path:
    // capabilityForSession stamps actorSessionId with the map key, and consumers
    // walk sessions / stamp started_by_session / build `session:` keys from it.
    const session = asSessionId('abc')
    const actor = agentIdentityFromSessionId(session)
    expect(String(actor)).toBe(String(session))
    expect(String(sessionIdFromAgentIdentity(actor))).toBe(String(session))
  })
})

// Every schema POD-361 touched, with each of its id fields set to '' — the value
// a bare `z.string()` accepted before the flip. A `.min(1)` brand reaching any of
// these fields turns a payload that parses today into a parse failure, which is a
// behaviour change in type-change clothing.
const EMPTY_ID_PAYLOADS: Array<
  [string, { safeParse: (v: unknown) => { success: boolean } }, unknown]
> = [
  [
    'SessionMeta',
    SessionMeta,
    {
      sessionId: '',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/w',
      status: 'live',
      controllerId: '',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: 'now',
      lastActiveAt: 'now',
      origin: { kind: 'spawn' },
      archived: false,
      accountId: '',
      machineId: '',
      issueId: '',
      refIssueId: '',
      conversationPodiumId: '',
      spawnedBy: '',
    },
  ],
  // The live producer this whole split exists for: server sessions/service.ts
  // builds `{ kind: 'resume', conversationId: r.conversationId ?? '' }`.
  ['SessionOrigin (resume)', SessionOrigin, { kind: 'resume', conversationId: '' }],
  [
    'AutomationWire',
    AutomationWire,
    {
      id: '',
      name: 'n',
      enabled: true,
      repoPath: null,
      scheduleKind: 'cron',
      cron: null,
      runAt: null,
      targetSessionId: '',
      agentKind: 'codex',
      model: 'auto',
      effort: 'auto',
      prompt: 'p',
      sessionMode: 'fresh',
      nextRunAt: null,
      lastRunAt: null,
      createdAt: 'now',
    },
  ],
  [
    'AutomationRunWire',
    AutomationRunWire,
    { id: '', automationId: '', firedAt: 'now', sessionId: '', outcome: 'spawned', detail: null },
  ],
  [
    'ConversationSummaryWire',
    ConversationSummaryWire,
    { id: '', podiumId: '', parentConversationId: '', agentKind: 'codex', providerId: '' },
  ],
  ['IssueDepWire', IssueDepWire, { id: '', type: 'blocks' }],
  ['AgentMemoryWire', AgentMemoryWire, { sessionId: '', bytes: 0, processCount: 0 }],
  [
    'MachineWire',
    MachineWire,
    { id: '', name: 'n', hostname: 'h', online: true, lastSeenAt: 'now' },
  ],
  [
    'GitRepositoryWire',
    GitRepositoryWire,
    { path: '/p', kind: 'repository', machineId: '', repoId: '' },
  ],
  // POD-1153: BOTH format arms, and the v2 one is the reason this entry matters
  // now — its `owner` and `exported.by.onBehalfOf` are `UserIdField`, so a brand
  // that started rejecting the empty string would break bundle READING, in the
  // one representation whose inputs are files already on disk.
  [
    'HandoffManifest (format 2)',
    HandoffManifest,
    {
      format: 2,
      sessionId: '',
      agentKind: 'claude-code',
      resume: { kind: '', value: '' },
      transcriptFilename: 'f.jsonl',
      repoId: '',
      branch: 'b',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true,
      worktreeName: 'w',
      bundleBase: [],
      issueId: '',
      sourceMachineId: '',
      exported: { at: 'now', by: { actor: { kind: 'agent', id: '' }, onBehalfOf: '' } },
      owner: '',
      visibility: 'personal',
    },
  ],
  [
    'HandoffManifest (format 1)',
    HandoffManifest,
    {
      format: 1,
      sessionId: '',
      agentKind: 'claude-code',
      resume: { kind: '', value: '' },
      transcriptFilename: 'f.jsonl',
      repoId: '',
      branch: 'b',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true,
      worktreeName: 'w',
      bundleBase: [],
      issueId: '',
      sourceMachineId: '',
      exportedAt: 'now',
    },
  ],
]

describe.each(
  EMPTY_ID_PAYLOADS,
)('%s still parses with every id empty', (_name, schema, payload) => {
  it('parses', () => {
    expect(schema.safeParse(payload)).toMatchObject({ success: true })
  })
})

it('IssueWire still parses with every id field empty', () => {
  const issue = {
    id: '',
    repoPath: '/r',
    repoId: '',
    seq: 1,
    title: 't',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    machineId: '',
    blockedByNotes: [''],
    priority: 0,
    type: 'task',
    parentId: '',
    supersededBy: '',
    duplicateOf: '',
    pinned: false,
    needsHuman: false,
    humanQuestionAskedBy: '',
    labels: [],
    deps: [{ id: '', type: 'blocks' }],
    dependents: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: 'now',
    updatedAt: 'now',
    archived: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    coordinatorSessionId: '',
    startedBySession: '',
    panel: { todos: [], artifacts: [{ path: 'p', addedAt: 'now', artifactId: '' }], deferred: [] },
  }
  expect(IssueWire.safeParse(issue)).toMatchObject({ success: true })
})

/**
 * THE MachineId REFUSAL — ADR 1 Amendment 2 D16.2, discharged by POD-318.
 *
 * D16.2 rule 2 blocked this brand at every field "until `local` / `__local__` are
 * retired", because `MachineId` validates LENGTH, not shape: branding a sentinel
 * laundered it instead of flagging it. The sentinels are gone — every machine now
 * carries a UUID minted by the machine itself — so the block is lifted, and these
 * tests pin the OPPOSITE of what they pinned before: the boundary schema refuses
 * both literals, and every machine-id field in `entities/` is bound to the brand.
 *
 * The field scan is still a SOURCE scan rather than a type assertion, for the same
 * reason it always was: `MachineIdField` is a brand with no added validation, so at
 * runtime it is indistinguishable from the bare `z.string()` it replaced. Only the
 * source says which one a field chose.
 */
describe('MachineId refuses the retired sentinels', () => {
  it('rejects both literals at the validating boundary', () => {
    expect(MachineId.safeParse('local').success).toBe(false)
    expect(MachineId.safeParse('__local__').success).toBe(false)
  })

  it('still accepts a real minted machine id, and still rejects the empty string', () => {
    // The counterfactual: the refusal is a denylist of two retired values, not a
    // narrowing of what a machine may call itself. A remote daemon mints its own id.
    expect(MachineId.parse('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    )
    expect(MachineId.safeParse('').success).toBe(false)
  })

  it('leaves the FIELD schema permissive, so branding still changes no payload', () => {
    // Entity fields were bare `z.string()` and must keep parsing what they parsed
    // (this file's `EMPTY_ID_PAYLOADS` block is the wider pin). The refusal lives on
    // the boundary schema, which is where a value ARRIVES from outside.
    expect(MachineIdField.safeParse('').success).toBe(true)
  })
})

describe('MachineId is adopted at EVERY entity field (POD-318)', () => {
  const dir = join(import.meta.dirname, '..', 'entities')
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const)

  it('reads the entity sources it claims to scan', () => {
    // Verify the instrument: a scan of zero files would pass every assertion
    // below. (A NUL byte or a renamed directory is how that happens silently.)
    expect(sources.length).toBeGreaterThanOrEqual(7)
    expect(sources.map(([f]) => f)).toContain('machine.ts')
  })

  /**
   * THE SHARED FIELD GROUPS, scanned so composition cannot launder the brand
   * (POD-1141) — now in the other direction.
   *
   * An entity may write `machineId: IssueWorkspace.shape.machineId` instead of
   * naming a schema directly. The form is accepted ONLY when the referenced group
   * member is itself bound to `MachineIdField`, so moving a field into `fields/`
   * cannot move the branding decision out of this scan's reach.
   */
  const fieldsDir = join(import.meta.dirname, '..', 'fields')
  const fieldSources = readdirSync(fieldsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(fieldsDir, f), 'utf8')] as const)

  /** `IssueWorkspace.shape.machineId` -> is that member the brand? */
  const composedFromBrand = (rhs: string): boolean => {
    const ref = /^(\w+)\.shape\.(\w+),?$/.exec(rhs.trim())
    if (!ref) return false
    const [, group, key] = ref
    for (const [, src] of fieldSources) {
      const block = new RegExp(`export const ${group} = z\\.object\\(\\{[\\s\\S]*?\\n\\}\\)`).exec(
        src,
      )?.[0]
      if (!block) continue
      const member = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(block)?.[1]
      return member?.includes('MachineIdField') ?? false
    }
    return false
  }

  it('reads the field-group sources the composition check depends on', () => {
    // Verify the instrument: if `fields/` were empty or renamed, `composedFromBrand`
    // would return false for everything, which reads as "offender" rather than as a
    // silent pass — but the group it must resolve has to actually be there for the
    // ACCEPT path to be exercised at all.
    expect(fieldSources.length).toBeGreaterThanOrEqual(6)
    expect(composedFromBrand('IssueWorkspace.shape.machineId')).toBe(true)
    // ...and it must be able to say NO: a group member that is not the brand.
    expect(composedFromBrand('IssueWorkspace.shape.branch')).toBe(false)
    expect(composedFromBrand('NoSuchGroup.shape.machineId')).toBe(false)
  })

  it('has no machine-id-shaped field left unbranded', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      for (const [i, line] of src.split('\n').entries()) {
        // Field forms in these schemas: `machineId:`, `sourceMachineId:`,
        // `machine_id:`, and MachineWire's own bare `id:`.
        const m = /^\s*(\w*[Mm]achine_?[Ii]d)\s*:\s*(.+)$/.exec(line)
        if (!m) continue
        const rhs = m[2] ?? ''
        if (!rhs.includes('MachineIdField') && !composedFromBrand(rhs)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, 'POD-318 retired the sentinels: machine-id fields carry the brand').toEqual(
      [],
    )
  })

  it('has no machine-id-shaped field anywhere in entities/ that escaped the scan', () => {
    // The counterfactual for the assertion above: prove the scan SEES sites, so
    // "no offenders" cannot mean "no matches".
    const seen = sources.flatMap(([file, src]) =>
      src
        .split('\n')
        .filter((l) => /^\s*(\w*[Mm]achine_?[Ii]d)\s*:/.test(l))
        .map((l) => `${file}: ${l.trim()}`),
    )
    expect(seen.length).toBeGreaterThanOrEqual(6)
  })

  it("brands MachineWire's own `id`", () => {
    // MachineWire.id is the sharpest site and the one the name-shape detector
    // above cannot see, because the property is called `id`.
    const src = sources.find(([f]) => f === 'machine.ts')?.[1] ?? ''
    const block = /export const MachineWire = z\.object\(\{[\s\S]*?\n\}\)/.exec(src)?.[0]
    expect(block, 'MachineWire not found in entities/machine.ts').toBeTruthy()
    expect(block).toMatch(/\n {2}id: MachineIdField,/)
  })
})
