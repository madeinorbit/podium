/**
 * AGENT PROFILES — a named agent setup that issues and sessions point at
 * (flight deck v6, decisions D3 and D4 in docs/design/flight-deck-v6/ANALYSIS.md).
 *
 * A profile holds an ordered list of (harness, model, effort) CANDIDATES, an
 * optional machine and optional markdown instructions. An issue or a session
 * carries an optional profile id plus its own agent/model/effort/machine fields,
 * and the effective setup is the profile with those fields applied ON TOP. That
 * rule lives in exactly one place, {@link resolveAgentSetup}, so the server's
 * launch paths and any client that previews "what will this run" agree.
 *
 * The first USABLE candidate is picked when a session starts and never again: a
 * session does not switch harness mid-run, so a usage limit shows as an error
 * rather than a silent fallback. Usability is a machine fact (is the harness
 * installed and logged in there), so the pick itself is the server's — this
 * module only orders the list ({@link pickAgentCandidate} takes the predicate).
 *
 * The markdown form ({@link parseAgentProfileMarkdown} /
 * {@link formatAgentProfileMarkdown}) is the import/export shape: a Claude Code
 * agent file (`.podium/agents/<name>.md`, YAML-ish frontmatter plus a body),
 * read with a deliberately small parser because this package may depend on
 * nothing but zod.
 */

import { z } from 'zod'
import { HarnessAgent } from './agent'

/** Lowercase slug: it is also the file name in `.podium/agents/<name>.md`. */
export const AGENT_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export const AgentProfileName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    AGENT_PROFILE_NAME_PATTERN,
    'a profile name is lowercase letters, digits and dashes (e.g. "build"), at most 63 characters',
  )

/** A field value that means "not set here": the profile (or the default) decides. */
export const AGENT_FIELD_UNSET = 'auto'

export function isAgentFieldSet(value: string | null | undefined): value is string {
  return value != null && value.trim() !== '' && value !== AGENT_FIELD_UNSET
}

export const AgentCandidate = z.object({
  harness: HarnessAgent,
  model: z.string().trim().min(1).max(200).default(AGENT_FIELD_UNSET),
  effort: z.string().trim().min(1).max(40).default(AGENT_FIELD_UNSET),
})
export type AgentCandidate = z.infer<typeof AgentCandidate>

export const MAX_AGENT_PROFILE_CANDIDATES = 8
export const MAX_AGENT_PROFILE_INSTRUCTIONS = 20_000

export const AgentCandidates = z.array(AgentCandidate).max(MAX_AGENT_PROFILE_CANDIDATES)

export const AgentProfileWire = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  candidates: AgentCandidates,
  /** Machine id, or null for "wherever the issue or session would run". */
  machineId: z.string().nullable(),
  instructions: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentProfileWire = z.infer<typeof AgentProfileWire>

/** The fields an issue or a session carries next to its optional profile. */
export interface AgentSetupFields {
  agent?: string | null
  model?: string | null
  effort?: string | null
  machineId?: string | null
}

/** One candidate after the overrides. `harness` may be `auto` (the Settings default). */
export interface ResolvedAgentCandidate {
  harness: string
  model: string
  effort: string
}

export interface AgentSetup {
  profile: { id: string; name: string } | null
  /** Never empty: the last resort is one all-`auto` candidate. */
  candidates: ResolvedAgentCandidate[]
  machineId: string | null
  instructions: string
}

/**
 * THE ONE RESOLVER: the profile, with the issue's or session's own fields on top.
 *
 * - An `agent` override keeps the profile's candidates for that harness, in
 *   order; when the profile has none for it, the override is the only candidate.
 * - A `model` or `effort` override replaces that value on every remaining
 *   candidate.
 * - `machineId` overrides the profile's machine.
 * - A field is "set" only when it is non-empty and not `auto`.
 */
export function resolveAgentSetup(
  profile: Pick<
    AgentProfileWire,
    'id' | 'name' | 'candidates' | 'machineId' | 'instructions'
  > | null,
  fields: AgentSetupFields,
): AgentSetup {
  let candidates: ResolvedAgentCandidate[] = (profile?.candidates ?? []).map((c) => ({ ...c }))
  if (isAgentFieldSet(fields.agent)) {
    const agent = fields.agent
    const matching = candidates.filter((c) => c.harness === agent)
    candidates =
      matching.length > 0
        ? matching
        : [{ harness: agent, model: AGENT_FIELD_UNSET, effort: AGENT_FIELD_UNSET }]
  }
  if (candidates.length === 0) {
    candidates = [
      { harness: AGENT_FIELD_UNSET, model: AGENT_FIELD_UNSET, effort: AGENT_FIELD_UNSET },
    ]
  }
  const model = fields.model
  const effort = fields.effort
  if (isAgentFieldSet(model)) candidates = candidates.map((c) => ({ ...c, model }))
  if (isAgentFieldSet(effort)) candidates = candidates.map((c) => ({ ...c, effort }))
  return {
    profile: profile ? { id: profile.id, name: profile.name } : null,
    candidates,
    machineId: fields.machineId ?? profile?.machineId ?? null,
    instructions: profile?.instructions.trim() ?? '',
  }
}

/**
 * The first candidate `usable` accepts, else the first candidate — so the start
 * then fails with the real reason the preferred harness cannot run, rather than
 * a generic "nothing usable".
 */
