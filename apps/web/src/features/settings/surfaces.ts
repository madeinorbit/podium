/**
 * THE THREE SETTINGS SURFACES, MADE LEGIBLE (POD-421, 3.7d).
 *
 * `docs/multi-user-readiness.md` §3.1.1 splits settings across three matrix rows
 * with genuinely different answers to "who may write this and who does it affect"
 * — and POD-418 made that split total in the model, POD-420 in the commands.
 * The screen still showed one undifferentiated list of seventeen tabs.
 *
 * The brief's requirement is that **the distinction must be legible to the user,
 * not merely enforced in the backend**. So the nav is grouped by the CLASS the
 * settings belong to rather than by topic:
 *
 *   1. YOUR PREFERENCES — `per-user-state`, member-writable.
 *   2. INSTANCE SETTINGS — `deployment-substrate`, tenant-visible, admin-managed.
 *   3. SECRETS — `secret`, server-owned, admin-grade, presence only.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS A TABLE AND NOT A HEADING IN THE JSX
 * ---------------------------------------------------------------------------
 *
 * A heading is a claim about classification made in a place nothing can check.
 * Here the claim is data: {@link TAB_PATHS} names which settings leaves each tab
 * edits, `surfaces.test.ts` asserts every one of those paths is classified in
 * the tier its tab's surface declares, and {@link NOT_ON_THIS_SCREEN} accounts
 * for the classified leaves no tab edits — so a leaf cannot be silently absent
 * from both lists.
 *
 * WHAT THAT CHECK CANNOT DO, stated so nobody reads more into it: it compares
 * two declarations, not the declaration against the JSX. A row that edits
 * `hibernation.enabled` from a tab declared `your-preferences` would still
 * render. What it DOES catch is the case that actually happens — a leaf added to
 * the model and to no screen, or a tab whose declared class disagrees with the
 * classification of the paths it says it edits.
 */

import type { SettingsTab } from './SettingsView'

export const SETTINGS_SURFACES = ['your-preferences', 'instance', 'secrets'] as const
export type SettingsSurface = (typeof SETTINGS_SURFACES)[number]

/**
 * The heading, and the sentence under it.
 *
 * THE PREFERENCES BLURB DELIBERATELY DOES NOT PROMISE PRIVACY, and that is the
 * most considered line in this file. The brief asked for copy saying that
 * editing these affects nobody else. On this build that is FALSE: POD-418
 * classified the tier as per-user and POD-1213 owns the storage move, so the
 * values still live in one instance-wide blob served whole to every
 * authenticated client. One user's session defaults, sidebar order, ntfy topic
 * and Telegram chat id are readable by every other user right now.
 *
 * A "nobody else can see this" line on that build is the product asserting a
 * guarantee it does not keep, on the one surface where a user would act on the
 * assurance by typing something they consider private. So the copy states the
 * declared class AND what is true today, and names the issue. POD-352 backed
 * this call explicitly: an honest gap on screen gets fixed, a false promise on
 * screen gets believed and never re-read.
 */
export const SURFACE_COPY: Readonly<
  Record<SettingsSurface, { label: string; hint: string; caveat?: string }>
> = {
  'your-preferences': {
    label: 'Your preferences',
    hint: 'How Podium behaves for you — defaults for new sessions, notifications, appearance.',
    caveat:
      'These are classified as per-user, but this instance still stores them once for everyone: ' +
      'changing them changes them for every member. Per-user storage is tracked as POD-1213.',
  },
  instance: {
    label: 'Instance settings',
    hint: 'Properties of this deployment. Everyone sees them because they govern everyone’s sessions; only an admin can change them.',
  },
  secrets: {
    label: 'Secrets',
    hint: 'Server-owned credentials. Podium shows whether one is configured and a fingerprint for telling one key from another — never the value, which never leaves the server.',
  },
}

/**
 * Which settings leaves each tab edits, and therefore which surface it belongs
 * on. Tabs that edit no settings-blob leaf carry an empty list and are placed by
 * what they administer.
 *
 * `satisfies Record<SettingsTab, …>` is the load-bearing part: a new tab is a
 * COMPILE ERROR here rather than a tab with no declared class, which is ADR 9
 * D4's default-closed rule applied to the screen.
 */
