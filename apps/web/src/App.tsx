import {
  Activity,
  Archive,
  Bell,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Code2,
  Compass,
  Cpu,
  Diff,
  FileCode2,
  FileText,
  Gauge,
  GitBranch,
  History,
  KeyRound,
  Layers3,
  LayoutGrid,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Network,
  PanelRightClose,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Smartphone,
  Snowflake,
  Sparkles,
  SquareTerminal,
  TimerReset,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { ComponentType, CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { LiveSessions } from './LiveSessions'

type Icon = ComponentType<{ className?: string; size?: number; strokeWidth?: number }>

type ModeId = 'product' | 'dev' | 'spec' | 'search' | 'settings' | 'live'
type SettingId = 'environment' | 'skills' | 'notifications' | 'usage'
type DevDrawer = 'files' | 'diff' | 'git'
type HistoryMode = 'Hybrid' | 'Keyword' | 'Semantic'
type WorkStage =
  | 'Spec'
  | 'Planning'
  | 'Implementation'
  | 'Bugfixing'
  | 'Review'
  | 'Icebox'
  | 'Archive'
type WorkState = 'Needs attention' | 'Running' | 'Paused' | 'Review' | 'Icebox' | 'Archived'
type Harness = 'Claude Code' | 'Codex CLI'

type Mode = {
  id: ModeId
  label: string
  icon: Icon
}

type WorkItem = {
  id: string
  title: string
  kind: 'feature' | 'stream' | 'task'
  parent: string
  project: string
  repo: string
  stage: WorkStage
  state: WorkState
  summary: string
  next: string
  attention: string
  progress: number
  memory: number
  agents: string[]
  touched: string[]
  tags: string[]
  budget: string
  updated: string
}

type Session = {
  id: string
  title: string
  streamId: string
  harness: Harness
  machine: string
  role: 'controller' | 'spectator'
  status: 'Running' | 'Waiting' | 'Idle' | 'Stopped'
  geometry: string
  epoch: number
  screenHash: string
  memory: number
  usage: string
  output: string[]
}

type HistoryThread = {
  id: string
  title: string
  project: string
  repo: string
  harnesses: Harness[]
  machine: string
  status: string
  updated: string
  score: string
  why: string
  summary: string
  transcript: string[]
  artifacts: string[]
  lineage: string[]
  related: string[]
  bundle: string[]
  privacy: string[]
}

type AttentionEvent = {
  id: string
  severity: 'Human' | 'Review' | 'Memory' | 'Background'
  source: string
  stream: string
  message: string
  route: string
  updated: string
}

const modes: Mode[] = [
  { id: 'product', label: 'Product', icon: LayoutGrid },
  { id: 'live', label: 'Live', icon: Radio },
  { id: 'dev', label: 'Dev', icon: SquareTerminal },
  { id: 'spec', label: 'Spec', icon: FileText },
  { id: 'search', label: 'Search', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const settingTabs: Array<{ id: SettingId; label: string; icon: Icon }> = [
  { id: 'environment', label: 'Environment', icon: Compass },
  { id: 'skills', label: 'Skills & MCP', icon: Network },
  { id: 'notifications', label: 'Routing', icon: Bell },
  { id: 'usage', label: 'Usage', icon: Gauge },
]

const stages: WorkStage[] = [
  'Spec',
  'Planning',
  'Implementation',
  'Bugfixing',
  'Review',
  'Icebox',
  'Archive',
]

const stageNotes: Record<WorkStage, string> = {
  Spec: 'Open decisions, linked docs, research',
  Planning: 'Next steps, dependencies, agent scopes',
  Implementation: 'Active agents, files, terminal jump',
  Bugfixing: 'Repro, failing checks, verifier state',
  Review: 'Diffs, approvals, handoff checklist',
  Icebox: 'Recoverable unfinished work',
  Archive: 'Closed or parked reference work',
}

const initialWork: WorkItem[] = [
  {
    id: 'relay-ui',
    title: 'Relay handover UI',
    kind: 'stream',
    parent: 'Command Center',
    project: 'Podium',
    repo: 'podium/prototype',
    stage: 'Implementation',
    state: 'Needs attention',
    summary:
      'Terminal handover is wired through the relay. Desktop and phone takeover still need a clear controller model.',
    next: 'Choose spectator scaling policy, then resume the mobile toolbar verifier.',
    attention: 'Human decision: should spectators see scaled controller output or their own grid?',
    progress: 68,
    memory: 74,
    agents: ['Claude Code desktop', 'Codex mobile audit'],
    touched: ['apps/server/src/relay.ts', 'packages/protocol/src/messages.ts'],
    tags: ['terminal', 'mobile', 'handover'],
    budget: 'Claude 73% reset Jun 4',
    updated: '4 min ago',
  },
  {
    id: 'conversation-index',
    title: 'Conversation index',
    kind: 'feature',
    parent: 'History',
    project: 'Podium',
    repo: 'podium/prototype',
    stage: 'Planning',
    state: 'Running',
    summary:
      'Scanner finds Codex and Claude sessions, clusters related work, and extracts artifacts for search.',
    next: 'Generate a compact handoff bundle from the last three related sessions.',
    attention: 'No human input needed. Background summary pass is still running.',
    progress: 42,
    memory: 61,
    agents: ['History mapper'],
    touched: ['packages/agent-bridge/src/discovery/scanner.ts'],
    tags: ['search', 'handoff', 'indexing'],
    budget: '$2.80 projected non-sub cost',
    updated: '12 min ago',
  },
  {
    id: 'mobile-input',
    title: 'Mobile input toolbar',
    kind: 'task',
    parent: 'Mobile control',
    project: 'Podium',
    repo: 'podium/prototype',
    stage: 'Bugfixing',
    state: 'Paused',
    summary:
      'Key toolbar covers Escape, Tab, arrows, Ctrl-C, paste, and soft-keyboard resize coupling.',
    next: 'Resume when Android phone is attached for real visualViewport verification.',
    attention: 'Waiting on device. Idle agent can be stopped to save memory.',
    progress: 54,
    memory: 88,
    agents: ['Android verifier', 'Fixture TUI'],
    touched: ['packages/terminal-client/src/input.ts', 'apps/web/src/App.css'],
    tags: ['android', 'keyboard', 'verification'],
    budget: 'Idle burn 22m',
    updated: '28 min ago',
  },
  {
    id: 'skill-mcp',
    title: 'Skill and MCP manager',
    kind: 'feature',
    parent: 'Agent platform',
    project: 'Podium',
    repo: 'podium/product',
    stage: 'Review',
    state: 'Review',
    summary:
      'Install once, grant per harness, and inject credentials without leaking secrets into browser logs.',
    next: 'Approve credential boundary before implementation agents start.',
    attention: 'Review requested: credential scoping needs a product call.',
    progress: 31,
    memory: 46,
    agents: ['Spec researcher'],
    touched: ['docs/skills-mcp-boundary.md'],
    tags: ['settings', 'credentials', 'mcp'],
    budget: 'Spec research $0.90',
    updated: '1 hr ago',
  },
  {
    id: 'notification-routing',
    title: 'Notification routing',
    kind: 'feature',
    parent: 'Attention system',
    project: 'Podium',
    repo: 'podium/product',
    stage: 'Spec',
    state: 'Needs attention',
    summary:
      'Routing rules distinguish human-blocking events from background auto-mode noise across desktop and mobile.',
    next: 'Set the default escalation delay for watched streams.',
    attention:
      'Decision needed: mobile escalation after 5 or 10 minutes of unopened desktop alert?',
    progress: 22,
    memory: 18,
    agents: ['Notification spec'],
    touched: ['docs/notification-routing.md'],
    tags: ['mobile', 'attention', 'routing'],
    budget: 'No active spend',
    updated: '2 hr ago',
  },
  {
    id: 'cloud-sandbox-launch',
    title: 'Cloud sandbox launch',
    kind: 'feature',
    parent: 'Future compute',
    project: 'Podium',
    repo: 'podium/product',
    stage: 'Icebox',
    state: 'Icebox',
    summary:
      'Future work for launching agents into managed cloud sandboxes after local daemon flows are stable.',
    next: 'Recover when local machine daemon setup is settled.',
    attention: 'Iced by user; hidden from active attention until resumed.',
    progress: 9,
    memory: 0,
    agents: [],
    touched: ['notes/cloud-sandbox.md'],
    tags: ['future', 'sandbox'],
    budget: 'Iced',
    updated: '3 days ago',
  },
  {
    id: 'old-usage-model',
    title: 'Legacy usage model',
    kind: 'task',
    parent: 'Usage analytics',
    project: 'Podium',
    repo: 'podium/product',
    stage: 'Archive',
    state: 'Archived',
    summary:
      'Early token-only accounting was superseded by behavior-level usage rows tied to streams and sessions.',
    next: 'Reference only when comparing new projections.',
    attention: 'Archived. Not part of active work.',
    progress: 100,
    memory: 0,
    agents: [],
    touched: ['docs/usage-v0.md'],
    tags: ['archive', 'usage'],
    budget: 'Archived',
    updated: 'last week',
  },
]

const sessions: Session[] = [
  {
    id: 'sess-1',
    title: 'Claude Code - relay implementation',
    streamId: 'relay-ui',
    harness: 'Claude Code',
    machine: 'macbook-pro.local',
    role: 'controller',
    status: 'Waiting',
    geometry: '132x38',
    epoch: 7,
    screenHash: 'b92e71',
    memory: 72,
    usage: 'implementation loop / subscription',
    output: [
      '$ bun test apps/server/test/wsServer.test.ts',
      '2 passed in 840ms',
      'Needs decision: controller geometry policy before UI wiring',
    ],
  },
  {
    id: 'sess-2',
    title: 'Codex CLI - mobile audit',
    streamId: 'relay-ui',
    harness: 'Codex CLI',
    machine: 'linux-vps',
    role: 'spectator',
    status: 'Running',
    geometry: '54x24',
    epoch: 7,
    screenHash: 'b92e71',
    memory: 63,
    usage: 'Playwright verification / $0.44',
    output: [
      '$ playwright chromium --pixel-profile',
      'mobile viewport attached as spectator',
      'screenHash matches controller after takeover',
    ],
  },
  {
    id: 'sess-3',
    title: 'History mapper',
    streamId: 'conversation-index',
    harness: 'Claude Code',
    machine: 'macbook-pro.local',
    role: 'controller',
    status: 'Running',
    geometry: '118x32',
    epoch: 3,
    screenHash: 'f18ac0',
    memory: 58,
    usage: 'history indexing / $1.12',
    output: ['indexed 1,284 sessions', 'merged 23 duplicate threads', 'extracting artifacts...'],
  },
  {
    id: 'sess-4',
    title: 'Android verifier',
    streamId: 'mobile-input',
    harness: 'Codex CLI',
    machine: 'pixel-8-usb',
    role: 'controller',
    status: 'Idle',
    geometry: '48x19',
    epoch: 5,
    screenHash: 'c04d0a',
    memory: 91,
    usage: 'idle waiting / near threshold',
    output: [
      'adb forward ready',
      'waiting for phone unlock',
      'idle for 22m - resume keeps context',
    ],
  },
]

const historyThreads: HistoryThread[] = [
  {
    id: 'relay-takeover',
    title: 'RelayHub takeover gating',
    project: 'Podium',
    repo: 'podium/prototype',
    harnesses: ['Claude Code', 'Codex CLI'],
    machine: 'macbook-pro.local, linux-vps',
    status: 'awaiting review',
    updated: '9 min ago',
    score: '0.94 hybrid',
    why: 'transcript hit: controller geometry; artifact hit: relay.ts',
    summary:
      'Built websocket relay gating for terminal control transfer. Remaining question is how spectators render controller geometry after takeover.',
    transcript: [
      'Claude Code: relay tests pass, but mobile geometry policy is still undecided.',
      'Codex CLI: pixel check shows scaled controller output preserves screenHash.',
      'Human: keep native terminal access, no abstraction over raw output.',
    ],
    artifacts: [
      'apps/server/src/relay.ts',
      'packages/protocol/src/messages.ts',
      'bun test apps/server/test/wsServer.test.ts',
      'branch prototype/phase2-relay',
      'decision: controller geometry is authoritative',
    ],
    lineage: [
      'parent: relay implementation',
      'child: Codex mobile audit',
      'follow-up: toolbar breakpoint',
    ],
    related: ['Mobile keyboard viewport research', 'Terminal scrollback replay'],
    bundle: [
      'Summary with acceptance checks',
      'Repo state and touched files',
      'Prior decisions and open question',
      'Failed/green commands',
      'Redacted local machine paths',
    ],
    privacy: ['redact home paths', 'local-only screenshots', 'do not summarize .env'],
  },
  {
    id: 'scanner-fixture',
    title: 'Codex scanner fixture path bug',
    project: 'Podium',
    repo: 'podium/prototype',
    harnesses: ['Codex CLI'],
    machine: 'linux-vps',
    status: 'completed',
    updated: '2 days ago',
    score: '0.88 semantic',
    why: 'similar past work: session indexing and path redaction',
    summary:
      'Fixed scanner fixture paths so attached-machine conversation indexing can group work by repo and branch.',
    transcript: [
      'Reproduced fixture path mismatch',
      'Adjusted path normalization',
      'Added ignored-path coverage',
    ],
    artifacts: [
      'packages/agent-bridge/src/discovery/scanner.ts',
      '3 files touched',
      '5 tests passed',
    ],
    lineage: ['parent: conversation index', 'resume: fixture cleanup'],
    related: ['RelayHub takeover gating', 'Skill credential boundary'],
    bundle: ['Scanner summary', 'Path normalization rule', 'Ignored paths', 'Regression command'],
    privacy: ['ignored paths active', 'redacted home directory'],
  },
  {
    id: 'skill-credential',
    title: 'Skill credential boundary',
    project: 'Podium',
    repo: 'podium/product',
    harnesses: ['Claude Code'],
    machine: 'macbook-pro.local',
    status: 'needs decision',
    updated: '1 hr ago',
    score: '0.82 keyword',
    why: 'keyword hit: credential, MCP, env injection',
    summary:
      'Compared vault-managed secrets against inherited shell env. Recommends browser sees metadata only and daemon injects masked env.',
    transcript: [
      'Spec researcher: inherited env is risky',
      'Decision needed: lock inheritance by default',
    ],
    artifacts: ['docs/skills-mcp-boundary.md', '2 open decisions', 'credential matrix sketch'],
    lineage: ['parent: Skill and MCP manager', 'blocked: credential scope'],
    related: ['Notification routing', 'Codex scanner fixture path bug'],
    bundle: ['Boundary diagram', 'Grant matrix', 'Open questions', 'Affected harnesses'],
    privacy: ['mask token names except env key', 'local-only vault metadata'],
  },
]

const notificationEvents = [
  {
    type: 'Human decision required',
    source: 'Claude Code',
    stream: 'Relay handover UI',
    severity: 'Human',
    desktop: 'Immediate',
    mobile: 'After 8 min',
    suppression: 'desktop active 2 min ago',
    quiet: 'bypass watched stream',
    escalation: 'mobile in 8 min',
  },
  {
    type: 'Agent completed task',
    source: 'Codex CLI',
    stream: 'Relay handover UI',
    severity: 'Review',
    desktop: 'Digest',
    mobile: 'Off',
    suppression: 'watched stream only',
    quiet: 'respect',
    escalation: 'none',
  },
  {
    type: 'High memory idle agent',
    source: 'Codex CLI',
    stream: 'Mobile input toolbar',
    severity: 'Memory',
    desktop: 'Warning',
    mobile: 'Quiet hours only if escalating',
    suppression: 'desktop seen',
    quiet: 'queue until 08:00',
    escalation: 'after 30 min idle',
  },
  {
    type: 'Auto-mode background progress',
    source: 'Claude Code',
    stream: 'Conversation index',
    severity: 'Background',
    desktop: 'Inbox',
    mobile: 'Off',
    suppression: 'not human blocking',
    quiet: 'queue',
    escalation: 'only if blocked',
  },
]

const installedTools = [
  {
    type: 'Skill',
    name: 'Superpowers',
    source: 'openai-curated/superpowers',
    version: '03fa6cd3',
    credentials: 'none',
    status: 'Installed',
  },
  {
    type: 'MCP',
    name: 'GitHub',
    source: 'plugin/github',
    version: '03fa6cd3',
    credentials: 'GITHUB_TOKEN',
    status: 'Enabled',
  },
  {
    type: 'MCP',
    name: 'Sentry',
    source: 'plugin/sentry',
    version: '03fa6cd3',
    credentials: 'SENTRY_AUTH_TOKEN',
    status: 'Blocked: missing credential',
  },
]

const skillAccess = [
  ['Superpowers', 'Enabled / global', 'Enabled / project', 'Disabled'],
  ['GitHub MCP', 'Enabled / repo', 'Restart required', 'Disabled'],
  ['Sentry MCP', 'Blocked: missing credential', 'Disabled', 'Disabled'],
  ['OpenAI docs', 'Enabled / global', 'Enabled / global', 'Project scoped'],
]

const machineRows = [
  {
    name: 'macbook-pro.local',
    status: 'Ready',
    daemon: 'online',
    lastSeen: 'now',
    harnesses: 'Claude Code 2.1, Codex CLI 0.52',
  },
  {
    name: 'linux-vps',
    status: 'Needs worktree confirmation',
    daemon: 'online',
    lastSeen: '4 min ago',
    harnesses: 'Codex CLI 0.52',
  },
  {
    name: 'pixel-8-usb',
    status: 'Device locked',
    daemon: 'waiting',
    lastSeen: '28 min ago',
    harnesses: 'Chrome remote debug',
  },
]

const usageRows = [
  [
    'Relay handover UI',
    'implementation loop',
    'Claude Code',
    '73% plan used',
    '$4.20 projected',
    'near reset',
  ],
  [
    'Mobile input toolbar',
    'idle waiting',
    'Codex CLI',
    '22 min idle',
    '$0.64 avoidable',
    'stop idle',
  ],
  [
    'Conversation index',
    'history indexing',
    'Claude Code',
    '1,284 sessions',
    '$1.12 projected',
    'normal',
  ],
  [
    'Skill and MCP manager',
    'spec research',
    'Claude Code',
    '2 decisions',
    '$0.90 projected',
    'review',
  ],
]

function classNames(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(' ')
}

function clampProgress(value: number) {
  return `${Math.max(0, Math.min(100, value))}%`
}

function stateClass(value: string) {
  return value.toLowerCase().replaceAll(' ', '-').replaceAll(':', '')
}

export function App() {
  const [activeMode, setActiveMode] = useState<ModeId>(
    new URLSearchParams(window.location.search).has('server') ? 'live' : 'product',
  )
  const [activeSetting, setActiveSetting] = useState<SettingId>('environment')
  const [streams, setStreams] = useState<WorkItem[]>(initialWork)
  const [selectedStreamId, setSelectedStreamId] = useState('relay-ui')
  const [selectedSessionId, setSelectedSessionId] = useState('sess-1')
  const [search, setSearch] = useState('controller geometry')
  const [historyMode, setHistoryMode] = useState<HistoryMode>('Hybrid')
  const [selectedHistoryId, setSelectedHistoryId] = useState(historyThreads[0]?.id ?? '')
  const [superagentOpen, setSuperagentOpen] = useState(true)
  const [devDrawer, setDevDrawer] = useState<DevDrawer>('files')
  const [mobilePreview, setMobilePreview] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const selectedStream = streams.find((stream) => stream.id === selectedStreamId) ?? streams[0]
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0]
  const selectedHistory =
    historyThreads.find((thread) => thread.id === selectedHistoryId) ?? historyThreads[0]

  const attentionEvents = useMemo((): AttentionEvent[] => {
    return [
      ...streams
        .filter((stream) => stream.state === 'Needs attention' || stream.state === 'Review')
        .map((stream) => ({
          id: stream.id,
          severity: stream.state === 'Review' ? ('Review' as const) : ('Human' as const),
          source: stream.agents[0] ?? 'Superagent',
          stream: stream.title,
          message: stream.attention,
          route:
            stream.state === 'Review'
              ? 'desktop + watched mobile'
              : 'desktop now, mobile if unopened',
          updated: stream.updated,
        })),
      ...sessions
        .filter((session) => session.memory > 85)
        .map((session) => ({
          id: session.id,
          severity: 'Memory' as const,
          source: session.harness,
          stream: streams.find((stream) => stream.id === session.streamId)?.title ?? session.title,
          message: `${session.title} is idle at ${session.memory}% memory.`,
          route: 'desktop warning, mobile after escalation',
          updated: 'now',
        })),
    ]
  }, [streams])

  const attentionCount = attentionEvents.filter((event) => event.severity !== 'Background').length
  const activeSessions = sessions.filter(
    (session) => session.status === 'Running' || session.status === 'Waiting',
  )
  const highMemoryCount = sessions.filter((session) => session.memory > 80).length

  const filteredHistory = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    if (!normalized) {
      return historyThreads
    }
    return historyThreads.filter((thread) =>
      [
        thread.title,
        thread.summary,
        thread.project,
        thread.repo,
        thread.why,
        ...thread.artifacts,
        ...thread.related,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    )
  }, [search])

  function updateStreamState(id: string, state: WorkState) {
    setStreams((current) =>
      current.map((stream) =>
        stream.id === id
          ? {
              ...stream,
              state,
              stage:
                state === 'Icebox' ? 'Icebox' : state === 'Archived' ? 'Archive' : stream.stage,
            }
          : stream,
      ),
    )
  }

  function moveStage(id: string, stage: WorkStage) {
    setStreams((current) =>
      current.map((stream) =>
        stream.id === id
          ? {
              ...stream,
              stage,
              state:
                stage === 'Icebox'
                  ? 'Icebox'
                  : stage === 'Archive'
                    ? 'Archived'
                    : stream.state === 'Icebox' || stream.state === 'Archived'
                      ? 'Paused'
                      : stream.state,
            }
          : stream,
      ),
    )
  }

  function openSession(sessionId: string) {
    setSelectedSessionId(sessionId)
    setActiveMode('dev')
  }

  function selectMode(mode: ModeId) {
    setActiveMode(mode)
    setMobileMenuOpen(false)
  }

  if (!selectedStream || !selectedSession || !selectedHistory) {
    return <div className="empty-state">No prototype data is available.</div>
  }

  return (
    <div className={classNames('app-shell', mobilePreview && 'mobile-preview-shell')}>
      <aside className="side-rail" aria-label="Primary">
        <div className="brand-lockup">
          <div className="brand-mark">P</div>
          <div>
            <strong>Podium</strong>
            <span>Command Center</span>
          </div>
        </div>

        <label className="workspace-picker">
          <span>Workspace</span>
          <select defaultValue="podium">
            <option value="podium">Podium / prototype</option>
            <option value="product">Podium / product</option>
            <option value="all">All projects</option>
          </select>
        </label>

        <nav className="rail-nav">
          {modes.map((mode) => {
            const Icon = mode.icon
            return (
              <button
                key={mode.id}
                className={classNames('nav-button', activeMode === mode.id && 'active')}
                type="button"
                onClick={() => selectMode(mode.id)}
                aria-pressed={activeMode === mode.id}
              >
                <Icon size={18} />
                <span>{mode.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="rail-status">
          <div>
            <Bell size={16} />
            <span>Mobile suppressed</span>
          </div>
          <small>Desktop active 2 min ago</small>
        </div>
      </aside>

      <main className="workspace">
        <TopBar
          activeMode={activeMode}
          selectedStream={selectedStream}
          attentionCount={attentionCount}
          runningCount={activeSessions.length}
          highMemoryCount={highMemoryCount}
          mobilePreview={mobilePreview}
          setMobilePreview={setMobilePreview}
        />

        <div className="workspace-grid">
          <section className="main-stage">
            {activeMode === 'product' && (
              <ProductMode
                streams={streams}
                sessions={sessions}
                selectedStream={selectedStream}
                selectedStreamId={selectedStreamId}
                setSelectedStreamId={setSelectedStreamId}
                setSelectedSessionId={setSelectedSessionId}
                openSession={openSession}
                updateStreamState={updateStreamState}
                moveStage={moveStage}
                attentionEvents={attentionEvents}
              />
            )}

            {activeMode === 'live' && <LiveSessions />}

            {activeMode === 'dev' && (
              <DevWorkbench
                sessions={sessions}
                streams={streams}
                selectedStream={selectedStream}
                selectedSession={selectedSession}
                selectedSessionId={selectedSessionId}
                setSelectedSessionId={setSelectedSessionId}
                devDrawer={devDrawer}
                setDevDrawer={setDevDrawer}
              />
            )}

            {activeMode === 'spec' && (
              <SpecMode selectedStream={selectedStream} attentionEvents={attentionEvents} />
            )}

            {activeMode === 'search' && (
              <HistoryWorkspace
                search={search}
                setSearch={setSearch}
                historyMode={historyMode}
                setHistoryMode={setHistoryMode}
                threads={filteredHistory}
                selectedHistory={selectedHistory}
                selectedHistoryId={selectedHistoryId}
                setSelectedHistoryId={setSelectedHistoryId}
              />
            )}

            {activeMode === 'settings' && (
              <SettingsMode
                activeSetting={activeSetting}
                setActiveSetting={setActiveSetting}
                selectedStream={selectedStream}
                selectedSession={selectedSession}
              />
            )}
          </section>

          {superagentOpen && (
            <SuperagentDock
              selectedStream={selectedStream}
              selectedSession={selectedSession}
              sessions={sessions}
              attentionEvents={attentionEvents}
              onClose={() => setSuperagentOpen(false)}
            />
          )}

          {!superagentOpen && (
            <button className="open-dock" type="button" onClick={() => setSuperagentOpen(true)}>
              <Bot size={18} />
              Superagent
            </button>
          )}
        </div>
      </main>

      {mobileMenuOpen && (
        <section className="mobile-more-panel" aria-label="More mobile modes">
          {modes.map((mode) => {
            const Icon = mode.icon
            return (
              <button
                key={mode.id}
                className={classNames(activeMode === mode.id && 'active')}
                type="button"
                onClick={() => selectMode(mode.id)}
              >
                <Icon size={18} />
                <span>{mode.label}</span>
              </button>
            )
          })}
        </section>
      )}

      <nav className="mobile-tabbar" aria-label="Mobile primary">
        {modes.slice(0, 4).map((mode) => {
          const Icon = mode.icon
          return (
            <button
              key={mode.id}
              className={classNames(activeMode === mode.id && 'active')}
              type="button"
              onClick={() => selectMode(mode.id)}
              title={mode.label}
            >
              <Icon size={18} />
              <span>{mode.label}</span>
            </button>
          )
        })}
        <button
          className={classNames(mobileMenuOpen && 'active', activeMode === 'settings' && 'active')}
          type="button"
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-expanded={mobileMenuOpen}
        >
          <MoreHorizontal size={18} />
          <span>More</span>
        </button>
      </nav>
    </div>
  )
}

function TopBar({
  activeMode,
  selectedStream,
  attentionCount,
  runningCount,
  highMemoryCount,
  mobilePreview,
  setMobilePreview,
}: {
  activeMode: ModeId
  selectedStream: WorkItem
  attentionCount: number
  runningCount: number
  highMemoryCount: number
  mobilePreview: boolean
  setMobilePreview: (value: boolean) => void
}) {
  const title =
    activeMode === 'product'
      ? 'Command Center'
      : activeMode === 'dev'
        ? 'Dev Workbench'
        : activeMode === 'spec'
          ? 'Spec Studio'
          : activeMode === 'search'
            ? 'Conversation Search'
            : 'Settings'

  return (
    <header className="top-bar">
      <div>
        <p className="eyebrow">
          {selectedStream.project} / {selectedStream.parent} / {selectedStream.title}
        </p>
        <h1>{title}</h1>
      </div>
      <div className="status-strip">
        <StatusPill icon={UserRound} label="Attention" value={String(attentionCount)} tone="hot" />
        <StatusPill icon={Activity} label="Active" value={String(runningCount)} tone="ok" />
        <StatusPill icon={Cpu} label="Memory" value={String(highMemoryCount)} tone="warn" />
        <StatusPill icon={Bell} label="Routing" value="desktop" tone="info" />
        <button
          className={classNames('preview-toggle', mobilePreview && 'active')}
          type="button"
          onClick={() => setMobilePreview(!mobilePreview)}
        >
          <Smartphone size={16} />
          Mobile preview
        </button>
      </div>
    </header>
  )
}

function StatusPill({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: Icon
  label: string
  value: string
  tone: string
}) {
  return (
    <div className={classNames('status-pill', tone)}>
      <Icon size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ProductMode({
  streams,
  sessions,
  selectedStream,
  selectedStreamId,
  setSelectedStreamId,
  setSelectedSessionId,
  openSession,
  updateStreamState,
  moveStage,
  attentionEvents,
}: {
  streams: WorkItem[]
  sessions: Session[]
  selectedStream: WorkItem
  selectedStreamId: string
  setSelectedStreamId: (id: string) => void
  setSelectedSessionId: (id: string) => void
  openSession: (id: string) => void
  updateStreamState: (id: string, state: WorkState) => void
  moveStage: (id: string, stage: WorkStage) => void
  attentionEvents: AttentionEvent[]
}) {
  return (
    <div className="product-layout">
      <section className="board-panel" aria-label="Stream tracker">
        <div className="section-toolbar">
          <div>
            <p className="eyebrow">Product mode</p>
            <h2>Streams by stage</h2>
          </div>
          <div className="segmented">
            <button type="button" className="active">
              Project
            </button>
            <button type="button">Repo</button>
            <button type="button">Intent</button>
          </div>
        </div>

        <div className="stage-board">
          {stages.map((stage) => {
            const stageStreams = streams.filter((stream) => stream.stage === stage)
            return (
              <section className="stage-column" key={stage}>
                <header>
                  <span>{stage}</span>
                  <small>{stageNotes[stage]}</small>
                </header>
                {stageStreams.map((stream) => {
                  const active = stream.id === selectedStreamId
                  const streamSessions = sessions.filter(
                    (session) => session.streamId === stream.id,
                  )
                  return (
                    <button
                      key={stream.id}
                      className={classNames(
                        'work-card',
                        active && 'active',
                        stateClass(stream.state),
                      )}
                      type="button"
                      onClick={() => setSelectedStreamId(stream.id)}
                    >
                      <span className="work-card-top">
                        <strong>{stream.title}</strong>
                        <small>{stream.updated}</small>
                      </span>
                      <span className="breadcrumb">
                        {stream.project} / {stream.parent}
                      </span>
                      <span className="work-summary">{stream.next}</span>
                      <span className="work-meta">
                        <span>{stream.state}</span>
                        <span>{streamSessions.length} sessions</span>
                        <span>{stream.budget}</span>
                      </span>
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
      </section>

      <aside className="work-detail-panel" aria-label="Selected stream">
        <article className="detail-panel">
          <div className="detail-heading">
            <div>
              <p className="eyebrow">
                {selectedStream.project} / {selectedStream.repo}
              </p>
              <h2>{selectedStream.title}</h2>
              <p>{selectedStream.summary}</p>
            </div>
            <span className={classNames('state-badge', stateClass(selectedStream.state))}>
              {selectedStream.state}
            </span>
          </div>

          <div className="attention-banner">
            <UserRound size={18} />
            <span>{selectedStream.attention}</span>
          </div>

          <div className="metric-row">
            <Metric
              label="Progress"
              value={`${selectedStream.progress}%`}
              progress={selectedStream.progress}
            />
            <Metric
              label="Memory"
              value={`${selectedStream.memory}%`}
              progress={selectedStream.memory}
            />
            <Metric label="Usage" value={selectedStream.budget} progress={62} />
          </div>

          <div className="control-strip">
            <button type="button" onClick={() => updateStreamState(selectedStream.id, 'Running')}>
              <Play size={16} /> Resume
            </button>
            <button type="button" onClick={() => updateStreamState(selectedStream.id, 'Paused')}>
              <Pause size={16} /> Pause
            </button>
            <button type="button" onClick={() => updateStreamState(selectedStream.id, 'Icebox')}>
              <Snowflake size={16} /> Icebox
            </button>
            <button type="button" onClick={() => updateStreamState(selectedStream.id, 'Archived')}>
              <Archive size={16} /> Archive
            </button>
          </div>

          <label className="field-row">
            <span>Move stage</span>
            <select
              value={selectedStream.stage}
              onChange={(event) => moveStage(selectedStream.id, event.target.value as WorkStage)}
            >
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
        </article>

        <section className="detail-panel">
          <div className="section-toolbar compact">
            <h3>Active agents</h3>
            <button type="button">
              <Sparkles size={15} /> Start scoped
            </button>
          </div>
          <div className="agent-list">
            {sessions
              .filter((session) => session.streamId === selectedStream.id)
              .map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="agent-row"
                  onClick={() => {
                    setSelectedSessionId(session.id)
                    openSession(session.id)
                  }}
                >
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {session.harness} / {session.machine}
                    </small>
                  </span>
                  <span className={classNames('state-badge', stateClass(session.status))}>
                    {session.status}
                  </span>
                </button>
              ))}
          </div>
        </section>

        <ContextComposer selectedStream={selectedStream} selectedSession={sessions[0]} compact />
        <AttentionQueue events={attentionEvents} />
      </aside>
    </div>
  )
}

function ContextComposer({
  selectedStream,
  selectedSession,
  compact,
}: {
  selectedStream: WorkItem
  selectedSession?: Session
  compact?: boolean
}) {
  return (
    <section className={classNames('context-composer', compact && 'compact')}>
      <div className="section-toolbar compact">
        <div>
          <p className="eyebrow">Context composer</p>
          <h3>Start with a brief</h3>
        </div>
        <span className="state-badge info">concise</span>
      </div>
      <div className="source-chips">
        <span>Current stream</span>
        <span>Related history</span>
        <span>Pinned spec</span>
        <span>Repo state</span>
        <span>Touched files</span>
      </div>
      <div className="brief-preview">
        <strong>Brief: {selectedStream.title}</strong>
        <p>
          Prior decision: controller geometry is authoritative. Open question: spectator scaling
          policy. Files: {selectedStream.touched.join(', ')}.
        </p>
        <small>Parent session: {selectedSession?.title ?? 'new scoped launch'}</small>
      </div>
      <div className="composer-options">
        <label>
          <input type="checkbox" defaultChecked /> Decisions
        </label>
        <label>
          <input type="checkbox" defaultChecked /> Open tasks
        </label>
        <label>
          <input type="checkbox" defaultChecked /> Redactions
        </label>
        <label>
          Token budget
          <select defaultValue="medium">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="full">Full</option>
          </select>
        </label>
      </div>
      <div className="control-strip">
        <button type="button">
          <Play size={16} /> Start with brief
        </button>
        <button type="button">
          <Layers3 size={16} /> Fork full context
        </button>
      </div>
    </section>
  )
}

function AttentionQueue({ events }: { events: AttentionEvent[] }) {
  return (
    <section className="attention-queue">
      <div className="section-toolbar compact">
        <h3>Attention queue</h3>
        <span>{events.length}</span>
      </div>
      {events.map((event) => (
        <div className="queue-row" key={event.id}>
          <span className={classNames('state-badge', stateClass(event.severity))}>
            {event.severity}
          </span>
          <strong>{event.stream}</strong>
          <p>{event.message}</p>
          <small>
            {event.source} / {event.route} / {event.updated}
          </small>
          <div className="row-actions">
            <button type="button">Open</button>
            <button type="button">Mute</button>
            <button type="button">Handled</button>
          </div>
        </div>
      ))}
    </section>
  )
}

function DevWorkbench({
  sessions,
  streams,
  selectedStream,
  selectedSession,
  selectedSessionId,
  setSelectedSessionId,
  devDrawer,
  setDevDrawer,
}: {
  sessions: Session[]
  streams: WorkItem[]
  selectedStream: WorkItem
  selectedSession: Session
  selectedSessionId: string
  setSelectedSessionId: (id: string) => void
  devDrawer: DevDrawer
  setDevDrawer: (drawer: DevDrawer) => void
}) {
  const scopedSessions = sessions.filter(
    (session) => session.streamId === selectedStream.id || selectedStream.id === 'relay-ui',
  )

  return (
    <div className="dev-layout">
      <section className="terminal-workbench">
        <div className="section-toolbar">
          <div>
            <p className="eyebrow">Dev mode / {selectedStream.title}</p>
            <h2>Terminal grid</h2>
          </div>
          <div className="segmented">
            <button type="button" className="active">
              2x2
            </button>
            <button type="button">Focus</button>
            <button type="button">All active</button>
          </div>
          <div className="tool-buttons">
            <button type="button" title="Open browser preview">
              <Monitor size={16} /> Browser
            </button>
            <button type="button" onClick={() => setDevDrawer('files')} title="Open code drawer">
              <Code2 size={16} /> Code
            </button>
            <button type="button" onClick={() => setDevDrawer('diff')} title="Open diff drawer">
              <Diff size={16} /> Diffs
            </button>
            <button type="button" onClick={() => setDevDrawer('git')} title="Open Git drawer">
              <GitBranch size={16} /> Git
            </button>
          </div>
        </div>

        <div className="terminal-grid">
          {scopedSessions.map((session) => (
            <button
              key={session.id}
              className={classNames('terminal-tile', selectedSessionId === session.id && 'active')}
              type="button"
              onClick={() => setSelectedSessionId(session.id)}
            >
              <span className="terminal-title">
                <SquareTerminal size={16} />
                {session.title}
              </span>
              <span className="terminal-meta">
                {session.harness} / {session.machine} / {session.geometry}
              </span>
              <span className="terminal-badges">
                <span className={classNames('state-badge', stateClass(session.status))}>
                  {session.status}
                </span>
                <span>{session.memory}% memory</span>
                <span>{session.usage}</span>
              </span>
              <pre>{session.output.join('\n')}</pre>
            </button>
          ))}
        </div>

        <section className="session-control">
          <div>
            <h3>{selectedSession.title}</h3>
            <p>
              {selectedSession.role} / epoch {selectedSession.epoch} / hash{' '}
              {selectedSession.screenHash}
            </p>
          </div>
          <div className="control-strip compact">
            <button type="button">
              <UserRound size={16} /> Take control
            </button>
            <button type="button">
              <Layers3 size={16} /> Fork context
            </button>
            <button type="button">
              <Archive size={16} /> Merge results
            </button>
            <button type="button">
              <CheckCircle2 size={16} /> Run check
            </button>
            <button type="button">
              <TimerReset size={16} /> Stop idle
            </button>
            <button type="button">
              <RotateCcw size={16} /> Redraw
            </button>
          </div>
          <div className="keybar">
            {['Esc', 'Tab', 'Ctrl-C', 'Left', 'Right', 'Enter', 'Paste'].map((key) => (
              <button key={key} type="button">
                <KeyRound size={14} />
                {key}
              </button>
            ))}
          </div>
        </section>
      </section>

      <DevDrawerPanel
        drawer={devDrawer}
        setDrawer={setDevDrawer}
        selectedStream={selectedStream}
        selectedSession={selectedSession}
        streams={streams}
      />
    </div>
  )
}

function DevDrawerPanel({
  drawer,
  setDrawer,
  selectedStream,
  selectedSession,
  streams,
}: {
  drawer: DevDrawer
  setDrawer: (drawer: DevDrawer) => void
  selectedStream: WorkItem
  selectedSession: Session
  streams: WorkItem[]
}) {
  return (
    <aside className="dev-drawer" aria-label="Dev drawer">
      <div className="drawer-tabs">
        {(['files', 'diff', 'git'] as DevDrawer[]).map((item) => (
          <button
            key={item}
            type="button"
            className={classNames(drawer === item && 'active')}
            onClick={() => setDrawer(item)}
          >
            {item === 'files' && <FileCode2 size={16} />}
            {item === 'diff' && <Diff size={16} />}
            {item === 'git' && <GitBranch size={16} />}
            {item}
          </button>
        ))}
      </div>

      {drawer === 'files' && (
        <div className="drawer-body">
          <p className="eyebrow">Files / {selectedSession.title}</p>
          <div className="file-tree">
            <h3>Touched by selected agent</h3>
            {selectedStream.touched.map((path, index) => (
              <button key={path} type="button">
                <span>{path}</span>
                <small>{index === 0 ? 'dirty' : 'open'}</small>
              </button>
            ))}
            <h3>Env</h3>
            <button type="button">
              <span>.env.local</span>
              <small>masked / read-only</small>
            </button>
          </div>
          <section className="editor-preview">
            <div className="section-toolbar compact">
              <h3>{selectedStream.touched[0]}</h3>
              <button type="button">
                <LockKeyhole size={15} /> Unlock edit
              </button>
            </div>
            <pre>{`function requestControl(clientId) {
  resizeToLastViewport(clientId)
  redrawAgent()
  bumpEpoch()
}`}</pre>
            <div className="env-editor">
              <span>OPENAI_API_KEY</span>
              <code>podium:vault/openai-prod****</code>
              <button type="button">Reveal row</button>
            </div>
          </section>
        </div>
      )}

      {drawer === 'diff' && (
        <div className="drawer-body">
          <p className="eyebrow">Diff review</p>
          <h3>Changed files</h3>
          <div className="diff-list">
            {streams.slice(0, 4).map((stream) => (
              <button key={stream.id} type="button">
                <span>{stream.touched[0]}</span>
                <small>{stream.stage}</small>
              </button>
            ))}
          </div>
          <pre className="diff-preview">{`@@ apps/web/src/App.tsx
- top-level IDE/Git feature page
+ contextual Dev drawer
+ branch status and patch preview`}</pre>
          <div className="control-strip compact">
            <button type="button">Copy patch</button>
            <button type="button">Stage file</button>
            <button type="button">Run check</button>
          </div>
        </div>
      )}

      {drawer === 'git' && (
        <div className="drawer-body">
          <p className="eyebrow">Git state</p>
          <h3>prototype/ui</h3>
          <div className="git-summary">
            <span>base prototype/phase2-relay</span>
            <span>ahead 1</span>
            <span>staged 0</span>
            <span>unstaged 2</span>
            <span>untracked 1</span>
          </div>
          <div className="table-list compact">
            <button type="button">
              <span>apps/web/src/App.tsx</span>
              <span>unstaged</span>
              <span>large rewrite</span>
            </button>
            <button type="button">
              <span>apps/web/src/App.css</span>
              <span>unstaged</span>
              <span>layout polish</span>
            </button>
          </div>
          <div className="control-strip compact">
            <button type="button">Prepare handoff</button>
            <button type="button">Copy patch</button>
            <button type="button">Open terminal at file</button>
          </div>
        </div>
      )}
    </aside>
  )
}

function SpecMode({
  selectedStream,
  attentionEvents,
}: {
  selectedStream: WorkItem
  attentionEvents: AttentionEvent[]
}) {
  return (
    <div className="spec-layout">
      <aside className="doc-outline">
        {['Goal', 'Decisions', 'Protocol', 'Handover', 'Acceptance'].map((item, index) => (
          <button key={item} className={index === 1 ? 'active' : undefined} type="button">
            {item}
          </button>
        ))}
      </aside>
      <article className="spec-document">
        <p className="eyebrow">Spec mode / {selectedStream.title}</p>
        <h2>Handover and input prototype</h2>
        <p>
          Controller geometry remains authoritative across desktop and mobile. The visible decision
          is whether spectators render scaled controller output or preserve their own grid.
        </p>
        <div className="spec-callout">
          <FileText size={18} />
          Spectators render controller grid scaled so screenHash stays comparable after takeover.
        </div>
        <div className="decision-stack">
          <label>
            <input type="checkbox" defaultChecked /> Mobile takeover redraw policy approved
          </label>
          <label>
            <input type="checkbox" /> Decide transcript vs raw PTY replay boundaries
          </label>
          <label>
            <input type="checkbox" /> Resume blocked agents after product question
          </label>
        </div>
      </article>
      <aside className="research-panel">
        <h3>Decision queue</h3>
        {attentionEvents.slice(0, 3).map((event) => (
          <div className="queue-row" key={event.id}>
            <span className={classNames('state-badge', stateClass(event.severity))}>
              {event.severity}
            </span>
            <strong>{event.stream}</strong>
            <p>{event.message}</p>
          </div>
        ))}
        <button type="button">
          <Sparkles size={16} /> Research decision
        </button>
        <button type="button">
          <CheckCircle2 size={16} /> Approve and unblock
        </button>
      </aside>
    </div>
  )
}

function HistoryWorkspace({
  search,
  setSearch,
  historyMode,
  setHistoryMode,
  threads,
  selectedHistory,
  selectedHistoryId,
  setSelectedHistoryId,
}: {
  search: string
  setSearch: (value: string) => void
  historyMode: HistoryMode
  setHistoryMode: (mode: HistoryMode) => void
  threads: HistoryThread[]
  selectedHistory: HistoryThread
  selectedHistoryId: string
  setSelectedHistoryId: (id: string) => void
}) {
  return (
    <div className="history-layout">
      <aside className="history-filters">
        <label className="search-box">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sessions, artifacts, branches"
          />
        </label>
        <div className="segmented stack">
          {(['Hybrid', 'Keyword', 'Semantic'] as HistoryMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={classNames(historyMode === mode && 'active')}
              onClick={() => setHistoryMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="index-status">
          <strong>Index</strong>
          <span>3 machines attached</span>
          <span>1,284 sessions</span>
          <span>last scan 12 min ago</span>
          <span>18 ignored paths</span>
        </div>
        <div className="filter-tags">
          {[
            'Podium',
            'Claude Code',
            'Codex CLI',
            'dirty workspace',
            'awaiting review',
            'pinned',
          ].map((tag) => (
            <button key={tag} type="button">
              {tag}
            </button>
          ))}
        </div>
      </aside>

      <section className="history-results" aria-label="History results">
        {threads.map((thread) => (
          <button
            key={thread.id}
            className={classNames('history-result', selectedHistoryId === thread.id && 'active')}
            type="button"
            onClick={() => setSelectedHistoryId(thread.id)}
          >
            <span className="work-card-top">
              <strong>{thread.title}</strong>
              <small>{thread.score}</small>
            </span>
            <span className="breadcrumb">
              {thread.project} / {thread.repo} / {thread.status}
            </span>
            <span>{thread.summary}</span>
            <small>{thread.why}</small>
          </button>
        ))}
      </section>

      <article className="history-detail">
        <div className="detail-heading">
          <div>
            <p className="eyebrow">
              {selectedHistory.project} / {selectedHistory.repo}
            </p>
            <h2>{selectedHistory.title}</h2>
            <p>{selectedHistory.summary}</p>
          </div>
          <span className="state-badge info">{selectedHistory.status}</span>
        </div>
        <div className="control-strip">
          <button type="button">
            <FileText size={16} /> Read transcript
          </button>
          <button type="button">
            <Play size={16} /> Resume
          </button>
          <button type="button">
            <Bot size={16} /> Continue in Codex
          </button>
          <button type="button">
            <Brain size={16} /> Use as context
          </button>
        </div>
        <div className="history-detail-grid">
          <section>
            <h3>Transcript preview</h3>
            {selectedHistory.transcript.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
          <section>
            <h3>Artifacts</h3>
            <ul className="artifact-list">
              {selectedHistory.artifacts.map((artifact) => (
                <li key={artifact}>{artifact}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Lineage</h3>
            {selectedHistory.lineage.map((item) => (
              <span className="lineage-item" key={item}>
                {item}
              </span>
            ))}
          </section>
          <section>
            <h3>Handoff bundle</h3>
            {selectedHistory.bundle.map((item) => (
              <label key={item}>
                <input type="checkbox" defaultChecked /> {item}
              </label>
            ))}
          </section>
        </div>
        <div className="similar-work">
          <h3>Similar past work</h3>
          {selectedHistory.related.map((item) => (
            <button key={item} type="button">
              <Sparkles size={15} /> {item}
            </button>
          ))}
        </div>
        <div className="privacy-strip">
          {selectedHistory.privacy.map((item) => (
            <span key={item}>
              <Shield size={14} /> {item}
            </span>
          ))}
        </div>
      </article>
    </div>
  )
}

function SettingsMode({
  activeSetting,
  setActiveSetting,
  selectedStream,
  selectedSession,
}: {
  activeSetting: SettingId
  setActiveSetting: (setting: SettingId) => void
  selectedStream: WorkItem
  selectedSession: Session
}) {
  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        {settingTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              className={classNames(activeSetting === tab.id && 'active')}
              type="button"
              onClick={() => setActiveSetting(tab.id)}
            >
              <Icon size={17} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </aside>
      <section className="settings-panel">
        {activeSetting === 'environment' && <EnvironmentSetup />}
        {activeSetting === 'skills' && <SkillsAccessSettings />}
        {activeSetting === 'notifications' && <NotificationRules selectedStream={selectedStream} />}
        {activeSetting === 'usage' && (
          <UsageLedger selectedStream={selectedStream} selectedSession={selectedSession} />
        )}
      </section>
    </div>
  )
}

function EnvironmentSetup() {
  return (
    <div className="settings-stack">
      <div className="section-toolbar">
        <div>
          <p className="eyebrow">Environment setup</p>
          <h2>Machine and worktree discovery</h2>
        </div>
        <button type="button">
          <RotateCcw size={16} /> Rescan
        </button>
      </div>

      <div className="stepper">
        {[
          'Connect machine',
          'Scan harnesses',
          'Review projects',
          'Confirm worktrees',
          'Start agent',
        ].map((step, index) => (
          <span key={step} className={index < 3 ? 'complete' : index === 3 ? 'active' : undefined}>
            {step}
          </span>
        ))}
      </div>

      <div className="table-list">
        {machineRows.map((machine) => (
          <button key={machine.name} type="button">
            <span>
              <strong>{machine.name}</strong>
              <small>
                {machine.daemon} / {machine.lastSeen}
              </small>
            </span>
            <span>{machine.harnesses}</span>
            <span>{machine.status}</span>
          </button>
        ))}
      </div>

      <div className="split-panels">
        <section>
          <h3>Project inference</h3>
          {[
            ['~/src/podium', '96%', 'from 18 recent conversations', 'active'],
            ['/srv/podium/worktrees', '81%', 'from Codex history paths', 'review'],
            ['~/scratch/mobile-fixtures', '54%', 'from device verifier logs', 'ignore'],
          ].map(([repo, confidence, source, action]) => (
            <div className="settings-row" key={repo}>
              <span>
                <strong>{repo}</strong>
                <small>{source}</small>
              </span>
              <span>{confidence}</span>
              <button type="button">{action}</button>
            </div>
          ))}
        </section>
        <section>
          <h3>Worktree rule</h3>
          <label className="field-row">
            <span>Suggested root</span>
            <input defaultValue="/srv/podium/worktrees" />
          </label>
          <label className="field-row">
            <span>Strategy</span>
            <select defaultValue="branch">
              <option value="branch">branch-per-goal</option>
              <option value="repo">repo clone</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <div className="control-strip">
            <button type="button">Adopt</button>
            <button type="button">Edit</button>
            <button type="button">Ignore</button>
            <button type="button">
              <Play size={16} /> Start first agent
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function SkillsAccessSettings() {
  return (
    <div className="settings-stack">
      <div className="section-toolbar">
        <div>
          <p className="eyebrow">Admin / Skills & MCP</p>
          <h2>Install once, grant per harness</h2>
        </div>
        <div className="tool-buttons">
          <button type="button">Install skill</button>
          <button type="button">Add MCP server</button>
          <button type="button">Import detected config</button>
        </div>
      </div>

      <div className="summary-strip">
        <StatusPill icon={Network} label="Installed" value="4" tone="ok" />
        <StatusPill icon={CheckCircle2} label="Grants" value="8" tone="info" />
        <StatusPill icon={LockKeyhole} label="Missing creds" value="1" tone="hot" />
        <StatusPill icon={Shield} label="Inherited env risk" value="1" tone="warn" />
      </div>

      <section>
        <h3>Installed inventory</h3>
        <div className="table-list">
          {installedTools.map((tool) => (
            <button key={tool.name} type="button">
              <span>
                <strong>{tool.name}</strong>
                <small>
                  {tool.type} / {tool.source}
                </small>
              </span>
              <span>{tool.version}</span>
              <span>{tool.credentials}</span>
              <span>{tool.status}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Harness access matrix</h3>
        <div className="access-matrix">
          <span>Tool</span>
          <span>Claude Code</span>
          <span>Codex CLI</span>
          <span>Future agent</span>
          {skillAccess.flatMap((row) =>
            row.map((cell, index) => (
              <span className={index === 0 ? 'matrix-label' : undefined} key={`${row[0]}-${cell}`}>
                {index === 0 ? (
                  cell
                ) : (
                  <label>
                    <input
                      type="checkbox"
                      defaultChecked={!cell.startsWith('Disabled') && !cell.startsWith('Blocked')}
                    />{' '}
                    {cell}
                  </label>
                )}
              </span>
            )),
          )}
        </div>
      </section>

      <div className="split-panels">
        <section>
          <h3>Credentials & env</h3>
          {[
            ['GITHUB_TOKEN', 'Podium vault', 'repo scoped', 'validated 6 min ago'],
            ['SENTRY_AUTH_TOKEN', 'missing', 'project scoped', 'blocked'],
            ['OPENAI_API_KEY', 'inherited shell env', 'global', 'lock recommended'],
          ].map(([name, source, scope, status]) => (
            <div className="settings-row" key={name}>
              <span>
                <strong>{name}</strong>
                <small>{source}</small>
              </span>
              <span>{scope}</span>
              <button type="button">{status}</button>
            </div>
          ))}
        </section>
        <section>
          <h3>Credential boundary</h3>
          <ol className="boundary-list">
            <li>Browser sees metadata only</li>
            <li>Podium vault stores encrypted secret</li>
            <li>Daemon injects masked env into native CLI</li>
            <li>Harness receives scoped env</li>
            <li>Logs redact secret values</li>
          </ol>
          <code>GITHUB_TOKEN=podium:vault/github-prod****</code>
        </section>
      </div>
    </div>
  )
}

function NotificationRules({ selectedStream }: { selectedStream: WorkItem }) {
  return (
    <div className="settings-stack">
      <div className="section-toolbar">
        <div>
          <p className="eyebrow">Attention routing</p>
          <h2>Notification rules</h2>
        </div>
        <button type="button">
          <Bell size={16} /> Send test event
        </button>
      </div>

      <div className="routing-controls">
        <label>
          Desktop-active suppression
          <select defaultValue="8">
            <option value="5">5 min</option>
            <option value="8">8 min</option>
            <option value="10">10 min</option>
          </select>
        </label>
        <label>
          Quiet hours
          <input defaultValue="22:00-08:00" />
        </label>
        <label>
          Watched stream
          <input defaultValue={selectedStream.title} />
        </label>
      </div>

      <div className="rules-table">
        <span>Event type</span>
        <span>Source</span>
        <span>Stream</span>
        <span>Severity</span>
        <span>Desktop</span>
        <span>Mobile</span>
        <span>Suppression</span>
        <span>Quiet</span>
        <span>Escalation</span>
        {notificationEvents.flatMap((event) =>
          [
            event.type,
            event.source,
            event.stream,
            event.severity,
            event.desktop,
            event.mobile,
            event.suppression,
            event.quiet,
            event.escalation,
          ].map((value) => <span key={`${event.type}-${value}`}>{value}</span>),
        )}
      </div>

      <div className="delivery-preview">
        <h3>Delivery preview</h3>
        <p>
          Claude Code - relay implementation is delivered to desktop now. Mobile is suppressed
          because desktop was active 2 minutes ago and escalates in 8 minutes if unopened.
        </p>
        <div className="control-strip compact">
          <button type="button">Open stream</button>
          <button type="button">Jump terminal</button>
          <button type="button">Escalate now</button>
          <button type="button">Mute stream</button>
        </div>
      </div>
    </div>
  )
}

function UsageLedger({
  selectedStream,
  selectedSession,
}: {
  selectedStream: WorkItem
  selectedSession: Session
}) {
  return (
    <div className="settings-stack">
      <div className="section-toolbar">
        <div>
          <p className="eyebrow">Usage / {selectedStream.title}</p>
          <h2>Subscription and cost ledger</h2>
        </div>
        <div className="segmented">
          <button type="button" className="active">
            Stream
          </button>
          <button type="button">Project</button>
          <button type="button">All</button>
        </div>
      </div>

      <div className="metric-row">
        <Metric label="Claude plan" value="73% used / resets Jun 4" progress={73} />
        <Metric label="Codex credits" value="$18.40 left / 12 days" progress={48} />
        <Metric label="Non-sub projection" value="$9.54 this week" progress={38} />
      </div>

      <div className="usage-chart" role="img" aria-label="Usage over time">
        {[28, 44, 36, 68, 52, 73, 31].map((height, index) => (
          <span
            key={String(index)}
            style={{ '--bar': `${height}%` } as CSSProperties}
            title={`${height}%`}
          />
        ))}
      </div>

      <section>
        <h3>Work cost table</h3>
        <div className="table-list">
          {usageRows.map(([stream, behavior, agent, usage, projected, alert]) => (
            <button key={`${stream}-${behavior}`} type="button">
              <span>
                <strong>{stream}</strong>
                <small>{behavior}</small>
              </span>
              <span>{agent}</span>
              <span>{usage}</span>
              <span>{projected}</span>
              <span>{alert}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="split-panels">
        <section>
          <h3>Projection controls</h3>
          <label className="field-row">
            <span>Billing window</span>
            <select defaultValue="week">
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
          </label>
          <label className="field-row">
            <span>Alternative model</span>
            <select defaultValue="codex">
              <option value="codex">Codex CLI</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            <input type="checkbox" defaultChecked /> Include idle time
          </label>
        </section>
        <section>
          <h3>Selected session</h3>
          <p>{selectedSession.title}</p>
          <p>{selectedSession.usage}</p>
          <div className="control-strip compact">
            <button type="button">Stop idle</button>
            <button type="button">Switch agent</button>
            <button type="button">Set cap</button>
          </div>
        </section>
      </div>
    </div>
  )
}

function SuperagentDock({
  selectedStream,
  selectedSession,
  sessions,
  attentionEvents,
  onClose,
}: {
  selectedStream: WorkItem
  selectedSession: Session
  sessions: Session[]
  attentionEvents: AttentionEvent[]
  onClose: () => void
}) {
  return (
    <aside className="assistant-dock" aria-label="Superagent dock">
      <header className="dock-header">
        <span>
          <Bot size={18} /> Superagent
        </span>
        <button type="button" onClick={onClose} title="Close Superagent dock">
          <PanelRightClose size={17} />
        </button>
      </header>

      <section className="dock-section">
        <p className="eyebrow">Current context</p>
        <div className="scope-path">
          <span>All projects</span>
          <ChevronRight size={14} />
          <span>{selectedStream.repo}</span>
          <ChevronRight size={14} />
          <span>{selectedStream.title}</span>
          <ChevronRight size={14} />
          <span>apps/web/src</span>
        </div>
        <label className="field-row">
          <span>Launch scope</span>
          <select defaultValue="stream">
            <option value="global">All projects</option>
            <option value="repo">{selectedStream.repo}</option>
            <option value="stream">{selectedStream.title}</option>
            <option value="directory">apps/web/src</option>
          </select>
        </label>
      </section>

      <section className="dock-section">
        <div className="section-toolbar compact">
          <h3>Agent control</h3>
          <button type="button">
            <Play size={15} /> Launch
          </button>
        </div>
        {sessions.slice(0, 4).map((session) => (
          <div className="dock-agent" key={session.id}>
            <span>
              <strong>{session.title}</strong>
              <small>
                {session.status} / {session.memory}% / {session.machine}
              </small>
            </span>
            <div className="row-actions">
              <button type="button">Stop</button>
              <button type="button">Resume</button>
              <button type="button">Fork</button>
            </div>
          </div>
        ))}
      </section>

      <ContextComposer selectedStream={selectedStream} selectedSession={selectedSession} compact />

      <section className="dock-section">
        <h3>Chores</h3>
        {['Worktree setup', 'Server debugging', 'Stale process cleanup', 'Check triage'].map(
          (chore) => (
            <button className="dock-action" key={chore} type="button">
              <Wrench size={15} /> {chore}
            </button>
          ),
        )}
      </section>

      <section className="dock-section">
        <h3>Recent events</h3>
        {attentionEvents.slice(0, 3).map((event) => (
          <p key={event.id}>
            <strong>{event.severity}:</strong> {event.stream}
          </p>
        ))}
      </section>

      <label className="btw-input">
        <span>/btw</span>
        <input defaultValue="Ask what needs my attention next" />
      </label>
    </aside>
  )
}

function Metric({ label, value, progress }: { label: string; value: string; progress: number }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <div className="meter">
        <i style={{ width: clampProgress(progress) }} />
      </div>
    </div>
  )
}
