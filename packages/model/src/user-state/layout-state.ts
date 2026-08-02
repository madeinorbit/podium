/**
 * PER-USER STATE FAMILY — SIDEBAR AND TAB LAYOUT (POD-1350).
 *
 * ---------------------------------------------------------------------------
 * THE MEMBER `family.ts` RECORDED AS ABSENT, AND WHY IT ARRIVES HERE
 * ---------------------------------------------------------------------------
 * `family.ts`'s {@link PER_USER_STATE_NON_MEMBERS} carried `sidebarAndTabLayout`
 * with the reason *"CLIENT-LOCAL (EngineState UI keys + the `ui` store). Already
 * per-user by construction — one browser profile is one person — so there is no
 * shared row to re-key"*. That was true for single-operator: the layout lived in
 * the replica's ui-state collection and never crossed devices. Multi-user
 * readiness §3.3 and ADR 9 D3 rule 4 put sidebar/tab layout in the per-user
 * family precisely so it FOLLOWS a person across devices, which requires a
 * server row and a command surface. The non-member entry is deleted rather than
 * amended, matching POD-1213's lifecycle for `personalPreferenceKeys`.
 *
 * ---------------------------------------------------------------------------
 * KEY-AT-A-TIME, NOT ONE BLOB PER PERSON
 * ---------------------------------------------------------------------------
 * Same shape as {@link PersonalPreferenceState}: one row per `(userId, key)`.
 * A single layout blob would make concurrent multi-device writes of independent
 * keys (dock tab vs superagent open) last-writer-wins over the whole shell, which
 * is the field-LWW failure the preference half already refused. Per-key rows keep
 * `single-writer` on the natural unit of change.
 *
 * ---------------------------------------------------------------------------
 * THE CLOSED KEY VOCABULARY IS THE POD-403 ROUTING TABLE
 * ---------------------------------------------------------------------------
 * POD-403 owns the ui-state module's TOTAL routing table over every key it
 * persists. The keys admitted HERE are the ones that table must classify as
 * per-user-replicated; the ones listed under {@link DEVICE_LOCAL_UI_KEYS} are
 * the ones it must keep device-local. One shared vocabulary so a key cannot
 * silently live in both homes (POD-403 obligation 2).
 *
 * Values are JSON (`unknown`), like preferences: the leaf shapes belong to the
 * client/ui-state module that already reads them, not a second declaration of
 * every map and enum here.
 */

import { z } from 'zod'
import { UserIdField } from '../ids'
import { perUserKeyOfString } from './session-state'

// ---------------------------------------------------------------------------
// Routing table — one list, shared with POD-403
// ---------------------------------------------------------------------------

/**
 * Exact layout keys that replicate with the owning user.
 *
 * Canonical names are short dotted paths without the legacy `podium.` prefix so
 * storage is not coupled to a client storage brand. POD-403's one-shot migration
 * maps legacy ui-state keys onto these (see {@link LAYOUT_KEY_FROM_LEGACY}).
 */
export const LAYOUT_EXACT_KEYS = [
  /** Right-dock / panel tab selection (`chat` | `files` | …). */
  'dockTab',
  /** Superagent center column open/closed (legacy `podium.superOpen.v2`). */
  'superOpen',
  /** Superagent column mode: open | folded (legacy `podium:superagent:mode`). */
  'superagent.mode',
  /** Right panel tab when the dock is a separate surface (`issue` | `git` | …). */
  'rightPanel',
  /** Per-session terminal presentation: chat vs native map. */
  'panelMode',
  /** Default panel mode for new sessions. */
  'panelModeDefault',
  /** Sidebar chrome layout variant (e.g. unified). */
  'sidebarLayout',
  /** Whether the sidebar rail is collapsed. */
  'sidebar.collapsed',
  /** Legacy sidebar sub-tab when present. */
  'sidebarTab',
  /** Home surface mode preference. */
  'homeMode',
  /** Issues list display mode. */
  'issues.display',
  /** HTML file tab presentation modes, map of tabId → mode. */
  'htmlmode',
  /** Markdown file tab presentation modes, map of tabId → mode. */
  'mdmode',
] as const
export type LayoutExactKey = (typeof LAYOUT_EXACT_KEYS)[number]

/**
 * Prefixes under which dynamic section keys may appear (collapsed folds, dock
 * section open state). A key is admissible when it equals a prefix OR starts
 * with `${prefix}.` — never a free-form string.
 *
 * Sidebar WIDTH is deliberately NOT under `sidebar.` — pixel geometry is
 * device-local (see {@link DEVICE_LOCAL_UI_KEYS}).
 */
