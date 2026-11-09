/**
 * PER-USER STATE AS SYNCED RECORDS (ADR 12 D1, POD-6673).
 *
 * Pins, tab orders and personal preferences were per-user rows read by a
 * request and fetched again after every write, so a second device of the same
 * person never heard of a change. Each is now a synced record kind on the feed,
 * visible to its owner only (`per-user-state`), written by generic edits.
 *
 * This file holds their WIRE shapes and FEED IDS. The storage rows stay where
 * they were (`pins`, `tab_order`, `user_preferences`); the server publishes them
 * on the change log and back-fills them at boot.
 *
 *  - `pin`: the record's existence IS the pin. Pin = create, unpin = remove.
 *    Kinds: a panel (session), a worktree, a repo, and an issue (the old
 *    `issue_user_state.pinned_at`, moved here by POD-6692 so there is one pin
 *    mechanism).
 *  - `tabOrder`: the manual session order of one worktree, whole-list
 *    last-writer-wins. An empty order is no record.
 *  - `userPreferences`: ONE record per person. Its fields are the leaf PATHS of
 *    the `personal-preference` tier (`roles.coding.model`, `sidebar.repoSort`),
 *    flat, so each leaf is its own field and field-level last-writer-wins is per
 *    leaf: two devices changing different settings never overwrite each other.
 *    An absent field is "never chosen" and resolves to the default; a reset
 *    clears it. Server secrets are never a leaf of it (`replicates: false`).
 */

import { z } from 'zod'
import { asUserId, type UserId, UserIdField } from '../ids'
import { joinKeyParts, splitKeyParts } from '../ids/keys'
import { PersonalPreferences } from '../settings/preferences'
import { PinKind, perUserKeyOfString } from './session-state'

const ROW_SEP = '\n'

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

/** One pin: `(user, kind, entity)`. `entityId` is a session id (`panel`), an
 *  issue id (`issue`), or a worktree or repo path. */
export const PinWire = perUserKeyOfString().extend({
  kind: PinKind,
  /** When it was pinned: the order pinned things are listed in. */
  pinnedAt: z.string(),
})
export type PinWire = z.infer<typeof PinWire>

export function pinRowId(userId: UserId, kind: PinKind, entityId: string): string {
  return joinKeyParts(ROW_SEP, [userId, kind, entityId])
}

/** Inverse of {@link pinRowId}. Throws on a malformed id or an unknown kind. */
export function parsePinRowId(id: string): { userId: UserId; kind: PinKind; entityId: string } {
  const [user, kind, entityId] = splitKeyParts(ROW_SEP, id, 3) as [string, string, string]
  if (user === '' || entityId === '') throw new Error(`malformed pin row id: ${JSON.stringify(id)}`)
  return { userId: asUserId(user), kind: PinKind.parse(kind), entityId }
}

// ---------------------------------------------------------------------------
// tabOrder
// ---------------------------------------------------------------------------

/** One worktree's manual session order: `(user, worktree path)`. */
export const TabOrderWire = perUserKeyOfString().extend({
  sessionIds: z.array(z.string()).min(1),
})
export type TabOrderWire = z.infer<typeof TabOrderWire>

export function tabOrderRowId(userId: UserId, worktree: string): string {
  return joinKeyParts(ROW_SEP, [userId, worktree])
}

/** Inverse of {@link tabOrderRowId}. Throws on a malformed id. */
export function parseTabOrderRowId(id: string): { userId: UserId; worktree: string } {
  const [user, worktree] = splitKeyParts(ROW_SEP, id, 2) as [string, string]
  if (user === '' || worktree === '') {
    throw new Error(`malformed tab order row id: ${JSON.stringify(id)}`)
  }
  return { userId: asUserId(user), worktree }
}

// ---------------------------------------------------------------------------
// userPreferences
// ---------------------------------------------------------------------------

type ZodDef = { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny }
const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef

/** A leaf's value schema without its default or optional wrapper: an absent
 *  field is "never chosen", never the default spelled out. */
function bare(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = defOf(schema)
  if (def.typeName === 'ZodDefault' || def.typeName === 'ZodOptional') {
    return def.innerType ? bare(def.innerType) : schema
  }
  return schema
}

function leafSchemas(schema: z.ZodTypeAny, prefix: string, out: Map<string, z.ZodTypeAny>): void {
  const inner = bare(schema)
  if (defOf(inner).typeName !== 'ZodObject') {
    out.set(prefix, inner)
    return
  }
  for (const [key, child] of Object.entries((inner as z.AnyZodObject).shape)) {
    if (!prefix && key === 'userId') continue
    leafSchemas(child as z.ZodTypeAny, prefix ? `${prefix}.${key}` : key, out)
  }
}

/**
 * Every personal-preference leaf path with its value schema, walked from
 * {@link PersonalPreferences}: the same walk that classifies the tier
 * (`settings/path-tiers.ts`), so the record's fields and the tier are one list.
 */
export const USER_PREFERENCE_LEAVES: ReadonlyMap<string, z.ZodTypeAny> = (() => {
  const out = new Map<string, z.ZodTypeAny>()
  leafSchemas(PersonalPreferences, '', out)
  return out
})()

/** The record: the owner, then each leaf path the person has chosen. */
export const UserPreferencesWire = z
  .object({
    userId: UserIdField,
    ...Object.fromEntries([...USER_PREFERENCE_LEAVES].map(([path, s]) => [path, s.optional()])),
  })
  .strict()
export type UserPreferencesWire = { readonly userId: UserId } & Readonly<Record<string, unknown>>

/** One record per person: its feed id is the user id. */
export const userPreferencesRowId = (userId: UserId): string => userId

export function parseUserPreferencesRowId(id: string): { userId: UserId } {
  if (id === '') throw new Error('malformed user preferences row id: empty')
  return { userId: asUserId(id) }
}

/** Fold a record's chosen leaves onto the defaults: the resolved preferences. */
export function resolveUserPreferences(
  wire: Readonly<Record<string, unknown>> | undefined,
  userId: UserId,
): PersonalPreferences {
  const nested: Record<string, unknown> = { userId }
  for (const path of USER_PREFERENCE_LEAVES.keys()) {
    const value = wire?.[path]
    if (value === undefined) continue
    const parts = path.split('.')
    const leaf = parts.pop()
    if (leaf === undefined) continue
    let at = nested
    for (const part of parts) {
      const next = at[part]
      if (next === null || typeof next !== 'object') at[part] = {}
      at = at[part] as Record<string, unknown>
    }
    at[leaf] = value
  }
  const parsed = PersonalPreferences.safeParse(nested)
  return parsed.success ? parsed.data : PersonalPreferences.parse({ userId })
}
