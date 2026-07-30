import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutomationRunWire, AutomationWire } from '../entities/automation'
import { ConversationSummaryWire } from '../entities/conversation'
import { HandoffManifest } from '../entities/handoff'
import { IssueDepWire, IssueWire } from '../entities/issue'
import { AgentMemoryWire, GitRepositoryWire, MachineWire } from '../entities/machine'
import { SessionMeta, SessionOrigin } from '../entities/session'
import { MachineIdField, machineIdBlockedOnPOD318, SessionId, SessionIdField } from './brands'

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
    expect(machineIdBlockedOnPOD318.parse('__local__')).toBe('__local__')
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
  [
    'HandoffManifest',
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
    blockedBy: [''],
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
 * THE MachineId CARVE-OUT RATCHET — ADR 1 Amendment 2 D16.2.
 *
 * A source scan, not a type assertion, because `machineIdBlockedOnPOD318` and
 * `MachineIdField` are indistinguishable at runtime by design: the whole point is
 * that the carve-out is the same `z.string()` with a name that says why.
 *
 * The detector enumerates the CONCEPT — every property in `entities/` whose name
 * is a machine-id shape, in any of the forms the schemas use — rather than a
 * hand-written list of today's seven sites, so a new machine-id field added
 * later is caught too.
 */
describe('MachineId is adopted at ZERO entity fields until POD-318', () => {
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

  it('has no machine-id-shaped field bound to MachineIdField', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      for (const [i, line] of src.split('\n').entries()) {
        // Field forms in these schemas: `machineId:`, `sourceMachineId:`,
        // `machine_id:`, and MachineWire's own bare `id:`.
        const m = /^\s*(\w*[Mm]achine_?[Ii]d)\s*:\s*(.+)$/.exec(line)
        if (!m) continue
        if (!m[2]?.includes('machineIdBlockedOnPOD318')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, 'ADR 1 Amd 2 D16.2: retire the sentinels (POD-318) BEFORE branding').toEqual(
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

  it("brands MachineWire's own `id` with the carve-out, not with the brand", () => {
    // MachineWire.id is the sharpest site and the one the name-shape detector
    // above cannot see, because the property is called `id`.
    const src = sources.find(([f]) => f === 'machine.ts')?.[1] ?? ''
    const block = /export const MachineWire = z\.object\(\{[\s\S]*?\n\}\)/.exec(src)?.[0]
    expect(block, 'MachineWire not found in entities/machine.ts').toBeTruthy()
    expect(block).toMatch(/\n {2}id: machineIdBlockedOnPOD318,/)
  })

  it('keeps the brand itself available for POD-318 to adopt', () => {
    // The carve-out is an ordering constraint, not a decision to leave machine
    // ids unbranded forever: the brand exists and validates.
    expect(MachineIdField.parse('m1')).toBe('m1')
  })
})
