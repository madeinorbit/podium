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

const roleRows = (id: string, defaults = false): SettingsSearchRow[] => [
  row(
    id,
    defaults ? 'Default account' : 'Account',
    'The login or API key this role uses.',
    'agent harness credential provider billing',
  ),
  row(id, 'Harness', 'Which agent CLI runs with the selected account.', 'coding backend'),
  row(
    id,
    defaults ? 'Default model' : 'Model',
    'Auto uses the agent’s default model.',
    'llm inference',
  ),
  row(
    id,
    defaults ? 'Default effort' : 'Effort',
    'How long the model thinks before acting.',
    'reasoning thinking',
  ),
]

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
        'Defaults for coding agents you start from the sidebar, a task, or the phone.',
      ),
      ...roleRows('sessions'),
      row(
        'sessions',
        'Model for subagents',
        'Applied when the selected harness supports a native subagent-model override.',
        'helpers subagent model',
      ),
      row(
        'sessions',
        'New session opens on',
        'Choose the terminal, chat or automatic view for new sessions.',
        'terminal chat auto phone',
      ),
      row(
        'sessions',
        'Match agent theme to Podium',
        'Start each agent in a theme that fits the current Podium theme.',
        'cli colours colors appearance',
      ),
      row(
        'sessions',
        'Keep going after errors',
        'Retry after rate limits and server errors, with a growing pause.',
        'auto continue autocontinue retry rate limit tokens',
        'Enabled',
      ),
      section('superagent', 'Superagent', 'The orchestrator you talk to in the Flight Deck.'),
      ...roleRows('superagent', true),
      section(
        'workllm',
        'Background work LLM',
        'Small API calls for titles, summaries and other background work.',
        'background model',
      ),
      ...roleRows('workllm'),
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
        'Native logins',
        'Agent logins already on your machines.',
        'subscription claude codex grok opencode cursor pi sign in',
      ),
      section(
        'accounts',
        'Managed accounts',
        'Connect a provider account, send it to a machine, or choose who may use it.',
        'api key credential send unsend share only you everyone specific people',
      ),
      row(
        'secrets',
        'OpenRouter API key',
        'A server-owned credential. Only presence and fingerprint are shown.',
        'openrouter provider secret',
      ),
      row(
        'secrets',
        'Anthropic API key',
        'A server-owned credential. Only presence and fingerprint are shown.',
        'claude provider secret',
      ),
      row(
        'secrets',
        'OpenAI API key',
        'A server-owned credential. Only presence and fingerprint are shown.',
        'codex provider secret',
      ),
      row(
        'secrets',
        'Linear API key',
        'Connect Linear task search.',
        'integration issues tickets secret',
      ),
      row(
        'secrets',
        'Telegram bot token',
        'The workspace bot used for Telegram notifications.',
        'notifications botfather secret',
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
        'Web notifications',
        'Browser alerts when agents finish or need attention.',
        'permission desktop push',
      ),
      row(
        'notifications',
        'Notification sounds',
        'Cues on agent done, questions, approvals, and errors. This device only.',
        'audio volume mute',
      ),
      row(
        'notifications',
        'ntfy.sh topic',
        'Send push notifications to your ntfy topic.',
        'phone mobile push',
      ),
      row(
        'notifications',
        'Telegram chat',
        'Your connected Telegram destination.',
        'chat id bot message',
      ),
      row(
        'notifications',
        'Telegram setup',
        'Connect or reconnect your Telegram chat.',
        'pair connect bot',
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
      row('appearance', 'Mode', 'Choose light, dark or system appearance.', 'theme colours colors'),
      row(
        'appearance',
        'Density',
        'Balanced prioritizes readable shell typography and a calm scan. Compact fits more work on screen. This device only.',
        'compact balanced shell spacing',
      ),
      row(
        'appearance',
        'Sticky prompts',
        'Keep the current operator prompt visible while its response scrolls. This device only.',
        'chat scroll pinned',
      ),
      row('appearance', 'Font size', 'Terminal text size on this device.', 'terminal type zoom'),
      row('appearance', 'Line height', 'Spacing between terminal lines.', 'terminal text leading'),
      row('appearance', 'Font family', 'The terminal typeface.', 'terminal monospace typography'),
      row('appearance', 'Background', 'Terminal background colour.', 'terminal color colour'),
      row(
        'appearance',
        'Show tips',
        'First Flights explains Podium as you go. Saved to your account; turning tips on keeps your progress.',
        'reset restore guidance contextual help',
      ),
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
      row('security', 'Name', 'Shown on tasks and sessions you start.', 'display name profile identity'),
      row('security', 'Email', 'You sign in with it. Changing it asks for your password.', 'login identifier profile'),
      row('security', 'Password', 'Change the password you use to sign in.', 'change set current new confirm security'),
      row('security', 'Role', 'Your role in this workspace.', 'admin member profile'),
      section('devices', 'Where you’re signed in', 'Every browser, desktop app and phone signed in to your account.', 'sessions devices last active'),
      section('devices', 'Pair a phone', 'Connect the Podium phone app.', 'mobile qr connect ios android'),
      section('devices', 'Sign out', 'Sign out of this account on this device.', 'logout switch account unsynced changes'),
      section('devices', 'Sign out everywhere', 'Sign out on every device, this one included.', 'all devices revoke lost'),
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
        'Auto-hibernation',
        'Park idle agents to relieve memory and load pressure.',
        'enabled automatic suspend ram',
        'Enabled',
      ),
      row(
        'hibernation',
        'Memory threshold (%)',
        'Hibernate idle agents when memory exceeds this threshold.',
        'ram pressure percent',
      ),
      row(
        'hibernation',
        'Load per core',
        'load1 ÷ cores. Empty turns load pressure off. Default 1.5 means the run queue is half again the core count.',
        'cpu threshold pressure',
      ),
      row(
        'hibernation',
        'Idle after (minutes)',
        'How long an agent must be quiet before it may hibernate.',
        'timeout inactivity',
      ),
      row(
        'hibernation',
        'Maximum idle sessions',
        'Cap the number of idle agents left running.',
        'idle cap memory',
      ),
      row(
        'hibernation',
        'Idle shell minutes',
        'Park live shells after this many minutes with no input or output. The default is 60 minutes; empty turns shell reaping off.',
        'terminal reap',
      ),
      row(
        'hibernation',
        'Idle backstop minutes',
        'Last resort: park after total quiet time without terminal proof. A future scheduled wakeup keeps the session live; empty disables this backstop.',
        'timeout suspend',
      ),
      row(
        'hibernation',
        'Worktree GC',
        'Propose is the default so a first run is inspectable before anything is deleted from disk.',
        'garbage collection cleanup disk mode',
        'Mode',
      ),
      row(
        'hibernation',
        'After (days)',
        'Measured from the issue’s closedAt. Sweeps closed worktrees that were never archived.',
        'gc retention worktree cleanup',
      ),
    ],
  },
  {
    key: 'projects',
    label: 'Projects',
    group: 'workspace',
    icon: Folder,
    description: 'The repositories Podium works in, and how tasks branch, land and get cleaned up.',
    keywords: 'repos repositories git workflow base parent branch merge',
    rows: [
      section(
        'repos',
        'Repositories',
        'Registered projects, their prefixes, base branches and checkouts.',
        'add project scan clone folder remote prefix base branch worktrees',
      ),
      row(
        'workflow',
        'Default parent branch',
        'New tasks branch from this in repositories without their own base branch. Leave empty to use each repository’s main branch.',
        'base git workflow main landing',
      ),
      row(
        'workflow',
        'Merge style',
        'How task branches land on their parent branch.',
        'git squash merge commit',
      ),
      row(
        'workflow',
        'Rebase before merge',
        'Rebase task branches before landing.',
        'git history workflow',
      ),
      row(
        'workflow',
        'Task AI assistant enabled',
        'Show the assistant for task planning.',
        'issues assistant',
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
    group: 'workspace',
    icon: Globe,
    description:
      'How phones, browsers and machines reach this workspace, who may sign in, and every sign-in that is open right now.',
    keywords: 'network server url tunnel cloudflare admission security auth',
    rows: [
      section(
        'network',
        'Workspace address',
        'How browsers, phones and machines reach Podium.',
        'server url network public local tunnel cloudflare port hostname https',
      ),
      section(
        'network',
        'Podium URL',
        'The address phones, browsers and machines use to reach this server.',
        'public url network tunnel own domain tailscale',
      ),
      row(
        'network',
        'Public URL',
        'The server’s public address, when configured by the deployment.',
        'network address',
      ),
      row(
        'network',
        'Tunnel',
        'The current health of the workspace tunnel.',
        'cloudflare restarting status',
      ),
      row(
        'network',
        'Connected to',
        'The server this machine connects to.',
        'worker daemon client url',
      ),
      row(
        'network',
        'Stable link (bookmark this)',
        'Always opens this server, even after its address changes.',
        'connect bookmark',
      ),
      row(
        'network',
        'Web app URL',
        'Browsers and desktop apps are sent here for the interface; this server answers the API.',
        'split hosting app url',
      ),
      row(
        'network',
        'Allowed browser origins',
        'Sites allowed to sign in to this server from another origin.',
        'cors security allow list',
      ),
      row(
        'access',
        'Admission',
        'Who may join this workspace.',
        'invite invitation sign up registration',
      ),
      row(
        'access',
        'Sign-in',
        'Whether everyone must sign in with their own account.',
        'require login password open mode auth',
      ),
      row('access', 'Invitations', 'Open and expired invitation links.', 'invite members'),
      row('access', 'Members', 'Disabled members cannot sign in.', 'people users active disabled'),
      section(
        'access',
        'Sign-ins',
        'Review every current sign-in and sign out a device.',
        'sessions devices revoke phones browser',
      ),
    ],
  },
  {
    key: 'audit',
    label: 'Audit log',
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
    group: 'workspace',
    icon: Shield,
    description: 'What leaves this workspace. Prompts, code, paths and agent output never do.',
    keywords: 'telemetry diagnostics consent transcripts mirror',
    rows: [
      row(
        'privacy',
        'Anonymous usage reports',
        'Choose whether anonymous usage data leaves this workspace.',
        'telemetry consent install id opt out',
      ),
      row(
        'privacy',
        'Crash reports',
        'Choose whether to share crash diagnostics.',
        'telemetry errors sentry consent',
      ),
      row(
        'privacy',
        'Mirror transcripts to this server',
        'Keeps a copy of each session’s transcript here so it stays searchable after the machine that ran it goes away.',
        'lake search storage retention copy',
      ),
      row(
        'privacy',
        'Detail level',
        'Choose how much diagnostic detail Podium records and forwards to your server.',
        'log level debug info warn error privacy',
      ),
      row(
        'privacy',
        'Temporary change',
        'Returns to the boot logging level by itself. Nothing is saved.',
        'logging diagnostic expiry reset',
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
      section(
        'updates',
        'Update channel',
        'Choose stable releases or early edge versions.',
        'stable edge version release',
      ),
      section(
        'updates',
        'Check for updates',
        'See available versions and update machines.',
        'upgrade install rollback server daemon fleet',
      ),
      row(
        'updates',
        'Fleet default channel',
        'Machines follow this unless one has been pinned to its own source.',
        'stable edge dev update channel',
      ),
      row(
        'updates',
        'Target version',
        'The version this server is asking its places to run.',
        'fleet current update',
      ),
      row(
        'updates',
        'Development release',
        'A landed commit is proposed for the fleet first. Approval builds and publishes it; rollout remains the normal update offer.',
        'approval dev release publish',
      ),
      row(
        'updates',
        'Update channels',
        'Podium checks each channel daily. What it heard, and when.',
        'stable edge versions',
      ),
      row(
        'updates',
        'Repair payload',
        'Re-download the current server, daemon, and web payload through the normal fleet update path.',
        'repair reinstall download',
      ),
      row(
        'updates',
        'Machines',
        'Each machine’s reported version compared with the target. Podium never applies an update on its own.',
        'fleet daemon version',
      ),
      row(
        'updates',
        'Recent updates',
        'The last update operations this server ran, and how they ended.',
        'history results completed',
      ),
      row(
        'updates',
        'Running version',
        'The Podium version this workspace runs.',
        'server daemon app release',
      ),
      row(
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
