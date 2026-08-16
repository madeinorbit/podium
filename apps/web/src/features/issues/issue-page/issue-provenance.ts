/**
 * MACHINE VOICE → HUMAN SENTENCE, FOR THE RAIL'S ORIGIN BLOCK.
 *
 * The page used to print the raw pair mid-document: `Published by user:sole ·
 * for user:sole`. Every word of that is a field name or an id namespace, and on
 * the overwhelmingly common row — a person acting for themselves — it says the
 * same thing twice and means nothing to the reader. This module turns the
 * server's vocabularies into what they actually say, once, so the rendering
 * stays a lookup and the wording stays testable.
 *
 * -------------------------------------------------------------------------
 * TRANSLATION, NOT SYNTHESIS.
 * -------------------------------------------------------------------------
 *
 * docs/multi-user-readiness.md §3.1.3 A3 forbids INVENTING either half of the
 * attribution pair, and nothing here does: every phrase below is a total
 * function of a field the server stamped, and a row that carries no pair gets
 * no phrase (`createdByPhrase` is only ever called with one). What changes is
 * the WORDING, which was never the server's to own.
 *
 * The one collapse worth naming: when the actor is a person acting for
 * themselves, the on-behalf-of half is dropped. That is not hiding a fact — the
 * two halves are equal, and `for X` after `X` is noise. As soon as they differ,
 * both are shown, which is the case the pair exists to distinguish.
 *
 * `origin` and `audience` are SEPARATE fields from the pair (`'human' |
 * 'agent'` each), so they get their own phrases rather than being folded into
 * it. `origin` is the coarse fallback for a row too old to carry `createdBy`:
 * it genuinely says "a person" or "an agent" and claims no id, which is exactly
 * how it is worded.
 */
import { type Attribution, actorDisplayId } from '@podium/model/browser'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An id as a reader says it: the `user:` namespace dropped, a uuid cut to its
 * leading segment.
 *
 * Safe for the same reason `AttributionPair`'s `shortenId` is: `actorDisplayId`
 * is display-only and deliberately non-round-trippable, so nothing may compare
 * or gate on this string. Every call site keeps the full value in `title`.
 */
export function humanizeActorId(id: string): string {
  const bare = id.startsWith('user:') ? id.slice('user:'.length) : id
  return UUID_RE.test(bare) ? bare.slice(0, 8) : bare
}

/** The actor half as a noun phrase. A person is named; everything else is named
 *  AND typed, because "who did this" and "was it a person" are one question for
 *  a human reader and two fields underneath. */
function actorPhrase(actor: Attribution['actor']): string {
  const id = humanizeActorId(actorDisplayId(actor))
  switch (actor.kind) {
    case 'user':
      return id
    case 'agent':
      return `Agent ${id}`
    case 'machine':
      return `Machine ${id}`
    case 'system':
      return `System job ${id}`
  }
}

/**
 * The whole pair as one line of English.
 *
 * TWO COLLAPSES, AND NEITHER DROPS A FACT.
 *
 * 1. A PERSON is never annotated with an on-behalf-of half that repeats them or
 *    contradicts them. `user:sole` acting for `user:sole` is `sole`, and a
 *    person acting with `onBehalfOf: null` is ALSO just that person: ADR 9 D8
 *    S5's "acts for no human" describes a MACHINE or a SYSTEM JOB, and printing
 *    it beside a person's name says something false about a row where the actor
 *    IS the human. As soon as a person acted for a DIFFERENT person, both names
 *    are shown — that is the case the pair exists to distinguish, and it is the
 *    one thing neither collapse touches.
 *
 * 2. A NON-PERSON actor with `onBehalfOf: null` keeps the phrase, because there
 *    it is the stamped fact: nobody delegated this write. Absence of a human
 *    and absence of a value are different, and only the first is representable.
 */
export function createdByPhrase(attribution: Attribution): string {
  const { actor, onBehalfOf } = attribution
  const who = actorPhrase(actor)
  if (onBehalfOf === null) return actor.kind === 'user' ? who : `${who} · no human`
  const human = humanizeActorId(onBehalfOf)
  if (actor.kind === 'user' && humanizeActorId(actorDisplayId(actor)) === human) return who
  return `${who}, for ${human}`
}

/** The hover title for a created-by line: the ids exactly as stamped, including
 *  the half a collapse left out of the visible phrase. */
export function createdByTitle(attribution: Attribution): string {
  const { actor, onBehalfOf } = attribution
  const who = `Actor — who did this: ${actorDisplayId(actor)} (${actor.kind})`
  if (onBehalfOf !== null) return `${who}\nOn behalf of — whose work this is: ${onBehalfOf}`
  return actor.kind === 'user'
    ? `${who}\nNo separate on-behalf-of was recorded — this person acted for themselves.`
    : `${who}\nA machine or system job acts for no human (ADR 9 D8 S5)`
}

/** The coarse fallback when a row predates `createdBy`. It names no id because
 *  `origin` carries none. */
export const ORIGIN_PHRASE: Record<string, string> = {
  human: 'A person',
  agent: 'An agent',
}

/** `audience` decides whether a row is board work or an agent's own working
 *  detail — the fact behind the `internal` chip under the title. */
export const AUDIENCE_PHRASE: Record<string, string> = {
  human: 'People',
  agent: 'Agents only',
}

export const AUDIENCE_TITLE: Record<string, string> = {
  human: 'Ordinary work — this task appears on the board',
  agent: 'Agent-internal working detail, kept off the board',
}

/** ADR 9 D3's five visibility classes, said plainly. Issues are personal-class
 *  today; the other four are named rather than left to leak their slug if a
 *  future class ever reaches this surface. */
export const VISIBILITY_PHRASE: Record<string, string> = {
  personal: 'Private to its owner',
  'per-user-state': 'Per-user state',
  'owned-compute': 'Owned compute',
  'deployment-substrate': 'Shared infrastructure',
  secret: 'Secret',
}

/** A lookup that never hides an unknown value: an unmapped class shows its own
 *  slug rather than nothing, so a new server vocabulary is visible instead of
 *  silently blank. */
export function phraseOr(table: Record<string, string>, value: string | undefined): string {
  if (!value) return ''
  return table[value] ?? value
}
