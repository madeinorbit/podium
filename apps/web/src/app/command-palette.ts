/**
 * Pure command-palette model (no React): the command shape, the cmdk-inspired
 * subsequence scorer, and the grouped filter the palette renders from. Kept
 * separate from CommandPalette.tsx so ranking/grouping is unit-testable.
 */

export type PaletteGroupId = 'navigate' | 'global' | 'session'

export interface PaletteCommand {
  id: string
  group: PaletteGroupId
  label: string
  /** Extra match terms (repo name, agent kind, aliases…) — weighted below label. */
  keywords?: string[]
  /** Right-aligned annotation (e.g. stage, worktree). Display-only, never matched. */
  hint?: string
  run: () => void | Promise<void>
}

export interface PaletteGroup {
  group: PaletteGroupId
  commands: PaletteCommand[]
}

/** Render order of the groups; also the tiebreak order when scores collide. */
const GROUP_ORDER: PaletteGroupId[] = ['navigate', 'global', 'session']

/** Navigate can be huge (every session/worktree/issue); the rest are small. */
const NAVIGATE_CAP = 8

/**
 * Subsequence score of `query` against one text. 0 = not a subsequence.
 * cmdk-style shaping: every matched char counts, consecutive matches earn a
 * continuous-run bonus, and a match that starts a word (or the string) earns a
 * boundary bonus — so "wt" prefers "Web Terminal" over "sweatshirt".
 */
function scoreText(query: string, text: string): number {
  const t = text.toLowerCase()
  let score = 0
  let prev = -2
  let from = 0
  for (const ch of query) {
    const idx = t.indexOf(ch, from)
    if (idx === -1) return 0
    score += 1
    if (idx === prev + 1) score += 1 // continuous run
    if (idx === 0 || /[\s\-_/:.]/.test(t[idx - 1] as string)) score += 2 // word-boundary start
    prev = idx
    from = idx + 1
  }
  return score
}

/**
 * Score a command against a query. Label matches are weighted over keyword
 * matches (a keyword hit should never outrank the same-quality label hit).
 * Empty query matches everything at a flat score.
 */
export function scoreCommand(query: string, cmd: PaletteCommand): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const label = scoreText(q, cmd.label) * 2
  let kw = 0
  for (const k of cmd.keywords ?? []) kw = Math.max(kw, scoreText(q, k))
  return Math.max(label, kw)
}

/**
 * Filter + rank commands for rendering: score, sort per group (stable — the
 * caller's order breaks ties), drop empty groups, cap navigate results.
 * Groups always come back in navigate → global → session order.
 */
export function filterCommands(query: string, commands: PaletteCommand[]): PaletteGroup[] {
  const scored = commands
    .map((cmd, order) => ({ cmd, order, score: scoreCommand(query, cmd) }))
    .filter((s) => s.score > 0)
  const groups: PaletteGroup[] = []
  for (const group of GROUP_ORDER) {
    const mine = scored
      .filter((s) => s.cmd.group === group)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((s) => s.cmd)
    const capped = group === 'navigate' ? mine.slice(0, NAVIGATE_CAP) : mine
    if (capped.length > 0) groups.push({ group, commands: capped })
  }
  return groups
}

/** Flat row list in render order — drives the roving highlight index. */
export function flattenGroups(groups: PaletteGroup[]): PaletteCommand[] {
  return groups.flatMap((g) => g.commands)
}

/**
 * Move the roving highlight by `delta`, wrapping across the ends (cmdk-style).
 * `count` includes the always-present fallback row, so it's never 0.
 */
export function moveHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

/**
 * Default highlight after the rows change: the top result — which IS the
 * fallback row when nothing matched (the fallback is appended after `matchCount`
 * real rows, so with zero matches index 0 lands on it and plain Enter spawns).
 */
export function defaultHighlight(_matchCount: number): number {
  return 0
}
