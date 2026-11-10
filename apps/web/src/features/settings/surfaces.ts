/** Page ownership is navigation; write authority still comes from the server.
 * Every settings leaf keeps a declared page or an explicit absence reason. */
import type { SettingsPage } from '@podium/client-core/ui-state'

export const SETTINGS_SURFACES = ['personal', 'workspace'] as const
export type SettingsSurface = (typeof SETTINGS_SURFACES)[number]
export const SURFACE_COPY = {
  personal: { label: 'Personal' },
  workspace: { label: 'Workspace' },
} as const

export const TAB_PATHS = {
  agents: [
    'roles.coding',
    'autoContinue.enabled',
    'roles.superagent',
    'roles.shipwright',
    'roles.background',
  ],
  accounts: ['apiKeys.openrouter', 'apiKeys.anthropic', 'apiKeys.openai'],
  notifications: [
    'notifications.web',
    'notifications.ntfyTopic',
    'notifications.telegramChatId',
    'notifications.telegramBotToken',
  ],
  appearance: ['sidebar.repoSort'],
  account: [],
  machines: ['hibernation'],
  projects: [
    'gitWorkflow.defaultParentBranch',
    'gitWorkflow.autoRebaseBeforeMerge',
    'worktreeGc',
    'issues.assistantEnabled',
    'integrations.linearApiKey',
  ],
  members: [],
  access: [],
  audit: [],
  privacy: [
    'transcripts',
    'deployment.telemetryUsage',
    'deployment.telemetryCrash',
    'deployment.telemetryInstallId',
    'deployment.telemetrySince',
  ],
  updates: ['deployment.updateChannel'],
  labs: ['experimental'],
} as const satisfies Record<SettingsPage, readonly string[]>

export const TAB_SURFACE = {
  agents: 'personal',
  accounts: 'personal',
  notifications: 'personal',
  appearance: 'personal',
  account: 'personal',
  machines: 'workspace',
  projects: 'workspace',
  members: 'workspace',
  access: 'workspace',
  audit: 'workspace',
  privacy: 'workspace',
  updates: 'workspace',
  labs: 'workspace',
} as const satisfies Record<SettingsPage, SettingsSurface>

// AI accounts temporarily hosts the existing server-secret presence controls.
// Re-homing them does not turn those writes into personal preferences.
export const PAGE_SETTINGS_TIER = {
  agents: 'personal-preference',
  accounts: 'server-secret',
  notifications: 'personal-preference',
  appearance: 'personal-preference',
  account: 'personal-preference',
  machines: 'instance-preference',
  projects: 'instance-preference',
  members: 'instance-preference',
  access: 'instance-preference',
  audit: 'instance-preference',
  privacy: 'instance-preference',
  updates: 'instance-preference',
  labs: 'instance-preference',
} as const

export const NOT_ON_THIS_SCREEN: Readonly<Record<string, string>> = {
  'gitWorkflow.mergeStyle': 'No consumer reads this setting. Tasks always land by fast-forward.',
  'sidebar.repoOrder': 'Set by dragging project headers in the sidebar.',
  'sidebar.groupByRepo': 'The sidebar’s own grouping toggle.',
  'autoContinue.promptDismissed':
    'Written by dismissing the auto-continue prompt. A readAt/snooze-shaped fact (POD-351, POD-731): it records that THIS user dismissed something, and a settings row for it would invite an admin to un-dismiss it for everyone.',
  'deployment.authOpenMode':
    'Ended by an admin’s “require sign-in” control under Account, drawn only for an admin (canManageInstance). That tab is personal, so it does not claim this instance leaf.',
  'deployment.connectEnabled':
    'No control ships for it. It is imported from config.json’s connect.enabled (settings-config-import.ts) or set by the deployment.',
  'steward.enabled':
    'No control ships for it. The steward is toggled by configuration, and adding a switch is a product decision rather than a classification one.',
}

/** The pages on a surface, in rail order. */
export const tabsOnSurface = (surface: SettingsSurface): SettingsPage[] =>
  (Object.keys(TAB_SURFACE) as SettingsPage[]).filter((page) => TAB_SURFACE[page] === surface)

export const pathIsUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`)

export const ADMIN_SECTIONS = ['people', 'access', 'machines', 'instance', 'audit'] as const
export type AdminSection = (typeof ADMIN_SECTIONS)[number]

/** Only these pages require a capability. Members retain the other workspace
 * destinations; their existing controls enforce their own write authority. */
export function adminSectionOf(page: SettingsPage): AdminSection | undefined {
  switch (page) {
    case 'access':
      return 'access'
    case 'audit':
      return 'audit'
    case 'privacy':
    case 'labs':
      return 'instance'
    default:
      return undefined
  }
}

export function visibleSettingsGroups<
  G extends { surface: SettingsSurface; tabs: readonly { key: SettingsPage; label: string }[] },
>(groups: readonly G[], sections: readonly string[]): G[] {
  return groups
    .map((group) => ({
      ...group,
      tabs: group.tabs.filter((page) => {
        const section = adminSectionOf(page.key)
        return section === undefined || sections.includes(section)
      }),
    }))
    .filter((group) => group.tabs.length > 0)
}