export const LAYOUT_KEY_PREFIXES = [
  /** Collapsed / open state of named sidebar sections. */
  'sidebar.section',
  /** Open state of named dock sections. */
  'dock.section',
] as const
export type LayoutKeyPrefix = (typeof LAYOUT_KEY_PREFIXES)[number]

const EXACT_SET: ReadonlySet<string> = new Set(LAYOUT_EXACT_KEYS)

/**
 * Is this string an admissible layout key? Exact match against the closed list,
 * or a dynamic key under an allowed prefix.
 */
export function isLayoutKey(key: string): boolean {
  if (EXACT_SET.has(key)) return true
  for (const prefix of LAYOUT_KEY_PREFIXES) {
    if (key.startsWith(`${prefix}.`) && key.length > prefix.length + 1) return true
  }
  return false
}

/**
 * Legacy ui-state / localStorage keys that map onto a layout exact key. Dynamic
 * prefixes (`podium:sidebar:` section collapses, `podium.dock.section.`) are
 * handled by {@link layoutKeyFromLegacy} rather than this table.
 *
 * Theme keys are intentionally ABSENT: they are the documented pre-auth
 * exception (POD-403) and stay mirrored raw.
 */
export const LAYOUT_KEY_FROM_LEGACY: Readonly<Record<string, LayoutExactKey>> = {
  'podium.dockTab': 'dockTab',
  'podium.superOpen': 'superOpen',
  'podium.superOpen.v2': 'superOpen',
  'podium:superagent:mode': 'superagent.mode',
  'podium.rightPanel': 'rightPanel',
  // panelMode / panelModeDefault are deliberately NOT listed as string literals
  // here: `panel-mode-duality` (POD-329) forbids restating those storage-key
  // spellings outside packages/client-core/src/ui-state.ts. They are mapped in
  // {@link layoutKeyFromLegacy} by composition instead.
  'podium.sidebarLayout': 'sidebarLayout',
  'podium:sidebar:collapsed': 'sidebar.collapsed',
  'podium.sidebarTab': 'sidebarTab',
  'podium.homeMode': 'homeMode',
  'podium.issues.display': 'issues.display',
  'podium.htmlmode': 'htmlmode',
  'podium.mdmode': 'mdmode',
}

/**
 * Map a legacy client ui-state key to a layout row key, or `null` when the key
 * is not replicated layout state (device-local, theme, or unknown).
 */
export function layoutKeyFromLegacy(legacyKey: string): string | null {
  const exact = LAYOUT_KEY_FROM_LEGACY[legacyKey]
  if (exact) return exact
  // panelMode storage keys: sole spelling lives in client-core ui-state
  // (panel-mode-duality audit). Compose the match so this file never restates
  // the storage-key string literal.
  if (legacyKey.startsWith('podium.') && legacyKey.slice('podium.'.length) === 'panelMode') {
    return 'panelMode'
  }
  if (
    legacyKey.startsWith('podium.') &&
    legacyKey.slice('podium.'.length) === 'panelModeDefault'
  ) {
    return 'panelModeDefault'
  }
  // Section collapses: podium:sidebar:<name> except the reserved width/collapsed.
  if (legacyKey.startsWith('podium:sidebar:')) {
    const rest = legacyKey.slice('podium:sidebar:'.length)
    if (!rest || rest === 'width' || rest === 'collapsed')
      return rest === 'collapsed' ? 'sidebar.collapsed' : null
    return `sidebar.section.${rest}`
  }
  if (legacyKey.startsWith('podium.dock.section.')) {
    const rest = legacyKey.slice('podium.dock.section.'.length)
    if (!rest) return null
    return `dock.section.${rest}`
  }
  return null
}

/**
 * Device-local ui-state keys that MUST NOT become layout rows. POD-403's routing
 * table keeps these in the principal-namespaced local store. Listed here so the
 * model and the client answer "where does this key live?" from one place.
 */
export const DEVICE_LOCAL_UI_KEYS = [
  /** Main route / view surface. */
  'podium.view',
  /** Selected worktree path. */
  'podium.selectedWorktree',
  /** Selected issue id. */
  'podium.selectedIssueId',
  /** Split pane A session. */
  'podium.paneA',
  /** Split pane B session. */
  'podium.paneB',
  /** Split on/off and ratio — screen geometry. */
  'podium.split',
  /** Per-worktree dock-shell session attachment (this device's dock). */
  'podium.dockShells',
  /** Recent-files reachability on this device. */
  'podium.recentFiles',
  /** Sidebar pixel width — screen geometry. */
  'podium:sidebar:width',
] as const

