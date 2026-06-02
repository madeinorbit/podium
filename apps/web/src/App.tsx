import {
  Activity,
  Archive,
  Bell,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Code2,
  Command,
  Compass,
  Cpu,
  Diff,
  FileText,
  Gauge,
  GitBranch,
  History,
  KeyRound,
  LayoutGrid,
  ListChecks,
  Monitor,
  MoreHorizontal,
  Network,
  PanelLeft,
  Pause,
  Play,
  RotateCcw,
  Search,
  Shield,
  Smartphone,
  Snowflake,
  Sparkles,
  SquareTerminal,
  Tags,
  TimerReset,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { ComponentType, CSSProperties } from 'react'
import { useMemo, useState } from 'react'

type Icon = ComponentType<{ className?: string; size?: number; strokeWidth?: number }>

type SectionId =
  | 'command'
  | 'onboarding'
  | 'superagent'
  | 'history'
  | 'tracker'
  | 'context'
  | 'skills'
  | 'notifications'
  | 'analytics'
  | 'ide'

type CommandVariant = 'streams' | 'grid' | 'spec' | 'radar'

type StreamState = 'Needs attention' | 'Running' | 'Paused' | 'Review' | 'Icebox'

type Stream = {
  id: string
  title: string
  project: string
  repo: string
  stage: string
  state: StreamState
  summary: string
  next: string
  attention: string
  progress: number
  memory: number
  agents: string[]
  touched: string[]
  updated: string
}

type Session = {
  id: string
  title: string
  streamId: string
  harness: 'Claude Code' | 'Codex CLI'
  machine: string
  role: 'controller' | 'spectator'
  status: 'Running' | 'Waiting' | 'Idle' | 'Stopped'
  geometry: string
  epoch: number
  screenHash: string
  memory: number
  output: string[]
}

type Section = {
  id: SectionId
  label: string
  icon: Icon
}

const sections: Section[] = [
  { id: 'command', label: 'Command', icon: Command },
  { id: 'onboarding', label: 'Onboarding', icon: Compass },
  { id: 'superagent', label: 'Superagent', icon: Bot },
  { id: 'history', label: 'History', icon: History },
  { id: 'tracker', label: 'Tracker', icon: ListChecks },
  { id: 'context', label: 'Context', icon: Brain },
  { id: 'skills', label: 'Skills', icon: Network },
  { id: 'notifications', label: 'Notify', icon: Bell },
  { id: 'analytics', label: 'Usage', icon: Gauge },
  { id: 'ide', label: 'IDE/Git', icon: Code2 },
]

const mobilePrimarySectionIds: SectionId[] = ['command', 'onboarding', 'superagent', 'history']

const mobilePrimarySections = sections.filter((section) =>
  mobilePrimarySectionIds.includes(section.id),
)
const mobileMoreSections = sections.filter(
  (section) => !mobilePrimarySectionIds.includes(section.id),
)

const commandVariants: Array<{ id: CommandVariant; label: string; icon: Icon }> = [
  { id: 'streams', label: 'Streams board', icon: LayoutGrid },
  { id: 'grid', label: 'Terminal grid', icon: SquareTerminal },
  { id: 'spec', label: 'Spec studio', icon: FileText },
  { id: 'radar', label: 'Attention radar', icon: Activity },
]

const initialStreams: Stream[] = [
  {
    id: 'relay-ui',
    title: 'Relay handover UI',
    project: 'Podium',
    repo: 'podium/prototype',
    stage: 'Implementation',
    state: 'Needs attention',
    summary:
      'Terminal handover is wired through the relay. The UI needs a control model for desktop and phone takeover.',
    next: 'Review mobile toolbar and confirm controller geometry behavior.',
    attention: 'Human decision: should spectators see scaled controller output or their own grid?',
    progress: 68,
    memory: 74,
    agents: ['Claude Code desktop', 'Codex mobile audit'],
    touched: ['apps/server/src/relay.ts', 'packages/protocol/src/messages.ts'],
    updated: '4 min ago',
  },
  {
    id: 'conversation-index',
    title: 'Conversation index',
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
    updated: '12 min ago',
  },
  {
    id: 'mobile-input',
    title: 'Mobile input toolbar',
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
    touched: ['packages/terminal-client/src/input.ts'],
    updated: '28 min ago',
  },
  {
    id: 'skill-mcp',
    title: 'Skill and MCP manager',
    project: 'Podium',
    repo: 'podium/product',
    stage: 'Spec',
    state: 'Review',
    summary:
      'Install once, grant per harness, and inject credentials without leaking secrets into browser logs.',
    next: 'Approve credential boundary before implementation agents start.',
    attention: 'Review requested: credential scoping needs a product call.',
    progress: 31,
    memory: 46,
    agents: ['Spec researcher'],
    touched: ['docs/skills-mcp-boundary.md'],
    updated: '1 hr ago',
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
    output: [
      'adb forward ready',
      'waiting for phone unlock',
      'idle for 22m - resume keeps context',
    ],
  },
]

const historyRows = [
  ['RelayHub takeover gating', 'Podium / relay-ui', 'Claude Code', 'awaiting review', '9 files'],
  ['Codex scanner fixture path bug', 'Podium / history', 'Codex CLI', 'completed', '3 files'],
  [
    'Mobile keyboard viewport research',
    'Podium / mobile-input',
    'Claude Code',
    'pinned',
    '5 notes',
  ],
  ['Skill credential boundary', 'Podium / skill-mcp', 'Claude Code', 'needs decision', '2 specs'],
]

const trackerStages = [
  ['Spec', 'Skill and MCP manager', 'Notification routing'],
  ['Planning', 'Conversation index', 'Cloud sandbox launch'],
  ['Implementation', 'Relay handover UI', 'Command Center prototype'],
  ['Review', 'Credential boundary', 'Usage analytics model'],
]

const contextSources = [
  ['Distilled start', 'Feature brief, branch state, prior decisions, acceptance checks'],
  ['Fork full context', 'Open a child agent with complete terminal history and repo state'],
  ['Merge back', 'Pull summaries, patches, failed checks, and decisions into parent stream'],
]

function classNames(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(' ')
}

function clampProgress(value: number) {
  return `${Math.max(0, Math.min(100, value))}%`
}

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('command')
  const [variant, setVariant] = useState<CommandVariant>('streams')
  const [streams, setStreams] = useState<Stream[]>(initialStreams)
  const [selectedStreamId, setSelectedStreamId] = useState(initialStreams[0]?.id ?? '')
  const [selectedSessionId, setSelectedSessionId] = useState(sessions[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [superagentOpen, setSuperagentOpen] = useState(true)
  const [mobilePreview, setMobilePreview] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const selectedStream = streams.find((stream) => stream.id === selectedStreamId) ?? streams[0]
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0]

  const attentionCount = streams.filter((stream) => stream.state === 'Needs attention').length
  const runningCount = sessions.filter((session) => session.status === 'Running').length
  const highMemoryCount = sessions.filter((session) => session.memory > 80).length

  const filteredHistory = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    if (!normalized) {
      return historyRows
    }
    return historyRows.filter((row) => row.join(' ').toLowerCase().includes(normalized))
  }, [search])

  function updateStreamState(id: string, state: StreamState) {
    setStreams((current) =>
      current.map((stream) => (stream.id === id ? { ...stream, state } : stream)),
    )
  }

  function selectSection(sectionId: SectionId) {
    setActiveSection(sectionId)
    setMobileMenuOpen(false)
  }

  if (!selectedStream || !selectedSession) {
    return <div className="empty-state">No prototype data is available.</div>
  }

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="Primary">
        <div className="brand-lockup">
          <div className="brand-mark">P</div>
          <div>
            <strong>Podium</strong>
            <span>Relay workbench</span>
          </div>
        </div>

        <nav className="rail-nav">
          {sections.map((section) => {
            const Icon = section.icon
            return (
              <button
                key={section.id}
                className={classNames('nav-button', activeSection === section.id && 'active')}
                type="button"
                onClick={() => selectSection(section.id)}
                aria-pressed={activeSection === section.id}
                title={section.label}
              >
                <Icon size={18} />
                <span>{section.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="workspace">
        <TopBar
          attentionCount={attentionCount}
          runningCount={runningCount}
          highMemoryCount={highMemoryCount}
          mobilePreview={mobilePreview}
          setMobilePreview={setMobilePreview}
        />

        <div className={classNames('workspace-grid', mobilePreview && 'mobile-preview')}>
          <section className="main-stage">
            {activeSection === 'command' && (
              <CommandCenter
                variant={variant}
                setVariant={setVariant}
                streams={streams}
                selectedStream={selectedStream}
                selectedSession={selectedSession}
                selectedSessionId={selectedSessionId}
                setSelectedSessionId={setSelectedSessionId}
                setSelectedStreamId={setSelectedStreamId}
                updateStreamState={updateStreamState}
              />
            )}
            {activeSection === 'onboarding' && <Onboarding />}
            {activeSection === 'superagent' && <SuperagentPanel selectedStream={selectedStream} />}
            {activeSection === 'history' && (
              <HistoryPanel search={search} setSearch={setSearch} rows={filteredHistory} />
            )}
            {activeSection === 'tracker' && <TrackerPanel />}
            {activeSection === 'context' && <ContextPanel selectedStream={selectedStream} />}
            {activeSection === 'skills' && <SkillsPanel />}
            {activeSection === 'notifications' && <NotificationsPanel />}
            {activeSection === 'analytics' && <AnalyticsPanel />}
            {activeSection === 'ide' && <IdePanel selectedStream={selectedStream} />}
          </section>

          {superagentOpen && (
            <aside className="assistant-dock" aria-label="Superagent dock">
              <DockHeader onClose={() => setSuperagentOpen(false)} />
              <div className="assistant-feed">
                <p>
                  <strong>Context:</strong> {selectedStream.project} / {selectedStream.title}
                </p>
                <p>{selectedStream.attention}</p>
                <div className="quick-actions">
                  <button type="button">
                    <Play size={15} /> Start scoped agent
                  </button>
                  <button type="button">
                    <Wrench size={15} /> Debug server
                  </button>
                  <button type="button">
                    <Sparkles size={15} /> Draft next step
                  </button>
                </div>
              </div>
              <label className="btw-input">
                <span>/btw</span>
                <input defaultValue="Ask what needs my attention next" />
              </label>
            </aside>
          )}

          {!superagentOpen && (
            <button className="open-dock" type="button" onClick={() => setSuperagentOpen(true)}>
              <Bot size={18} />
              Open Superagent
            </button>
          )}
        </div>
      </main>

      {mobileMenuOpen && (
        <section className="mobile-more-panel" aria-label="More mobile sections">
          {mobileMoreSections.map((section) => {
            const Icon = section.icon
            return (
              <button
                key={section.id}
                className={classNames(activeSection === section.id && 'active')}
                type="button"
                onClick={() => selectSection(section.id)}
              >
                <Icon size={18} />
                <span>{section.label}</span>
              </button>
            )
          })}
        </section>
      )}

      <nav className="mobile-tabbar" aria-label="Mobile primary">
        {mobilePrimarySections.map((section) => {
          const Icon = section.icon
          return (
            <button
              key={section.id}
              className={classNames(activeSection === section.id && 'active')}
              type="button"
              onClick={() => selectSection(section.id)}
              title={section.label}
            >
              <Icon size={18} />
              <span>{section.label}</span>
            </button>
          )
        })}
        <button
          className={classNames(
            mobileMenuOpen && 'active',
            mobileMoreSections.some((section) => section.id === activeSection) && 'active',
          )}
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
  attentionCount,
  runningCount,
  highMemoryCount,
  mobilePreview,
  setMobilePreview,
}: {
  attentionCount: number
  runningCount: number
  highMemoryCount: number
  mobilePreview: boolean
  setMobilePreview: (value: boolean) => void
}) {
  return (
    <header className="top-bar">
      <div>
        <p className="eyebrow">Workshop Signal design language</p>
        <h1>Command Center</h1>
      </div>
      <div className="status-strip">
        <StatusPill icon={UserRound} label="Attention" value={String(attentionCount)} tone="hot" />
        <StatusPill icon={Activity} label="Running" value={String(runningCount)} tone="ok" />
        <StatusPill icon={Cpu} label="Memory" value={String(highMemoryCount)} tone="warn" />
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

function CommandCenter({
  variant,
  setVariant,
  streams,
  selectedStream,
  selectedSession,
  selectedSessionId,
  setSelectedSessionId,
  setSelectedStreamId,
  updateStreamState,
}: {
  variant: CommandVariant
  setVariant: (variant: CommandVariant) => void
  streams: Stream[]
  selectedStream: Stream
  selectedSession: Session
  selectedSessionId: string
  setSelectedSessionId: (id: string) => void
  setSelectedStreamId: (id: string) => void
  updateStreamState: (id: string, state: StreamState) => void
}) {
  return (
    <div className="command-center">
      <div className="mode-switcher" role="tablist" aria-label="Command Center prototypes">
        {commandVariants.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              className={classNames(variant === item.id && 'active')}
              type="button"
              role="tab"
              aria-selected={variant === item.id}
              onClick={() => setVariant(item.id)}
            >
              <Icon size={16} />
              {item.label}
            </button>
          )
        })}
      </div>

      {variant === 'streams' && (
        <StreamsBoard
          streams={streams}
          selectedStream={selectedStream}
          setSelectedStreamId={setSelectedStreamId}
          updateStreamState={updateStreamState}
        />
      )}
      {variant === 'grid' && (
        <TerminalGrid
          selectedSessionId={selectedSessionId}
          setSelectedSessionId={setSelectedSessionId}
          selectedSession={selectedSession}
        />
      )}
      {variant === 'spec' && <SpecStudio selectedStream={selectedStream} />}
      {variant === 'radar' && <AttentionRadar streams={streams} />}
    </div>
  )
}

function StreamsBoard({
  streams,
  selectedStream,
  setSelectedStreamId,
  updateStreamState,
}: {
  streams: Stream[]
  selectedStream: Stream
  setSelectedStreamId: (id: string) => void
  updateStreamState: (id: string, state: StreamState) => void
}) {
  return (
    <div className="streams-layout">
      <div className="stream-list">
        {streams.map((stream) => (
          <button
            key={stream.id}
            className={classNames('stream-row', selectedStream.id === stream.id && 'active')}
            type="button"
            onClick={() => setSelectedStreamId(stream.id)}
          >
            <span
              className={classNames('state-dot', stream.state.toLowerCase().replace(' ', '-'))}
            />
            <span>
              <strong>{stream.title}</strong>
              <small>
                {stream.project} / {stream.stage}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>

      <article className="stream-detail">
        <div className="detail-heading">
          <div>
            <p className="eyebrow">Product mode</p>
            <h2>{selectedStream.title}</h2>
            <p>{selectedStream.summary}</p>
          </div>
          <span className="state-badge">{selectedStream.state}</span>
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
            label="Memory pressure"
            value={`${selectedStream.memory}%`}
            progress={selectedStream.memory}
          />
          <Metric
            label="Active agents"
            value={String(selectedStream.agents.length)}
            progress={66}
          />
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
          <button type="button" onClick={() => updateStreamState(selectedStream.id, 'Review')}>
            <Archive size={16} /> Archive
          </button>
        </div>

        <div className="split-panels">
          <section className="plain-panel">
            <h3>Next step</h3>
            <p>{selectedStream.next}</p>
            <div className="agent-stack">
              {selectedStream.agents.map((agent) => (
                <span key={agent}>{agent}</span>
              ))}
            </div>
          </section>
          <section className="plain-panel">
            <h3>Files and artifacts</h3>
            <ul className="artifact-list">
              {selectedStream.touched.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>
      </article>
    </div>
  )
}

function TerminalGrid({
  selectedSessionId,
  setSelectedSessionId,
  selectedSession,
}: {
  selectedSessionId: string
  setSelectedSessionId: (id: string) => void
  selectedSession: Session
}) {
  return (
    <div className="terminal-layout">
      <div className="terminal-toolbar">
        <div>
          <p className="eyebrow">Dev mode</p>
          <h2>Configurable terminal grid</h2>
        </div>
        <div className="tool-buttons">
          <button type="button" title="Open browser preview">
            <Monitor size={16} /> Browser
          </button>
          <button type="button" title="Open code viewer">
            <Code2 size={16} /> Code
          </button>
          <button type="button" title="Open diffs">
            <Diff size={16} /> Diffs
          </button>
        </div>
      </div>

      <div className="terminal-grid">
        {sessions.map((session) => (
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
            <pre>{session.output.join('\n')}</pre>
          </button>
        ))}
      </div>

      <section className="session-control plain-panel">
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
            <RotateCcw size={16} /> Redraw
          </button>
          <button type="button">
            <TimerReset size={16} /> Stop idle
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
    </div>
  )
}

function SpecStudio({ selectedStream }: { selectedStream: Stream }) {
  return (
    <div className="spec-layout">
      <aside className="doc-outline">
        {['Goal', 'Decisions', 'Protocol', 'Handover', 'Acceptance'].map((item, index) => (
          <button key={item} className={index === 3 ? 'active' : undefined} type="button">
            {item}
          </button>
        ))}
      </aside>
      <article className="spec-document">
        <p className="eyebrow">Spec mode</p>
        <h2>Handover and input prototype</h2>
        <p>
          The active doc is anchored to {selectedStream.title}. The spec agent follows the visible
          section and keeps research, open questions, and decisions beside the doc.
        </p>
        <div className="spec-callout">
          <FileText size={18} />
          Controller geometry is authoritative. Spectators render the controller grid scaled so
          screenHash stays comparable after takeover.
        </div>
        <div className="decision-stack">
          <label>
            <input type="checkbox" defaultChecked /> Mobile takeover redraw policy approved
          </label>
          <label>
            <input type="checkbox" /> Decide transcript vs raw PTY replay boundaries
          </label>
          <label>
            <input type="checkbox" /> Ask product question before implementation agents resume
          </label>
        </div>
      </article>
      <aside className="research-panel">
        <h3>Agent research</h3>
        <p>Comparable products use a controller/spectator model when terminal geometry matters.</p>
        <button type="button">
          <Sparkles size={16} /> Research decision
        </button>
      </aside>
    </div>
  )
}

function AttentionRadar({ streams }: { streams: Stream[] }) {
  return (
    <div className="radar-layout">
      <section className="radar-map" aria-label="Attention radar prototype">
        {streams.map((stream, index) => (
          <button
            key={stream.id}
            className={classNames('radar-node', stream.state.toLowerCase().replace(' ', '-'))}
            style={
              { '--x': `${18 + index * 20}%`, '--y': `${22 + (index % 2) * 34}%` } as CSSProperties
            }
            type="button"
          >
            <span>{stream.title}</span>
          </button>
        ))}
      </section>
      <section className="plain-panel radar-queue">
        <h2>Attention queue</h2>
        {streams.map((stream) => (
          <div className="queue-row" key={stream.id}>
            <span>{stream.state}</span>
            <strong>{stream.title}</strong>
            <small>{stream.updated}</small>
          </div>
        ))}
      </section>
    </div>
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

function Onboarding() {
  const machines = [
    ['macbook-pro.local', 'Claude Code, Codex CLI', 'Recent repo: podium/prototype'],
    ['linux-vps', 'Codex CLI', 'Suggested worktree: /srv/podium/worktrees'],
    ['pixel-8-usb', 'Chrome remote debug', 'Mobile acceptance device'],
  ]
  return (
    <FeatureSurface
      icon={Compass}
      title="Onboarding and discovery"
      eyebrow="Machine setup"
      summary="Installed harnesses, recent conversations, projects, repos, and worktree flows are surfaced before a new agent starts."
    >
      <div className="feature-grid three">
        {machines.map(([name, harnesses, hint]) => (
          <article className="feature-card" key={name}>
            <Monitor size={18} />
            <h3>{name}</h3>
            <p>{harnesses}</p>
            <small>{hint}</small>
            <button type="button">Adopt suggestion</button>
          </article>
        ))}
      </div>
    </FeatureSurface>
  )
}

function SuperagentPanel({ selectedStream }: { selectedStream: Stream }) {
  return (
    <FeatureSurface
      icon={Bot}
      title="Always-there Superagent"
      eyebrow="Orchestrator"
      summary="A persistent agent can start, stop, monitor, and brief scoped agents from project-wide context down to a directory."
    >
      <div className="feature-grid two">
        <article className="feature-card wide">
          <h3>Launch context</h3>
          <div className="launch-scopes">
            {['All projects', selectedStream.repo, selectedStream.title, 'apps/web/src'].map(
              (scope) => (
                <button key={scope} type="button">
                  <Sparkles size={15} /> {scope}
                </button>
              ),
            )}
          </div>
        </article>
        <article className="feature-card">
          <h3>Chores</h3>
          <p>Worktree setup, server debugging, stale process cleanup, and check triage.</p>
          <button type="button">Assign chore</button>
        </article>
      </div>
    </FeatureSurface>
  )
}

function HistoryPanel({
  search,
  setSearch,
  rows,
}: {
  search: string
  setSearch: (value: string) => void
  rows: string[][]
}) {
  return (
    <FeatureSurface
      icon={History}
      title="Conversation history"
      eyebrow="Hybrid search"
      summary="Indexed sessions across Codex, Claude Code, and future harnesses become searchable work threads with summaries, artifacts, status, pins, and handoffs."
    >
      <label className="search-box">
        <Search size={17} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sessions, artifacts, branches"
        />
      </label>
      <div className="table-list">
        {rows.map(([title, project, harness, status, artifact]) => (
          <button key={title} type="button">
            <span>
              <strong>{title}</strong>
              <small>{project}</small>
            </span>
            <span>{harness}</span>
            <span>{status}</span>
            <span>{artifact}</span>
          </button>
        ))}
      </div>
      <div className="feature-grid two compact-grid">
        <article className="feature-card">
          <Tags size={18} />
          <h3>Parent/child graph</h3>
          <p>Forks, resumed sessions, and spawned subagents stay connected.</p>
        </article>
        <article className="feature-card">
          <Shield size={18} />
          <h3>Privacy controls</h3>
          <p>Ignored paths, redaction, local-only indexing, and do-not-summarize flags.</p>
        </article>
      </div>
    </FeatureSurface>
  )
}

function TrackerPanel() {
  return (
    <FeatureSurface
      icon={ListChecks}
      title="Project tracker"
      eyebrow="Lightweight stages"
      summary="Streams can be grouped by project, epic, feature, or work intent without forcing a heavy scrum vocabulary."
    >
      <div className="stage-board">
        {trackerStages.map(([stage, ...items]) => (
          <section key={stage}>
            <h3>{stage}</h3>
            {items.map((item) => (
              <button key={item} type="button">
                {item}
              </button>
            ))}
          </section>
        ))}
      </div>
    </FeatureSurface>
  )
}

function ContextPanel({ selectedStream }: { selectedStream: Stream }) {
  return (
    <FeatureSurface
      icon={Brain}
      title="Context management"
      eyebrow="Start, fork, merge"
      summary="Starting context is distilled automatically, full context can be forked, and results can merge back into the parent stream."
    >
      <div className="feature-grid three">
        {contextSources.map(([title, body]) => (
          <article className="feature-card" key={title}>
            <Brain size={18} />
            <h3>{title}</h3>
            <p>{body}</p>
            <small>{selectedStream.title}</small>
          </article>
        ))}
      </div>
    </FeatureSurface>
  )
}

function SkillsPanel() {
  const tools = [
    ['Claude Code', 'Superpowers, GitHub, Sentry', 'env: scoped'],
    ['Codex CLI', 'OpenAI docs, Cloudflare, GitHub', 'env: inherited'],
    ['Future agent', 'No tools granted', 'env: locked'],
  ]
  return (
    <FeatureSurface
      icon={Network}
      title="Skill and MCP management"
      eyebrow="Cross harness"
      summary="Install once, enable per harness, and keep credentials scoped through explicit grants."
    >
      <div className="table-list matrix">
        {tools.map(([agent, enabled, credential]) => (
          <button key={agent} type="button">
            <span>
              <strong>{agent}</strong>
              <small>{enabled}</small>
            </span>
            <span>{credential}</span>
            <span className="toggle-on">Enabled</span>
          </button>
        ))}
      </div>
    </FeatureSurface>
  )
}

function NotificationsPanel() {
  return (
    <FeatureSurface
      icon={Bell}
      title="Notifications"
      eyebrow="Smart routing"
      summary="Desktop, mobile, and quiet-hour routing avoid duplicate pings when the user is already active on one surface."
    >
      <div className="feature-grid three">
        {['Desktop active', 'Mobile fallback', 'Auto-mode guard'].map((item) => (
          <article className="feature-card" key={item}>
            <Bell size={18} />
            <h3>{item}</h3>
            <label className="switch-row">
              <input type="checkbox" defaultChecked /> Route enabled
            </label>
          </article>
        ))}
      </div>
    </FeatureSurface>
  )
}

function AnalyticsPanel() {
  return (
    <FeatureSurface
      icon={Gauge}
      title="Analytics and usage"
      eyebrow="Subscriptions and cost"
      summary="Subscription limits, projected cost, behavior-level spend, and model comparison sit beside the work they explain."
    >
      <div className="metric-row analytics-row">
        <Metric label="Claude subscription" value="73%" progress={73} />
        <Metric label="Codex credits" value="$18.40" progress={48} />
        <Metric label="Projected alt model" value="-22%" progress={38} />
      </div>
      <div className="table-list">
        {['Long-running bugfix agents', 'Spec research', 'Playwright verification'].map((item) => (
          <button key={item} type="button">
            <span>{item}</span>
            <span>Cost trend</span>
            <span>Compare models</span>
          </button>
        ))}
      </div>
    </FeatureSurface>
  )
}

function IdePanel({ selectedStream }: { selectedStream: Stream }) {
  return (
    <FeatureSurface
      icon={Code2}
      title="Minimal IDE and Git"
      eyebrow="Manual control"
      summary="The rare file edit, env check, diff review, branch status, and commit handoff stay close to the agent terminal."
    >
      <div className="ide-layout">
        <section className="code-pane">
          <h3>{selectedStream.touched[0] ?? 'apps/web/src/App.tsx'}</h3>
          <pre>{`export function requestControl(clientId) {
  resizeToLastViewport(clientId)
  redrawAgent()
  bumpEpoch()
}`}</pre>
        </section>
        <section className="git-pane">
          <h3>
            <GitBranch size={17} /> Git state
          </h3>
          <p>branch prototype/ui based on prototype/phase2-relay</p>
          <button type="button">
            <Diff size={16} /> Review diff
          </button>
          <button type="button">
            <CheckCircle2 size={16} /> Prepare handoff
          </button>
        </section>
      </div>
    </FeatureSurface>
  )
}

function FeatureSurface({
  icon: Icon,
  title,
  eyebrow,
  summary,
  children,
}: {
  icon: Icon
  title: string
  eyebrow: string
  summary: string
  children: React.ReactNode
}) {
  return (
    <div className="feature-surface">
      <header className="feature-heading">
        <div className="feature-icon">
          <Icon size={20} />
        </div>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>
      </header>
      {children}
    </div>
  )
}

function DockHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="dock-header">
      <span>
        <Bot size={18} /> Superagent
      </span>
      <button type="button" onClick={onClose} title="Close Superagent dock">
        <PanelLeft size={17} />
      </button>
    </header>
  )
}
