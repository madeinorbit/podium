import type { SettingsPage } from '@podium/client-core/ui-state'
import { FEATURES } from '@podium/protocol'
import {
  Bell,
  Bot,
  FlaskConical,
  Folder,
  Globe,
  History,
  KeyRound,
  type LucideIcon,
  Palette,
  RefreshCw,
  Server,
  Shield,
  UserRound,
  Users,
} from 'lucide-react'

export type SettingsGroup = 'personal' | 'workspace'

export interface SettingsSearchRow {
  label: string
  help: string
  keywords: string
  section: string
  /** Existing Row label; omit for a section-level action or table. */
  rowLabel?: string
}

export interface SettingsPageDefinition {
  key: SettingsPage
  label: string
  group: SettingsGroup
  adminOnly?: boolean
  icon: LucideIcon
  description: string
  keywords: string
  rows: readonly SettingsSearchRow[]
}

const row = (
  section: string,
  label: string,
  help = '',
  keywords = '',
  rowLabel: string | undefined = label,
): SettingsSearchRow => ({ section, label, help, keywords, rowLabel })
const section = (id: string, label: string, help: string, keywords = ''): SettingsSearchRow => ({
  section: id,
  label,
  help,
  keywords,
})

/** Page copy and the search catalog live together. Page tasks can replace their
 * content independently while keeping these destinations and row targets. */
