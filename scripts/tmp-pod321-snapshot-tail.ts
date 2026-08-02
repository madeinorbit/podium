import { readFileSync, writeFileSync } from 'node:fs'

let file = 'apps/server/src/modules/sessions/publication/coordinator.ts'
let source = readFileSync(file, 'utf8').replace(
  'type SnapshotTail = Omit<',
  'export type SnapshotTail = Omit<',
)
writeFileSync(file, source)

file = 'apps/server/src/modules/sessions/lifecycle.ts'
source = readFileSync(file, 'utf8')
for (const typeImport of [
  '  AutomationRunWire,\n',
  '  AutomationWire,\n',
  '  IssueWire,\n',
  '  type IssueDepProjection,\n',
  '  type IssueProjection,\n',
  '  type RepoProjection,\n',
]) {
  source = source.replace(typeImport, '')
}
source = source.replace(
  "import { SessionPublicationCoordinator } from './publication/coordinator'",
  "import { SessionPublicationCoordinator, type SnapshotTail } from './publication/coordinator'",
)
const lifecycleDeps = `  /** The issue wire list (attachClient bootstrap + snapshot sync). */
  issuesWire(): IssueWire[]
  /** Normalized local truths for cold snapshot bootstrap; empty while the flag is off. */
  issueProjectionsWire(): IssueProjection[]
  issueDepsWire(): IssueDepProjection[]
  issueReposWire(): RepoProjection[]
  /** Durable scheduled definitions and run history for bootstrap/snapshot sync. */
  automationsWire(): AutomationWire[]
  automationRunsWire(): AutomationRunWire[]
`
if (!source.includes(lifecycleDeps)) throw new Error('snapshot deps absent')
source = source.replace(
  lifecycleDeps,
  `  /** Cross-feature snapshot material read from the already-constructed durable authority. */
  snapshotTail(): SnapshotTail
`,
)
const lifecycleTail = `      snapshotTail: () => ({
        issues: this.deps.issuesWire(),
        issueProjections: this.deps.issueProjectionsWire(),
        issueDeps: this.deps.issueDepsWire(),
        repos: this.deps.issueReposWire(),
        conversations: this.conversations().allConversations(),
        automations: this.deps.automationsWire(),
        automationRuns: this.deps.automationRunsWire(),
        diagnostics: this.conversations().diagnostics(),
      }),`
if (!source.includes(lifecycleTail)) throw new Error('tail body absent')
source = source.replace(lifecycleTail, '      snapshotTail: deps.snapshotTail,')
writeFileSync(file, source)

file = 'apps/server/src/relay.ts'
source = readFileSync(file, 'utf8')
const importNeedle =
  "import type { PublishWorkerClient } from './modules/sessions/publish-worker-client'"
source = source.replace(
  importNeedle,
  "import type { SnapshotTail } from './modules/sessions/publication/coordinator'\n" +
    importNeedle,
)
const publisherNeedle = '    const publisher = new IssuePublisher({'
const snapshotTail = `    const snapshotTail = (): SnapshotTail => ({
      issues: ledger.authority.snapshot('issue') as SnapshotTail['issues'],
      issueProjections: ledger.authority.snapshot('issueProjection') as SnapshotTail['issueProjections'],
      issueDeps: ledger.authority.snapshot('issueDep') as SnapshotTail['issueDeps'],
      repos: ledger.authority.snapshot('repo') as SnapshotTail['repos'],
      conversations: ledger.authority.snapshot('conversation') as SnapshotTail['conversations'],
      automations: ledger.authority.snapshot('automation') as SnapshotTail['automations'],
      automationRuns: ledger.authority.snapshot('automationRun') as SnapshotTail['automationRuns'],
      diagnostics: [...conversationDiagnostics.current],
    })
`
if (!source.includes(publisherNeedle)) throw new Error('publisher absent')
source = source.replace(publisherNeedle, snapshotTail + publisherNeedle)
const rootTail = `      issuesWire: () => publisher.currentIssuesList(),
      issueProjectionsWire: () => (issues.allProjections() ?? []).map((row) => row.value),
      issueDepsWire: () => (issues.allDepProjections() ?? []).map((row) => row.value),
      issueReposWire: () => (issues.allRepoProjections() ?? []).map((row) => row.value),
      automationsWire: () => automations.list(),
      automationRunsWire: () => automations.allRuns(),
`
if (!source.includes(rootTail)) throw new Error('root tail providers absent')
source = source.replace(rootTail, '      snapshotTail,\n')
writeFileSync(file, source)