/** Pre-auth exception: theme is mirrored raw, never namespaced, never a layout row. */
export const THEME_UI_KEYS = ['podium.theme.preset', 'podium.theme.mode'] as const

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A layout entityId that IS a member of the closed vocabulary. Declared at the
 * model boundary so a free-form or device-local key cannot parse as durable
 * state even when the command schema is bypassed (POD-402 review gap 3).
 */
export const LayoutKeyField = z.string().superRefine((key, ctx) => {
  if (!isLayoutKey(key)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `'${key}' is not a replicated layout key (isLayoutKey) — device-local ` +
        'route/selection/geometry keys have no durable row',
    })
  }
})

/**
 * ONE PERSON'S VALUE FOR ONE LAYOUT KEY — `(userId, entityId)` where
 * `entityId` is a key from {@link isLayoutKey}.
 *
 * An ABSENT ROW means "this person has never set it"; the client falls back to
 * its own default. There is no second spelling: a reset DELETEs the row.
 *
 * `entityId` is REFINED at this schema (not only at the command input) so a
 * free-form or device-local key cannot parse as durable state even if a caller
 * bypasses `layout.set` (POD-402 review gap 3).
 */
export const LayoutState = perUserKeyOfString().extend({
  /** Closed vocabulary — overrides the unbranded string from perUserKeyOfString. */
  entityId: LayoutKeyField,
  /** JSON value at this key. `unknown` on purpose — see the file header. */
  value: z.unknown(),
})
export type LayoutState = z.infer<typeof LayoutState>

/**
 * Wire value of one layout change-row on the metadata feed (entity kind
 * `userLayout`). Carries the owning user so a lagging client that only sees the
 * payload (without parsing the composite id) still knows whose row it is.
 */
export const LayoutWire = z.object({
  /** Owning user — branded so raw-string-entity-ids does not re-grow. */
  userId: UserIdField,
  key: LayoutKeyField,
  value: z.unknown(),
})
export type LayoutWire = z.infer<typeof LayoutWire>

/**
 * Bootstrap / command-response SNAPSHOT for one principal: every layout key
 * they have set, as a plain map. POD-403 hydrates ui-state from this object
 * (one seam, not one row walk). Not a durable shape — the durable unit is
 * {@link LayoutState}. Every key must pass {@link isLayoutKey}.
 */
export const LayoutSnapshot = z.record(z.string(), z.unknown()).superRefine((snap, ctx) => {
  for (const key of Object.keys(snap)) {
    if (!isLayoutKey(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `'${key}' is not a replicated layout key`,
      })
    }
  }
})
export type LayoutSnapshot = z.infer<typeof LayoutSnapshot>

// ---------------------------------------------------------------------------
// Feed row identity — the (userId, key) pair as one change-log entityId
// ---------------------------------------------------------------------------

const LAYOUT_ROW_SEP = '\n'

/**
 * Change-log / feed id for one layout row. Escaped join so a hostile key or
 * userId that contains the separator cannot collide with another pair.
 */
export function layoutRowId(userId: string, key: string): string {
  // Local import-free join: escape \ and sep, then join. Same rules as
  // joinKeyParts — duplicated as two lines so this file stays free of a
  // circular import with ids/keys (layout is a consumer of perUserKey only).
  const esc = (p: string) => p.replaceAll('\\', '\\\\').replaceAll(LAYOUT_ROW_SEP, `\\${LAYOUT_ROW_SEP}`)
  return `${esc(userId)}${LAYOUT_ROW_SEP}${esc(key)}`
}

/** Inverse of {@link layoutRowId}. Throws on a malformed id. */
export function parseLayoutRowId(id: string): { userId: string; key: string } {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== LAYOUT_ROW_SEP) {
        throw new Error(`malformed layout row id: ${JSON.stringify(id)}`)
      }
      current += next
      i += 1
    } else if (ch === LAYOUT_ROW_SEP) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`malformed layout row id: ${JSON.stringify(id)}`)
  }
  return { userId: parts[0]!, key: parts[1]! }
}

/**
 * The layout-half members, as a list so `family.ts` composes rather than
 * redeclares — the shape the session and preference halves already have.
 */
export const LAYOUT_USER_STATE_MEMBERS = [
  {
    name: 'sidebarAndTabLayout',
    schema: LayoutState,
    table: 'user_layout',
  },
] as const