export const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  {
    key: 'agents',
    label: 'Agents',
    group: 'personal',
    icon: Bot,
    description:
      'What new sessions start with. Any task, session or message can still pick something else — Auto there means “use this”.',
    keywords: 'new sessions defaults coding model effort harness account superagent background llm',
    rows: [
      section(
        'sessions',
        'New sessions',
        'The default for coding agents you start from the sidebar, a task, or the phone.',
      ),
      row(
        'sessions',
        'Agent',
        'Which CLI runs, and which login or key it uses.',
        'harness account login api key subscription billing shared',
      ),
      row(
        'sessions',
        'Model',
        'Auto shows the model it resolves to. Compatible choices survive agent changes.',
        'llm opus sonnet gpt availability not offered machines',
      ),
      row('sessions', 'Effort', 'How long the model thinks before acting.', 'reasoning thinking'),
      row(
        'sessions',
        'Subagent model',
        'Model for the helpers the agent starts on its own.',
        'helpers subagent task tool',
      ),
      section(
        'session-behaviour',
        'Session behaviour',
        'How new sessions open, look and recover from errors.',
      ),
      row(
        'session-behaviour',
        'Open new sessions in',
        'Auto shows chat on a phone and the terminal on a computer.',
        'start screen native terminal chat auto phone default',
      ),
      row(
        'session-behaviour',
        'Match agent colours to Podium',
        'Starts each CLI in a theme that fits the current Podium theme. Your own agent config is never changed.',
        'seed cli theme colors appearance',
      ),
      row(
        'session-behaviour',
        'Keep going after errors',
        'Retry after rate limits and server errors, with a growing pause.',
        'auto continue autocontinue retry rate limit tokens',
      ),
      section(
        'superagent',
        'Superagent',
        'The orchestrator you talk to in the Flight Deck. It plans, starts and checks on other agents.',
      ),
      row(
        'superagent',
        'Agent',
        'Uses a CLI login, so its usage counts against that subscription.',
        'harness account login subscription billing',
      ),
      row('superagent', 'Model', 'Auto shows the model it resolves to.', 'llm inference'),
      row('superagent', 'Effort', 'How long the model thinks before acting.', 'reasoning thinking'),
      section(
        'workllm',
        'Background model',
        'Small jobs Podium runs for you: naming sessions, summarising tasks, reading what an agent is doing.',
      ),
      row(
        'workllm',
        'Runs on',
        'Your API keys, keys shared with you, or your Codex login.',
        'provider openrouter anthropic openai chatgpt',
      ),
      row(
        'workllm',
        'Model',
        'A model for fast, inexpensive background work.',
        'llm gemini flash haiku mini',
      ),
      section(
        'workllm',
        'Status',
        'If a run fails, the error shows here.',
        'last failed error machine',
      ),
    ],
  },
  {
    key: 'accounts',
    label: 'AI accounts',
    group: 'personal',
    icon: KeyRound,
    description:
      'How your agents sign in to Anthropic, OpenAI and the rest. Your machines use your logins and keys. Someone else’s machine only runs a key you choose to send there.',
    keywords: 'credentials native login managed api keys secrets providers sharing',
    rows: [
      section(
        'accounts',
        'Logins on your machines',
        'CLI logins found on the machines you look after.',
        'subscription claude codex grok opencode cursor pi sign in',
      ),
      section(
        'accounts',
        'Use on all my machines',
        'Copy a login to every machine you look after, including ones you add later.',
        'copy login transfer d11',
      ),
      section(
        'accounts',
        'API keys',
        'Your keys and keys shared with you, for agents and background jobs.',
        'anthropic openai openrouter claude subscription setup-token',
      ),
      section(
        'accounts',
        'Share a key',
        'Choose who can use a key when they have none of their own.',
        'only you everyone specific people sharing',
      ),
      section(
        'accounts',
        'Send a key to someone else’s machine',
        'Choose which shared machines may run a key, or take it back.',
        'send unsend shared machine',
      ),
    ],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    group: 'personal',
    icon: Bell,
    description:
      'How Podium reaches you when an agent needs you. Nothing is sent while you have a Podium window in front of you.',
    keywords: 'alerts push sounds web telegram ntfy',
    rows: [
      row(
        'notifications',
        'Browser notifications',
        'Applies to your account on every browser. Each browser needs permission to show them.',
        'web allow permission desktop push',
      ),
      row(
        'notifications',
        'Sounds',
        'Cues when an agent finishes, asks a question, needs approval or hits an error. This device only.',
        'audio volume mute notification',
      ),
      row(
        'notifications',
        'Telegram',
        'Connect your chat to the workspace bot, or set up the bot as an admin.',
        'chat id bot message setup pair connect disconnect botfather',
      ),
      row(
        'notifications',
        'ntfy topic',
        'Push through the free ntfy app. Pick a long topic name nobody can guess.',
        'phone mobile push ntfy.sh',
      ),
      row(
        'notifications',
        'Telegram bot token',
        'One bot for the whole workspace. Each person connects their own chat to it.',
        'secret replace remove botfather',
        'Bot token',
      ),
    ],
  },
  {
    key: 'appearance',
    label: 'Appearance',
    group: 'personal',
    icon: Palette,
    description:
      'Theme, density and terminal are remembered on this device, so your phone and your desktop can differ. Sidebar sorting and tips follow you everywhere.',
    keywords: 'theme dark light paper density terminal font',
    rows: [
      row('appearance', 'Theme', 'Choose light, dark or system appearance.', 'mode colours colors'),
      row(
        'appearance',
        'Density',
        'Compact fits more rows on screen.',
        'comfortable balanced compact shell spacing',
      ),
      row(
        'appearance',
        'Keep my last message in view',
        'Pins your latest message to the top of a conversation while the reply scrolls.',
        'sticky prompts chat scroll pinned',
      ),
      row(
        'appearance',
        'Sort projects in the sidebar',
        'Custom is set by dragging projects in the sidebar.',
        'recent alphabetical A–Z custom repo sort order',
      ),
      row(
        'appearance',
        'Show tips',
        'Short explanations as you use Podium. Turning them back on also brings back hints you dismissed.',
        'reset restore guidance contextual help first flights',
      ),
      row('appearance', 'Font size', 'Terminal text size on this device.', 'terminal type zoom'),
      row('appearance', 'Line height', 'Spacing between terminal lines.', 'terminal text leading'),
      row(
        'appearance',
        'Font',
        'The terminal typeface.',
        'terminal monospace typography font family',
      ),
      row('appearance', 'Background', 'Terminal background colour.', 'terminal color colour'),
    ],
  },
  {
    key: 'account',
    label: 'Account',
    group: 'personal',
    icon: UserRound,
    description: 'Who you are here, how you sign in, and where you are signed in.',
    keywords: 'profile password security connected devices phone sign out',
    rows: [
      row(
        'security',
        'Name',
        'Shown on tasks and sessions you start.',
        'display name profile identity',
      ),
      row(
        'security',
        'Email',
        'You sign in with it. Changing it asks for your password.',
        'login identifier profile',
      ),
      row(
        'security',
        'Password',
        'Change the password you use to sign in.',
        'change set current new confirm security',
      ),
      row('security', 'Role', 'Your role in this workspace.', 'admin member profile'),
      section(
        'devices',
        'Where you’re signed in',
        'Every browser, desktop app and phone signed in to your account.',
        'sessions devices last active',
      ),
      section(
        'devices',
        'Pair a phone',
        'Connect the Podium phone app.',
        'mobile qr connect ios android',
      ),
      row(
        'devices',
        'Sign out',
        'Sign out of this account on this device.',
        'logout switch account unsynced changes',
      ),
      row(
        'devices',
        'Sign out everywhere',
        'Sign out on every device, this one included.',
        'all devices revoke lost',
      ),
    ],
  },
  {
    key: 'machines',
    label: 'Machines',
    group: 'workspace',
    icon: Server,
    description: 'Computers that run agents for this workspace, and who may use each one.',
    keywords: 'computers servers hosts fleet hibernation memory gc',
    rows: [
      section(
        'machines',
        'Add a machine',
        'Connect a computer to run agents.',
        'pair join code remote',
      ),
      section(
        'machines',
        'Machine access',
        'Who looks after a machine and who may run agents on it.',
        'custodian grants give use share adopt remove revoke',
      ),
      row(
        'hibernation',
        'Pause idle sessions',
        'Pause quiet sessions automatically to free memory.',
        'hibernation hibernate enabled automatic suspend ram',
      ),
      row(
        'hibernation',
        'A session is idle after',
        'How long an agent must be quiet before it may be paused.',
        'timeout inactivity minutes',
      ),
      row(
        'hibernation',
        'Keep at most',
        'Idle sessions per machine before the oldest are paused. Sessions you are watching are never paused.',
        'maximum idle cap memory',
      ),
      row(
        'hibernation',
        'Pause sooner when memory is above',
        'Pause eligible idle sessions when this much memory is in use.',
        'ram pressure percent threshold',
      ),
      row(
        'hibernation',
        'Pause sooner when load is above',
        'Per CPU core. Empty turns load pressure off.',
        'cpu threshold pressure run queue',
      ),
      row(
        'hibernation',
        'Close idle shells after',
        'Plain shells with no input or output. Empty keeps them open.',
        'terminal reap minutes',
      ),
      row(
        'hibernation',
        'Always pause after',
        'A last resort for quiet sessions, unless a wake-up is scheduled.',
        'backstop timeout suspend hours',
      ),
    ],
  },
  {
    key: 'projects',
    label: 'Projects',
    group: 'workspace',
    icon: Folder,
    description: 'The repositories Podium works in, and how tasks branch, land and get cleaned up.',
    keywords: 'repos repositories git workflow base parent branch merge worktree prefix linear',
    rows: [
      section(
        'repos',
        'Repositories',
        'Registered projects, their prefixes, base branches and checkouts.',
        'add project scan clone folder remote prefix base branch worktrees remove',
      ),
      row(
        'workflow',
        'Default base branch',
        'Where new tasks branch from and land, unless the project sets its own.',
        'parent git workflow main landing',
      ),
      row(
        'workflow',
        'Rebase before landing',
        'Brings a task’s branch up to date with its base before it merges, so landing is a fast-forward.',
        'merge ff history',
      ),
      row(
        'workflow',
        'When a closed task’s worktree is old',
        'Keep, suggest cleanup, or delete old worktrees. Uncommitted changes are never touched.',
        'gc garbage collection collect cleanup disk off propose auto',
      ),
      row('workflow', 'Old means', 'Days after closing a task.', 'worktree cleanup retention age'),
      row(
        'workflow',
        'Keep a summary on each task',
        'Runs on each person’s background model when a task changes.',
        'ai assistant digest',
      ),
      row(
        'workflow',
        'Linear',
        'Lets you and the superagent find Linear issues to link to tasks.',
        'integration api key secret',
      ),
    ],
  },
  {
    key: 'members',
    label: 'Members',
    group: 'workspace',
    icon: Users,
    description:
      'People who can sign in to this workspace. Open someone to change their role, see their devices and keys, or remove them.',
    keywords: 'people users directory roles invitations admin',
    rows: [
      section(
        'members',
        'Invite someone',
        'Create an invitation link or email an invitation.',
        'invite email member admin',
      ),
      section(
        'members',
        'Change someone’s role',
        'Choose who can administer the workspace.',
        'make admin member permissions',
      ),
      section(
        'members',
        'Disable a member',
        'Stop a member signing in, or remove them from the workspace.',
        'suspend block enable remove',
      ),
      section(
        'members',
        'Recovery link',
        'Help a member recover their sign-in.',
        'reset password forgot',
      ),
    ],
  },
  {
    key: 'access',
    label: 'Access',
    adminOnly: true,
    group: 'workspace',
    icon: Globe,
    description:
      'How phones, browsers and machines reach this workspace, who may sign in, and every sign-in that is open right now.',
    keywords: 'network server url tunnel cloudflare admission security auth',
    rows: [
      row(
        'network',
        'Podium address',
        'Change how this workspace is reached. Paired machines and phones must rejoin.',
        'public url network tunnel own domain tailscale funnel serve cloudflare proxy',
      ),
      row(
        'network',
        'Reachable from outside',
        'Tunnel status and the last outside reachability check.',
        'connect check health restarting status',
      ),
      row(
        'network',
        'Connected to',
        'The server this worker or client machine connects to.',
        'daemon worker client url',
      ),
      row(
        'instance-login',
        'Require sign-in',
        'Everyone signs in with their own account. Can be turned off and back on.',
        'login password security open mode auth',
      ),
      row(
        'instance-login',
        'New people join',
        'People join with an invite link from Members.',
        'invite invitation registration',
      ),
      section(
        'access',
        'Signed in now',
        'Every unexpired sign-in, with Sign out and a Phones filter.',
        'sessions devices revoke phones browser desktop',
      ),
      row(
        'access-advanced',
        'Web app address',
        'Where browsers and desktop apps load the interface.',
        'split hosting app url',
      ),
      row(
        'access-advanced',
        'Other sites allowed to sign in',
        'Browser origins allowed by this deployment.',
        'cors allowed origins security',
      ),
      row(
        'access-advanced',
        'Stable link',
        'Always opens this server, even after its address changes.',
        'connect bookmark',
      ),
      row(
        'access-advanced',
        'Server-to-server links',
        'Upstream links and host recovery sign-ins.',
        'advanced break glass recovery',
      ),
    ],
  },
  {
    key: 'audit',
    label: 'Audit log',
    adminOnly: true,
    group: 'workspace',
    icon: History,
    description:
      'Security-relevant changes in this workspace: people, roles, invites, machines, credentials and comment moderation. Values, transcripts and task text are never recorded.',
    keywords: 'security events history activity',
    rows: [
      section(
        'audit',
        'Audit log',
        'Filter security events by action, result, actor and target.',
        'security events filters paging cursor',
      ),
    ],
  },
  {
    key: 'privacy',
    label: 'Privacy',
    adminOnly: true,
    group: 'workspace',
    icon: Shield,
    description: 'What leaves this workspace. Prompts, code, paths and agent output never do.',
    keywords: 'telemetry diagnostics consent transcripts mirror',
    rows: [
      row(
        'privacy',
        'Usage reports',
        'Once a day: version, OS, counts of machines and sessions, which features are used.',
        'telemetry consent install id opt out',
      ),
      row(
        'privacy',
        'Crash reports',
        'The error type and the Podium source lines it came from. No messages, no outside frames.',
        'telemetry errors sentry consent',
      ),
      row(
        'privacy',
        'See exactly what is sent',
        'Open the report preview and install id, with Reset.',
        'telemetry json preview install id reset never sent',
      ),
      row(
        'privacy',
        'Keep a copy of every transcript on the server',
        'So a session stays searchable after the machine that ran it is gone.',
        'lake search storage retention copy',
      ),
    ],
  },
  {
    key: 'updates',
    label: 'Updates',
    group: 'workspace',
    icon: RefreshCw,
    description:
      'Which Podium version this workspace runs. Nothing updates on its own — you choose when.',
    keywords: 'version release channel stable edge upgrade',
    rows: [
      row(
        'updates',
        'Update channel',
        'Choose stable releases or early edge versions.',
        'stable edge development fleet default channel',
      ),
      row(
        'updates',
        'Podium',
        'The Podium version this workspace runs.',
        'running version components server interface phone desktop',
      ),
      row(
        'updates',
        'Last checked',
        'Check the channels for available releases.',
        'check now updates versions',
      ),
      section(
        'updates',
        'Machines',
        'Each machine’s version, target, progress and Apply action.',
        'fleet daemon upgrade target update all',
      ),
      section(
        'updates',
        'History',
        'Past updates, their outcomes, and why an update failed.',
        'recent updates operations what happened',
      ),
      row(
        'updates',
        'Log detail for this window',
        'Temporarily record more detail for troubleshooting.',
        'diagnostic logging normal detailed verbose back to normal',
      ),
      row(
        'updates',
        'Repair this installation',
        'Download the current version again and restart the desktop app.',
        'repair payload reinstall download',
      ),
      section(
        'updates',
        'Development release',
        'Build and publish a proposed development release when its lab is enabled.',
        'approval dev release publish',
      ),
      section(
        'updates',
        'Update disk space',
        'Disk space used by update artifacts.',
        'storage cleanup downloads',
      ),
    ],
  },
  {
    key: 'labs',
    label: 'Labs',
    adminOnly: true,
    group: 'workspace',
    icon: FlaskConical,
    description: 'Features still being built. They can change or disappear between versions.',
    keywords: 'experimental feature flags preview development',
    rows: [
      ...FEATURES.filter((flag) => flag.visibility !== 'hidden').map((flag) =>
        row('labs', flag.name, flag.description, flag.id),
      ),
    ],
  },
]