export const TAB_PATHS = {
  // — Your preferences ——————————————————————————————————————————————
  sessions: ['roles.coding', 'autoContinue.enabled'],
  superagent: ['roles.superagent'],
  workllm: ['roles.background'],
  notifications: ['notifications.web', 'notifications.ntfyTopic', 'notifications.telegramChatId'],
  // Self-persisting surfaces: they write config.json, localStorage or their own
  // tables rather than the settings blob, so they classify no leaf. They sit
  // under preferences because that is whose behaviour they change.
  appearance: [],
  accounts: [],
  privacy: [],

  // — Instance ——————————————————————————————————————————————————————
  hibernation: ['hibernation'],
  workflow: ['gitWorkflow', 'issues.assistantEnabled'],
  experimental: ['experimental'],
  // Substrate that lives outside the blob: pairing, routing and the deployment's
  // own identity. Tenant-visible, admin-managed, no classified leaf of its own.
  repos: [],
  machines: [],
  network: [],
  security: [],
  updates: [],

  // — Secrets ———————————————————————————————————————————————————————
  //
  // ONE TAB FOR THE WHOLE CLOSED VOCABULARY. `keys` and `integrations` used to
  // be two tabs whose entire content was password inputs bound to blob members;
  // splitting five server-owned secrets across two topic tabs meant the class
  // was invisible and the Telegram bot token sat under Notifications beside a
  // per-user routing address. The five ARE the vocabulary
  // (`SERVER_SECRET_KEYS`), so one surface for them is the honest shape.
  secrets: [
    'apiKeys.openrouter',
    'apiKeys.anthropic',
    'apiKeys.openai',
    'integrations.linearApiKey',
    'notifications.telegramBotToken',
  ],
} as const satisfies Record<SettingsTab, readonly string[]>

/** Tab → surface. Derived from nothing: it is the declaration the test checks
 *  {@link TAB_PATHS} against, so deriving one from the other would leave one
 *  claim rather than two. */
export const TAB_SURFACE = {
  sessions: 'your-preferences',
  superagent: 'your-preferences',
  workllm: 'your-preferences',
  notifications: 'your-preferences',
  appearance: 'your-preferences',
  accounts: 'your-preferences',
  privacy: 'your-preferences',

  hibernation: 'instance',
  workflow: 'instance',
  experimental: 'instance',
  repos: 'instance',
  machines: 'instance',
  network: 'instance',
  security: 'instance',
  updates: 'instance',

  secrets: 'secrets',
} as const satisfies Record<SettingsTab, SettingsSurface>

/**
 * CLASSIFIED LEAVES THAT NO SETTINGS TAB EDITS, each with where it IS edited.
 *
 * Named rather than tolerated, for POD-418's reason at
 * `SETTINGS_OPEN_RECORD_LEAVES`: without this list, "a leaf is on no tab" and "a
 * leaf was forgotten" are the same silence. `surfaces.test.ts` requires every
 * classified path to be reachable from {@link TAB_PATHS} OR to be named here, so
 * a leaf added to the model and to no screen fails a test instead of shipping
 * unreachable.
 */
export const NOT_ON_THIS_SCREEN: Readonly<Record<string, string>> = {
  'sidebar.repoSort': 'The sidebar’s own sort control — edited where it applies.',
  'sidebar.repoOrder': 'Set by dragging repos in the sidebar.',
  'sidebar.groupByRepo': 'The sidebar’s own grouping toggle.',
  'autoContinue.promptDismissed':
    'Written by dismissing the auto-continue prompt. A readAt/snooze-shaped fact (POD-351, POD-731): it records that THIS user dismissed something, and a settings row for it would invite an admin to un-dismiss it for everyone.',
  'steward.enabled':
    'No control ships for it. The steward is toggled by configuration, and adding a switch is a product decision rather than a classification one.',
}

/** The tabs on one surface, in declaration order. */
export const tabsOnSurface = (surface: SettingsSurface): SettingsTab[] =>
  (Object.keys(TAB_SURFACE) as SettingsTab[]).filter((tab) => TAB_SURFACE[tab] === surface)

/**
 * Does this path sit under one of the tab's declared prefixes?
 *
 * Prefix matching on a DOT BOUNDARY, never a bare `startsWith`: `roles.coding`
 * must not claim a hypothetical `roles.codingAssistant`, which is the
 * canonicalisation collision POD-420's fingerprint separator was written
 * against, arriving in a path matcher.
 */
export const pathIsUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`)
