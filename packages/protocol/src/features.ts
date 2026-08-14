/**
 * Experimental feature-flag registry + pure resolver [spec:SP-f4b9].
 *
 * Shared by server and web. Visibility controls where a flag appears in
 * Settings → Experimental; enablement always defaults off unless config or
 * a listed user toggle turns it on.
 */

export type FeatureVisibility = 'hidden' | 'edge' | 'stable'

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
    id: 'sample-experiment',
    name: 'Sample experiment',
    description:
      'Demonstrates the experimental-features system. Does nothing; remove when the first real flag lands.',
    visibility: 'hidden',
  },
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
    id: 'settings-search',
    name: 'Settings search',
    description: 'Show the "Find a setting" filter box in the Settings side nav.',
    visibility: 'stable',
  },
  {
    id: 'command-palette',
    name: 'Cmd+K search',
    description: 'Search and navigate Podium from the Cmd+K command palette.',
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
    id: 'merge-queue',
    name: 'Queues',
    description: 'Show merge and heavy-test queues in the right sidebar.',
    visibility: 'edge',
  },
  {
    id: 'shipping',
    name: 'Shipping',
    description: 'Show durable delivery progress in the right sidebar.',
    visibility: 'edge',
  },
  {
    id: 'tab-splitting',
    name: 'Tab splitting',
    description: 'Show two workspace tabs side by side.',
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
 * - listed = devMode || stable || (edge && channel edge)
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
