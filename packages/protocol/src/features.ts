/**
 * Experimental feature-flag registry + pure resolver [spec:SP-f4b9].
 *
 * Shared by server and web. Visibility controls where a flag appears in
 * Settings → Experimental; enablement always defaults off unless config or
 * a listed user toggle turns it on.
 */

export type FeatureVisibility = 'hidden' | 'development' | 'edge' | 'stable'

export interface FeatureDefinition {
  /** Stable kebab-case id — the key used in config.json and settings. Never renamed. */
  id: string
  /** User-facing name shown in Settings → Experimental. */
  name: string
  /** User-facing description shown under the name. */
  description: string
  /** Where the flag appears in Experimental (see design doc). */
  visibility: FeatureVisibility
}

export const FEATURES = [
  {
    // Draft Sync v2 (POD-859). Edge-visibility: listed in Settings → Experimental on
    // edge-channel installs; enablement flows through resolveFeatureState like any
    // other flag. Ships dark (default off) — off = today's client-scraped behavior.
    id: 'draft-sync',
    name: 'Draft sync',
    description:
      'Bidirectional draft sync between the chat box and the agent’s native composer: text typed in either place mirrors to the other. Experimental — off by default.',
    visibility: 'edge',
  },
  {
    id: 'runtime-drivers',
    name: 'Headless session drivers',
    description:
      'Route headed sessions through the driver contract by default, keep legacy PTY available, and offer available headless runtime drivers when starting a session.',
    visibility: 'stable',
  },
  {
    id: 'settings-search',
    name: 'Settings search',
    description: 'Show the "Find a setting" filter box in the Settings side nav.',
    visibility: 'stable',
  },
  {
    // The ONE switch for search (PDM-25). Beyond the palette it also decides
    // whether the server builds the full-text index at all: with it off there are
    // no fts5 triggers on `conversations` and no transcript indexing, and search
    // falls back to LIKE. Read at boot, so a change lands on the next start.
    id: 'command-palette',
    name: 'Cmd+K search',
    description:
      'Search and navigate Podium from the Cmd+K command palette. Also keeps the full-text index of conversation summaries and mirrored transcripts that search and the assistant’s search tools use. Takes effect at the next server start.',
    visibility: 'edge',
  },
  {
    id: 'git-panel',
    name: 'Git panel',
    description: 'Show the Git tab in the right sidebar.',
    visibility: 'edge',
  },
  {
    id: 'messages-panel',
    name: 'Messages panel',
    description: 'Show the Messages tab in the right sidebar.',
    visibility: 'edge',
  },
  {
    id: 'shipping',
    name: 'Shipping',
    description: 'Show durable delivery progress in the right sidebar.',
    visibility: 'edge',
  },
  {
    id: 'session-handoff',
    name: 'Session handoff',
    description: 'Move a live session to another Podium server.',
    visibility: 'edge',
  },
  {
    id: 'workflows',
    name: 'Workflows',
    description: 'Show workflows and give agents workflow-aware instructions and CLI guidance.',
    visibility: 'edge',
  },
  {
    id: 'specs',
    name: 'Specs',
    description: 'Show living specs and give agents spec-aware instructions and CLI guidance.',
    visibility: 'edge',
  },
  {
    id: 'automations',
    name: 'Automations',
    description: 'Show scheduled automations and notification triggers.',
    visibility: 'edge',
  },
  {
    // POD-1882. Controls that exist to develop PODIUM ITSELF, not to run it:
    // the Development update channel in Settings → Updates and the per-machine
    // update-source selectors in Settings → Machines. `stable` visibility on
    // purpose — a developer's install is usually a released build, so the flag
    // has to be listable there or it could never be turned on. Off by default,
    // and turning it off never discards a stored per-machine override.
    id: 'podium-development',
    name: 'Podium development',
    description:
      'Show controls for developing Podium itself: the Development update channel and per-machine update sources.',
    visibility: 'stable',
  },
  {
    id: 'notifications',
    name: 'Notifications',
    description: 'Enable web and external notifications and their settings.',
    visibility: 'edge',
  },
  {
    id: 'shell-density',
    name: 'Shell density',
    description: 'Choose between balanced and compact shell styling in Appearance.',
    visibility: 'edge',
  },
  {
    // The shipwright repair engine (`apps/server/src/modules/shipping/shipwright.ts`)
    // is COMPLETE AND DORMANT: `ShipwrightService` is constructed nowhere outside its
    // own test, and the shipping service never names it. So the account this control
    // writes to `roles.shipwright` is a preference nothing reads.
    //
    // `hidden` rather than `edge` ON PURPOSE — the gate is not about release channel
    // but about whether the reader can act on what they see. An edge user toggling an
    // account for an engine that cannot run is offered a decision with no effect,
    // which is worse than an absent control. Dev installs get it so the picker stays
    // exercisable while the real shipwright UI is built; that UI is what should widen
    // this, in the same change that wires the engine up.
    id: 'shipwright',
    name: 'Shipwright',
    description:
      'Show the Shipwright account picker in Superagent settings. The bounded shipping-repair engine is not wired up yet, so the chosen account is stored but never used.',
    visibility: 'hidden',
  },
] as const satisfies readonly FeatureDefinition[]

export type FeatureId = (typeof FEATURES)[number]['id']