export const SETTINGS_GROUPS = [
  {
    label: 'Personal',
    surface: 'personal',
    tabs: SETTINGS_PAGES.filter((p) => p.group === 'personal'),
  },
  {
    label: 'Workspace',
    surface: 'workspace',
    tabs: SETTINGS_PAGES.filter((p) => p.group === 'workspace'),
  },
] as const
export const SETTINGS_TABS = SETTINGS_PAGES
export const settingsPage = (page: SettingsPage): SettingsPageDefinition =>
  SETTINGS_PAGES.find((p) => p.key === page)!

export function settingsRowId(sectionId: string, label: string): string {
  return `settings-${sectionId}-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`
}
export const settingsSectionId = (id: string): string => `settings-section-${id}`

export interface SettingsSearchResult extends SettingsSearchRow {
  page: SettingsPageDefinition
  targetId: string
}

export function searchSettings(
  query: string,
  pages: readonly SettingsPageDefinition[],
): SettingsSearchResult[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return pages
    .flatMap((page) => [
      {
        page,
        label: page.label,
        help: page.description,
        keywords: page.keywords,
        section: '',
        targetId: '',
      },
      ...page.rows.map((entry) => ({
        ...entry,
        page,
        targetId: entry.rowLabel
          ? settingsRowId(entry.section, entry.rowLabel)
          : settingsSectionId(entry.section),
      })),
    ])
    .map((entry) => {
      let score = 0
      for (const word of words) {
        const label = entry.label.toLowerCase()
        if (label.startsWith(word)) score += 6
        else if (label.includes(word)) score += 4
        else if (entry.page.label.toLowerCase().includes(word)) score += 2
        else if (`${entry.help} ${entry.keywords}`.toLowerCase().includes(word)) score += 1
        else return { entry, score: 0 }
      }
      return { entry, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(({ entry }) => entry)
}
