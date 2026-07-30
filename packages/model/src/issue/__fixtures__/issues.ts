import { asIssueId, asMachineId, asRepoId, asSessionId } from '../../ids'
import type { Issue } from '../aggregate'

/**
 * The two Issue aggregates the golden fixtures and the round-trip tests are built
 * from. They are a PAIR on purpose, and the pair is the point:
 *
 *   - `populatedIssue` sets every nullable field to a value;
 *   - `minimalIssue`   sets every nullable field to `null`.
 *
 * The null/absent bijection is the whole job of the mapping pair, and a fixture
 * that only ever populates its optional fields cannot see a bug in it — the
 * absent case is not a degenerate variant to spot-check, it is half the contract.
 * Between them the two cover every key in `issueDurableShape` in both states.
 *
 * `populatedIssue` is an ENCODING fixture, not a domain-coherent issue: it sets
 * every nullable field regardless of whether the combination makes sense (an
 * in-progress issue that is also closed, superseded, a duplicate, deferred AND
 * tombstoned). That is deliberate — the mapping pair's job is to encode each
 * field faithfully, and the coverage guard in `../issue.mapping.test.ts` requires
 * every schema-nullable field to appear in its SET state somewhere. Domain
 * coherence between fields is `@podium/domain`'s concern (the closed/stage
 * machine), not the vocabulary's.
 *
 * `populatedIssue` also carries values chosen to catch specific regressions:
 *   - `linearIdentifier: ''` — the empty string that today's truthiness-based
 *     serializer silently drops (see `../mapping.ts`); it must survive a wire
 *     round-trip here.
 *   - a `panel` with content in all three arrays — the JSON-column split.
 *   - non-ASCII and a quote in `title` — JSON escaping in the golden bytes.
 */

export const populatedIssue: Issue = {
  // identity
  id: asIssueId('iss_2f8a1c'),
  repoPath: '/home/mgw/src/other/podium',
  repoId: asRepoId('repo_9d4e'),
  seq: 791,
  // content
  title: 'Issue model vocabulary — "the" one definition',
  description: 'Stand up packages/model and compose the Issue representations from it.',
  design: 'Field groups → R1 → {R3, R4} by rule, not by hand.',
  acceptance: 'Round-trips green; no hand-restated field lists.',
  notes: 'Sibling of POD-792.',
  // classification
  stage: 'in_progress',
  type: 'task',
  priority: 2,
  pinned: true,
  sortKey: "c",
  color: 'violet',
  estimateMin: 240,
  // workspace
  worktreePath: '/home/mgw/src/other/podium/.worktrees/issue-790',
  branch: 'issue/790-issues-vertical-on-new-architecture',
  parentBranch: 'main',
  defaultAgent: 'claude',
  defaultModel: 'auto',
  defaultEffort: 'xhigh',
  machineId: asMachineId('mach_ludovico'),
  // linear
  linearId: 'lin_abc123',
  linearIdentifier: '',
  linearUrl: 'https://linear.app/podium/issue/POD-791',
  // assistant
  activityNotes: 'Scaffolded the package; wrote the field groups.',
  notesUpdatedAt: '2026-07-17T09:15:00.000Z',
  suggestedStage: 'review',
  suggestedReason: 'Tests are green and the diff is self-contained.',
  blockedBy: ['issue/792-issue-feed-revision-and-epoch'],
  dependencyNote: 'Revision assignment lands with POD-792.',
  // needs-human
  needsHuman: true,
  humanQuestion: 'Keep memberSessionIds on the feed, or derive it replica-side?',
  humanQuestionOptions: ['Keep it on the feed', 'Derive replica-side'],
  humanQuestionAskedBy: asSessionId('sess_7b3e91'),
  humanQuestionAskedAt: '2026-07-17T10:02:00.000Z',
  // panel
  panel: {
    todos: [
      { text: 'Field groups', done: true },
      { text: 'Golden fixtures', done: false },
    ],
    artifacts: [
      {
        path: 'packages/model/src/issue/wire.ts',
        title: 'The normalized projection',
        addedAt: '2026-07-17T10:30:00.000Z',
        artifactId: 'art_44f1',
        entry: 'wire.ts',
        files: [{ path: 'wire.ts', size: 4096 }],
      },
    ],
    deferred: [{ text: 'Session vocabulary', addedAt: '2026-07-17T10:31:00.000Z' }],
  },
  // lifecycle
  assignee: 'claude',
  parentId: asIssueId('iss_790root'),
  closedReason: 'landed',
  closedAt: '2026-07-17T10:44:00.000Z',
  tuckedAt: '2026-07-17T10:46:00.000Z',
  supersededBy: asIssueId('iss_796cut'),
  duplicateOf: asIssueId('iss_365land'),
  prUrl: 'https://github.com/podium/podium/pull/791',
  dueAt: '2026-07-18T00:00:00.000Z',
  deferUntil: '2026-07-19T00:00:00.000Z',
  // intent
  origin: 'human',
  audience: 'agent',
  draft: false,
  // bookkeeping
  createdAt: '2026-07-17T08:00:00.000Z',
  updatedAt: '2026-07-17T10:45:00.000Z',
  archived: false,
  deletedAt: '2026-07-17T11:00:00.000Z',
  readAt: '2026-07-17T10:40:00.000Z',
  // sync
  revision: 17,
}

export const minimalIssue: Issue = {
  // identity
  id: asIssueId('iss_0000001'),
  repoPath: '/tmp/repo',
  repoId: null,
  seq: 1,
  // content
  title: '',
  description: '',
  design: null,
  acceptance: null,
  notes: null,
  // classification
  stage: 'backlog',
  type: 'task',
  priority: 0,
  pinned: false,
  sortKey: null,
  color: null,
  estimateMin: null,
  // workspace
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: '',
  defaultModel: '',
  defaultEffort: '',
  machineId: null,
  // linear
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  // assistant
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [],
  dependencyNote: null,
  // needs-human
  needsHuman: false,
  humanQuestion: null,
  humanQuestionOptions: null,
  humanQuestionAskedBy: null,
  humanQuestionAskedAt: null,
  // panel
  panel: null,
  // lifecycle
  assignee: null,
  parentId: null,
  closedReason: null,
  closedAt: null,
  tuckedAt: null,
  supersededBy: null,
  duplicateOf: null,
  prUrl: null,
  dueAt: null,
  deferUntil: null,
  // intent
  origin: 'human',
  audience: 'human',
  draft: false,
  // bookkeeping
  createdAt: '2026-07-17T08:00:00.000Z',
  updatedAt: '2026-07-17T08:00:00.000Z',
  archived: false,
  deletedAt: null,
  readAt: null,
  // sync
  revision: 1,
}