export interface FeatureResolveInput {
  /** config.json features[id] */
  configValue?: boolean
  /** settings.experimental[id] */
  userValue?: boolean
  channel: 'stable' | 'edge'
  devMode: boolean
  /** Packaged development version with the Podium development feature enabled. */
  developmentAudience?: boolean
}

export interface FeatureState {
  /** Appears in Settings → Experimental for this install. */
  listed: boolean
  enabled: boolean
  source: 'config' | 'user' | 'default'
  /** Config override present → UI toggle disabled. */
  locked: boolean
}

/**
 * Pure feature resolve rules [spec:SP-f4b9]:
 * - source dev lists all; development requires its audience; stable lists all
 *   releases; edge requires the edge channel
 * - configValue present → enabled/source/locked from config (force on or off)
 * - else listed && userValue present → user toggle
 * - else default off
 */
export function resolveFeatureState(
  def: FeatureDefinition,
  input: FeatureResolveInput,
): FeatureState {
  const listed =
    input.devMode ||
    (def.visibility === 'development' && input.developmentAudience === true) ||
    def.visibility === 'stable' ||
    (def.visibility === 'edge' && input.channel === 'edge')

  if (input.configValue !== undefined) {
    return {
      listed,
      enabled: input.configValue,
      source: 'config',
      locked: true,
    }
  }

  if (listed && input.userValue !== undefined) {
    return {
      listed,
      enabled: input.userValue,
      source: 'user',
      locked: false,
    }
  }

  return {
    listed,
    enabled: false,
    source: 'default',
    locked: false,
  }
}

// ---------------------------------------------------------------------------
// What a server says about its flags, and what the app resolves from it
// (POD-6677; design POD-5620 §1.6)
// ---------------------------------------------------------------------------

/** One flag as the connected server's build defines it, with its config.json
 *  override when the server's config sets one. */
export interface ServerFeatureFlag extends FeatureDefinition {
  /** config.json `features[id]`: forces the flag on or off and locks its toggle. */
  readonly config?: boolean
}

/**
 * THE SERVER'S OWN FEATURE FACTS, on every connect in `welcome`. They describe
 * the server build and its config, and change only when the server is upgraded
 * or reconfigured; the operator's experimental toggles and the stored update
 * channel are instance preferences and reach the app as the synced
 * `instancePreferences` record. {@link resolveFeatureStates} joins the two.
 */
export interface ServerFeatureFacts {
  /** A source build (no packaged version): every flag is listed. */
  readonly devMode: boolean
  /** A development-channel build: `development` flags are listed once the
   *  instance turns `podium-development` on. */
  readonly developmentBuild: boolean
  /** The update channel the environment or config.json forces, above the
   *  instance preference; absent when neither does. */
  readonly channel?: 'stable' | 'edge' | 'dev'
  /** The flags this build defines, in its registry order. */
  readonly flags: readonly ServerFeatureFlag[]
}

/** One flag resolved: its definition and its state. */
export interface FeatureStateWire extends FeatureState {
  id: string
  name: string
  description: string
  visibility: FeatureVisibility
}

/** Every flag resolved for one install: what Settings → Experimental shows. */
export interface FeatureStates {
  devMode: boolean
  channel: 'stable' | 'edge'
  flags: FeatureStateWire[]
}

/** The instance preferences the resolution reads. */
export interface FeatureInstanceInput {
  /** `experimental`: the operator's toggles. */
  readonly experimental?: Readonly<Record<string, boolean>>
  /** `deployment.updateChannel`: the stored channel, below env and config.json. */
  readonly updateChannel?: 'stable' | 'edge' | 'dev'
}

/**
 * Resolve every flag from the server's facts and the instance's preferences.
 * The server's own gate (`getFeatureStates`) and every app resolve through this
 * one function, so the app and the server never disagree about a flag.
 */
export function resolveFeatureStates(
  facts: ServerFeatureFacts,
  instance: FeatureInstanceInput,
): FeatureStates {
  const { devMode } = facts
  // Release-channel visibility has two tiers, so the `dev` fleet channel
  // (POD-1882) folds into `edge`: it is strictly more permissive than edge.
  const fleetChannel = facts.channel ?? instance.updateChannel ?? 'stable'
  const channel: 'stable' | 'edge' = fleetChannel === 'stable' ? 'stable' : 'edge'
  const user = instance.experimental ?? {}
  const development = facts.flags.find((flag) => flag.id === 'podium-development')
  const developmentAudience =
    facts.developmentBuild &&
    development !== undefined &&
    resolveFeatureState(development, {
      configValue: development.config,
      userValue: user['podium-development'],
      channel,
      devMode,
    }).enabled
  const flags = facts.flags.map((def): FeatureStateWire => {
    const state = resolveFeatureState(def, {
      configValue: def.config,
      userValue: user[def.id],
      channel,
      devMode,
      developmentAudience,
    })
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      visibility: def.visibility,
      ...state,
    }
  })
  return { devMode, channel, flags }
}

/**
 * THE FACTS AN APP USES BEFORE ITS FIRST `welcome` (started offline): this
 * app's own registry, every flag listed and none locked, so each flag follows
 * the operator's saved toggle. Nothing the server's config forces is known
 * until it answers.
 */
export const OFFLINE_FEATURE_FACTS: ServerFeatureFacts = {
  devMode: true,
  developmentBuild: false,
  flags: FEATURES,
}