export async function pickAgentCandidate(
  candidates: readonly ResolvedAgentCandidate[],
  usable: (candidate: ResolvedAgentCandidate) => boolean | Promise<boolean>,
): Promise<{ candidate: ResolvedAgentCandidate; index: number; usable: boolean }> {
  for (const [index, candidate] of candidates.entries()) {
    if (await usable(candidate)) return { candidate, index, usable: true }
  }
  const first = candidates[0]
  if (!first) throw new Error('an agent setup always has at least one candidate')
  return { candidate: first, index: 0, usable: false }
}

/** One-line summary for CLI output: `claude-code/auto/high, codex/gpt-6/xhigh`. */
export function formatAgentCandidates(candidates: readonly ResolvedAgentCandidate[]): string {
  return candidates.map((c) => `${c.harness}/${c.model}/${c.effort}`).join(', ')
}

// ---------------------------------------------------------------------------
// The `.podium/agents/<name>.md` shape
// ---------------------------------------------------------------------------

/** What a profile file says, before the server resolves `machine` to an id. */
export interface AgentProfileDocument {
  name: string
  description: string
  candidates: AgentCandidate[]
  /** A machine name or id, as written. */
  machine: string | null
  instructions: string
}

export class AgentProfileDocumentError extends Error {}

const unquote = (raw: string): string => {
  const v = raw.trim()
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1).replaceAll("''", "'")
  }
  return v
}

/** Quote a scalar only when a plain one would be misread. */
const scalar = (value: string): string =>
  /^[\w./@+-][\w ./@+()-]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value)

/**
 * Read a profile file. Accepts the exported shape (a `candidates:` list of
 * `harness`/`model`/`effort` maps) and, for a plain Claude Code agent file, a
 * top-level `harness`/`model`/`effort` (a file with only `model:` is a
 * claude-code candidate). Unknown keys such as `tools` are ignored.
 *
 * `fallbackName` is the file name without `.md`, used when there is no `name:`.
 */
export function parseAgentProfileMarkdown(
  text: string,
  fallbackName?: string,
): AgentProfileDocument {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized)
  if (!match)
    throw new AgentProfileDocumentError('a profile file starts with a --- frontmatter block')
  const [, front = '', body = ''] = match
  const top = new Map<string, string>()
  const rawCandidates: Array<Record<string, string>> = []
  let inCandidates = false
  for (const [i, line] of front.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indented = /^\s/.test(line)
    if (!indented) {
      const kv = /^([A-Za-z_][\w-]*):(.*)$/.exec(line)
      if (!kv) throw new AgentProfileDocumentError(`frontmatter line ${i + 1} is not "key: value"`)
      const key = kv[1] as string
      const value = (kv[2] ?? '').trim()
      inCandidates = key === 'candidates'
      if (inCandidates) {
        if (value && value !== '[]') {
          throw new AgentProfileDocumentError(
            'candidates is a list: one "- harness: …" item per line',
          )
        }
        continue
      }
      top.set(key, unquote(value))
      continue
    }
    if (!inCandidates) continue
    const item = /^\s*(-\s+)?([A-Za-z_][\w-]*):(.*)$/.exec(line)
    if (!item)
      throw new AgentProfileDocumentError(`frontmatter line ${i + 1} is not a candidate field`)
    if (item[1] || rawCandidates.length === 0) rawCandidates.push({})
    ;(rawCandidates.at(-1) as Record<string, string>)[item[2] as string] = unquote(item[3] ?? '')
  }
  if (rawCandidates.length === 0 && (top.has('harness') || top.has('model') || top.has('effort'))) {
    rawCandidates.push({
      harness: top.get('harness') ?? 'claude-code',
      ...(top.has('model') ? { model: top.get('model') as string } : {}),
      ...(top.has('effort') ? { effort: top.get('effort') as string } : {}),
    })
  }
  const name = AgentProfileName.safeParse(top.get('name') ?? fallbackName ?? '')
  if (!name.success) {
    throw new AgentProfileDocumentError(name.error.issues[0]?.message ?? 'the profile needs a name')
  }
  const candidates = AgentCandidates.safeParse(rawCandidates)
  if (!candidates.success) {
    const issue = candidates.error.issues[0]
    throw new AgentProfileDocumentError(
      `candidate ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'} (harness is one of ${HarnessAgent.options.join(', ')})`,
    )
  }
  const machine = top.get('machine')?.trim()
  return {
    name: name.data,
    description: top.get('description') ?? '',
    candidates: candidates.data,
    machine: machine ? machine : null,
    instructions: body.trim(),
  }
}

/** Write a profile file; `machine` is the name to show (not necessarily the id). */
export function formatAgentProfileMarkdown(doc: AgentProfileDocument): string {
  const lines = ['---', `name: ${doc.name}`]
  if (doc.description) lines.push(`description: ${scalar(doc.description)}`)
  if (doc.candidates.length > 0) {
    lines.push('candidates:')
    for (const c of doc.candidates) {
      lines.push(
        `  - harness: ${c.harness}`,
        `    model: ${scalar(c.model)}`,
        `    effort: ${scalar(c.effort)}`,
      )
    }
  }
  if (doc.machine) lines.push(`machine: ${scalar(doc.machine)}`)
  lines.push('---')
  return `${lines.join('\n')}\n${doc.instructions.trim() ? `\n${doc.instructions.trim()}\n` : ''}`
}
