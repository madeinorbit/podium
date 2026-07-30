/**
 * THE ROUTER `.mutation(` CENSUS (POD-386) — the repo-wide half of the 3.3d audit.
 *
 * Run:
 *   bun run audit:router-mutations             # the gate — exit 1 on any finding
 *   bun run audit:router-mutations --json
 *   bun run audit:router-mutations --probe     # prove every check can say YES
 *   bun scripts/audit-router-mutations.ts --update-census   # regenerate (read below first)
 *
 * ---------------------------------------------------------------------------
 * WHY A CENSUS AND NOT SIX MORE ABSENCE CHECKS
 * ---------------------------------------------------------------------------
 *
 * Each migrated family already has its own audit — `audit:sessions`,
 * `audit:workflows`, `audit:issues`, `audit:mail`, `audit:superagent`,
 * `audit:fleet`, `audit:spec` — and each says "no hand-written `.mutation(` in
 * MY routers". Every one of those is true of a router.ts that grew a brand-new
 * `credentials: t.router({ … })` full of hand-written writes, because no audit
 * owns a router nobody has claimed yet. Seven local absence claims do not
 * compose into a global one.
 *
 * So this reads the WHOLE file: every top-level `<name>: t.router(` literal is
 * accounted for exactly once, either as a family whose writes are DERIVED or as
 * a `pending` entry listing the hand-written keys it still carries and the issue
 * that owns them. A router in neither list is a finding, which is the check the
 * per-family audits structurally cannot make.
 *
 * ---------------------------------------------------------------------------
 * THE CENSUS IS CHECKED IN BOTH DIRECTIONS, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * A key in the router and not in the census is an ADDED hand-written write — the
 * regression. A key in the census and not in the router is a census that has
 * ROTTED: the count still reads 31 while the code moved, and a ratchet nobody
 * can trust is worse than no ratchet. Both are findings.
 *
 * This is also why the `total` is compared and not merely recomputed. POD-1180's
 * lesson is that a shrinking number proves nothing on its own — an extraction
 * into another file reads as a win with nothing deleted. Here the count is
 * ratcheted (may only go DOWN) AND the membership is named, so a decrease has to
 * say WHICH key vanished before it is accepted.
 *
 * ---------------------------------------------------------------------------
 * THE SETTINGS GUARD
 * ---------------------------------------------------------------------------
 *
 * POD-313's title carves settings out of phase 3.3 explicitly — "settings via
 * #352" — so this issue's obligation for `settings` is that it is UNTOUCHED,
 * which is not the same claim as any other entry here. A `guard: true` entry is
 * checked in both directions with no ratchet relief: removing a settings write
 * is as much a finding as adding one, because a cutover that quietly absorbed
 * settings would otherwise read as progress.
 *
 * `apps/server/src/router.settings-guard.test.ts` makes the same claim against
 * the RUNNING router object and against the contract tables. Two instruments,
 * because this one resolves no modules and that one cannot run in a fresh
 * checkout.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Most of what follows is an absence or an equality claim, which is exactly what
 * a broken parser reports. `probe()` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it; each is
 * also run against a clean fixture and must find nothing. It runs FIRST, always,
 * with or without the flag.
 *
 * The parser itself gets the same treatment: `PROBE_ROUTER_SOURCE` contains a
 * nested `t.router(`, a comment mentioning `.mutation(`, a mutation written
 * AFTER a nested block closes, and a router with no writes at all — the four
 * shapes a naive line scan gets wrong.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  check: string
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROUTER = 'apps/server/src/router.ts'
const CENSUS = 'scripts/router-mutation-census.json'
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

// ---------------------------------------------------------------------------
// The census file's shape
// ---------------------------------------------------------------------------

export interface Census {
  total: number
  migrated: { routers: string[]; allowed: Record<string, string[] | undefined> }
  pending: Record<string, { owner?: string; guard?: boolean; keys?: string[] } | undefined>
}

/** `$note`/`$schema` keys are documentation and never router names. */
const isMeta = (key: string): boolean => key.startsWith('$')

export function parseCensus(json: string): Census {
  const raw = JSON.parse(json) as Record<string, unknown>
  const migrated = (raw.migrated ?? {}) as Record<string, unknown>
  const pending = (raw.pending ?? {}) as Record<string, unknown>
  return {
    total: typeof raw.total === 'number' ? raw.total : Number.NaN,
    migrated: {
      routers: Array.isArray(migrated.routers) ? (migrated.routers as string[]) : [],
      allowed: Object.fromEntries(
        Object.entries((migrated.allowed ?? {}) as Record<string, unknown>)
          .filter(([k]) => !isMeta(k))
          .map(([k, v]) => [k, Array.isArray(v) ? (v as string[]) : []]),
      ),
    },
    pending: Object.fromEntries(
      Object.entries(pending)
        .filter(([k]) => !isMeta(k))
        .map(([k, v]) => [k, v as { owner?: string; guard?: boolean; keys?: string[] }]),
    ),
  }
}

// ---------------------------------------------------------------------------
// The parser — brace matching, because a line scan gets four shapes wrong
// ---------------------------------------------------------------------------

export interface RouterBlock {
  name: string
  startLine: number
  /** The hand-written `.mutation(` keys, in source order, with duplicates kept:
   *  two writes under one key is itself worth seeing. */
  keys: string[]
  lines: number[]
}

/**
 * Every TOP-LEVEL `  <name>: t.router(` literal, with the `.mutation(` keys
 * inside it — including inside any nested `t.router(` it contains, because a
 * write hidden one level down is still a hand-written write on this surface.
 *
 * Comments are stripped first. `router.ts` documents this exact pattern in
 * several places ("there is deliberately no `.mutation(` for a session"), and a
 * scanner that counts its own documentation is an instrument that cannot say NO.
 * Strings are stripped with them so a `.mutation(` inside a message literal
 * cannot fire either.
 */
export function parseRouterBlocks(source: string): RouterBlock[] {
  const stripped = stripCommentsAndStrings(source)
  const blocks: RouterBlock[] = []
  for (const match of stripped.matchAll(/^ {2}(\w+): t\.router\(/gm)) {
    const open = stripped.indexOf('(', match.index + match[0].length - 1)
    let depth = 0
    let close = -1
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === '(') depth++
      else if (stripped[i] === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) continue
    const text = stripped.slice(open, close + 1)
    const depths = depthMap(text)
    const candidates = [...text.matchAll(/[\n{,]\s*(\w+):/g)].map((m) => ({
      key: m[1] as string,
      // The key's own nesting depth is the depth just after the `:` — i.e. where
      // its VALUE begins — which is the depth its procedure body returns to.
      depth: depths[m.index + m[0].length - 1] ?? 0,
      index: m.index,
    }))
    const keys: string[] = []
    const lines: number[] = []
    for (const m of text.matchAll(/\.mutation\(/g)) {
      keys.push(keyAbove(candidates, depths[m.index] ?? 0, m.index))
      lines.push(lineOf(stripped, open + m.index))
    }
    blocks.push({
      name: match[1] as string,
      startLine: lineOf(stripped, match.index),
      keys,
      lines,
    })
  }
  return blocks
}

/**
 * Blank out `//` and block comments and the contents of string/template
 * literals, PRESERVING newlines so every line number stays truthful. Byte
 * offsets are preserved too, which is why this replaces rather than deletes.
 */
export function stripCommentsAndStrings(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? source.length : end + 2)
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      let j = i + 1
      while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/** The `{`/`(` nesting depth at every byte of `text`. */
function depthMap(text: string): number[] {
  const depths = new Array<number>(text.length)
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === ')' || c === '}') depth--
    depths[i] = depth
    if (c === '(' || c === '{') depth++
  }
  return depths
}

/**
 * The procedure key a `.mutation(` belongs to — NOT simply the nearest `<key>:`
 * above it, which is the bug this function exists to avoid.
 *
 * `setMeta: t.procedure.input(z.object({ summary: … })).mutation(…)` has
 * `summary` as its nearest preceding key, and an indentation-based reader
 * reports that: the census then names schema FIELDS as procedures and the
 * both-directions check fires on four routers that never changed. Anchoring on a
 * fixed indentation (the per-family audits' `\n\s{4}(\w+):`) avoids it only
 * because those routers happen to be flat, and goes wrong the moment a write
 * lives one router down.
 *
 * So the key is chosen by DEPTH: of the keys before the mutation, the last one
 * whose value begins at a depth no deeper than the mutation's own. A schema
 * field is strictly deeper — the input object has been closed again by the time
 * `.mutation(` is reached — and a nested router's key is at the mutation's
 * depth, which is exactly right.
 */
function keyAbove(
  candidates: Array<{ key: string; depth: number; index: number }>,
  mutationDepth: number,
  mutationIndex: number,
): string {
  let found = '?'
  for (const c of candidates) {
    if (c.index >= mutationIndex) break
    if (c.depth <= mutationDepth) found = c.key
  }
  return found
}

// ---------------------------------------------------------------------------
// 1 — every router is accounted for, exactly once
// ---------------------------------------------------------------------------

export function uncensusedRouters(blocks: RouterBlock[], census: Census, where: string): Finding[] {
  const findings: Finding[] = []
  const migrated = new Set(census.migrated.routers)
  for (const block of blocks) {
    const inPending = Object.hasOwn(census.pending, block.name)
    if (migrated.has(block.name) && inPending) {
      findings.push({
        check: 'census-membership',
        where: `${where}:${block.startLine}`,
        detail:
          `\`${block.name}\` is listed as BOTH migrated and pending — it cannot be both, and a ` +
          'router counted twice makes the total meaningless',
      })
    } else if (!migrated.has(block.name) && !inPending) {
      findings.push({
        check: 'census-membership',
        where: `${where}:${block.startLine}`,
        detail:
          `the \`${block.name}\` router is in neither census list — a new router is exactly what ` +
          'the seven per-family audits structurally cannot see, which is why this one reads the ' +
          'whole file',
      })
    }
  }
  const present = new Set(blocks.map((b) => b.name))
  for (const name of [...migrated, ...Object.keys(census.pending)]) {
    if (!present.has(name)) {
      findings.push({
        check: 'census-membership',
        where: CENSUS,
        detail:
          `the census names a \`${name}\` router that no longer exists in ${where} — a census ` +
          'that has rotted cannot be evidence for anything',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — a derived family carries no hand-written write
// ---------------------------------------------------------------------------

export function writesInMigratedRouters(
  blocks: RouterBlock[],
  census: Census,
  where: string,
): Finding[] {
  const findings: Finding[] = []
  const migrated = new Set(census.migrated.routers)
  for (const block of blocks) {
    if (!migrated.has(block.name)) continue
    const allowed = census.migrated.allowed[block.name] ?? []
    block.keys.forEach((key, i) => {
      if (allowed.includes(key)) return
      findings.push({
        check: 'derived-family-clean',
        where: `${where}:${block.lines[i]}`,
        detail:
          `hand-written \`.mutation(\` for \`${block.name}.${key}\` in a DERIVED family — its ` +
          'writes come from a contract table, and a procedure written beside them is a second ' +
          'answer to "how is this authorized"',
      })
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — a pending router carries exactly the writes the census names
// ---------------------------------------------------------------------------

export function pendingDrift(blocks: RouterBlock[], census: Census, where: string): Finding[] {
  const findings: Finding[] = []
  for (const block of blocks) {
    const entry = census.pending[block.name]
    if (!entry) continue
    const expected = entry.keys ?? []
    const owner = entry.owner ? ` (owned by ${entry.owner})` : ''
    const counted = new Map<string, number>()
    for (const k of block.keys) counted.set(k, (counted.get(k) ?? 0) + 1)
    const wanted = new Map<string, number>()
    for (const k of expected) wanted.set(k, (wanted.get(k) ?? 0) + 1)

    for (const [key, n] of counted) {
      const want = wanted.get(key) ?? 0
      if (n > want) {
        const i = block.keys.indexOf(key)
        findings.push({
          check: entry.guard ? 'settings-guard' : 'pending-census',
          where: `${where}:${block.lines[i]}`,
          detail: entry.guard
            ? `\`${block.name}.${key}\` is a hand-written write the guard does not list${owner}. ` +
              'Settings is carved out of phase 3.3 by POD-313’s own title — this issue’s claim is ' +
              'that it is UNTOUCHED, so a write appearing here fails in the same direction as one ' +
              'disappearing.'
            : `\`${block.name}.${key}\` is a hand-written write the census does not list${owner} — ` +
              'the census may shrink as migrations land, never grow',
        })
      }
    }
    for (const [key, n] of wanted) {
      const have = counted.get(key) ?? 0
      if (have >= n) continue
      findings.push({
        check: entry.guard ? 'settings-guard' : 'pending-census',
        where: `${where}:${block.startLine}`,
        detail: entry.guard
          ? `\`${block.name}.${key}\` is GONE from the router${owner}. Settings is not this ` +
            'phase’s to migrate: a cutover that quietly absorbed it would read as progress, so ' +
            'the guard fails on a removal exactly as it does on an addition.'
          : `\`${block.name}.${key}\` is in the census but not in the router${owner} — either the ` +
            'migration landed and the census was not updated, or the write moved somewhere this ' +
            'scan cannot see (POD-1180). Say which.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — the ratchet
// ---------------------------------------------------------------------------

export function ratchet(blocks: RouterBlock[], census: Census): Finding[] {
  const total = blocks.reduce((n, b) => n + b.keys.length, 0)
  if (Number.isNaN(census.total)) {
    return [
      {
        check: 'ratchet',
        where: CENSUS,
        detail: 'the census declares no numeric `total` — there is nothing to ratchet against',
      },
    ]
  }
  if (total > census.total) {
    return [
      {
        check: 'ratchet',
        where: CENSUS,
        detail:
          `${total} hand-written \`.mutation(\` in ${ROUTER}, up from the census's ` +
          `${census.total}. This number may only go DOWN.`,
      },
    ]
  }
  if (total < census.total) {
    return [
      {
        check: 'ratchet',
        where: CENSUS,
        detail:
          `${total} hand-written \`.mutation(\` in ${ROUTER}, DOWN from ${census.total} — the ` +
          'ratchet tightened, which is good, but the census must record it. Run ' +
          '`bun scripts/audit-router-mutations.ts --update-census` and name the keys that ' +
          'vanished in the commit message.',
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditRouterMutations(source: string, censusJson: string): Finding[] {
  const blocks = parseRouterBlocks(source)
  const census = parseCensus(censusJson)
  return [
    ...uncensusedRouters(blocks, census, ROUTER),
    ...writesInMigratedRouters(blocks, census, ROUTER),
    ...pendingDrift(blocks, census, ROUTER),
    ...ratchet(blocks, census),
  ]
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * The five shapes a naive scanner gets wrong, in one fixture:
 *   · `alpha` documents `.mutation(` in a COMMENT and in a STRING — neither counts
 *   · `alpha` nests a `t.router(` and writes a mutation AFTER it closes
 *   · `beta` has no writes at all
 *   · `gamma` writes one at the very END of its block
 *   · `gamma.shaped` carries an inline `z.object({ … })` whose LAST FIELD is the
 *     nearest preceding `<key>:` — an indentation reader names the field, and the
 *     census then lists schema fields as procedures. That is not hypothetical:
 *     four of router.ts's own routers have this shape.
 */
const PROBE_ROUTER_SOURCE = [
  'export const appRouter = t.router({',
  '  alpha: t.router({',
  '    // there is deliberately no .mutation( for an alpha anywhere in this file',
  "    note: t.procedure.query(() => 'a .mutation( inside a string literal'),",
  '    nested: t.router({',
  '      deep: t.procedure.mutation(() => 1),',
  '    }),',
  '    after: t.procedure.mutation(() => 2),',
  '  }),',
  '  beta: t.router({',
  '    list: t.procedure.query(() => []),',
  '  }),',
  '  gamma: t.router({',
  '    ...derived,',
  '    shaped: t.procedure',
  '      .input(z.object({ id: z.string(), decoy: z.string().optional() }))',
  '      .mutation(() => 3),',
  '    last: t.procedure.mutation(() => 4),',
  '  }),',
  '})',
].join('\n')

const PROBE_CENSUS = JSON.stringify({
  total: 4,
  migrated: { routers: ['beta'], allowed: {} },
  pending: {
    alpha: { owner: 'POD-000', keys: ['deep', 'after'] },
    gamma: { owner: 'POD-000', keys: ['shaped', 'last'] },
  },
})

function probe(): Finding[] {
  const failures: Finding[] = []
  const at = 'scripts/audit-router-mutations.ts'
  const yes = (check: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: at,
        detail: `the ${check} check found nothing in a fixture that contains one — it cannot say YES`,
      })
    }
  }
  const no = (check: string, found: Finding[], why: string): void => {
    if (found.length > 0) {
      failures.push({
        check: 'instrument',
        where: at,
        detail: `the ${check} check fires on ${why} — it cannot say NO: ${found[0]?.detail}`,
      })
    }
  }

  // ---- the parser itself -------------------------------------------------
  const blocks = parseRouterBlocks(PROBE_ROUTER_SOURCE)
  const named = (n: string): RouterBlock | undefined => blocks.find((b) => b.name === n)
  if (blocks.length !== 3) {
    failures.push({
      check: 'instrument',
      where: at,
      detail: `the parser found ${blocks.length} top-level routers in a fixture with 3`,
    })
  }
  if (named('alpha')?.keys.join(',') !== 'deep,after') {
    failures.push({
      check: 'instrument',
      where: at,
      detail:
        'the parser did not read `alpha` as exactly [deep, after] — it either counted the ' +
        'commented/quoted `.mutation(` mentions or stopped at the nested router’s closing brace, ' +
        `and read [${named('alpha')?.keys.join(', ')}] instead`,
    })
  }
  if (named('beta')?.keys.length !== 0) {
    failures.push({
      check: 'instrument',
      where: at,
      detail: 'the parser found a write in a read-only router',
    })
  }
  if (named('gamma')?.keys.join(',') !== 'shaped,last') {
    failures.push({
      check: 'instrument',
      where: at,
      detail:
        'the parser did not read `gamma` as exactly [shaped, last] — it either missed the ' +
        'mutation written at the END of the block or named the inline schema field `decoy` as ' +
        `the procedure, and read [${named('gamma')?.keys.join(', ')}] instead`,
    })
  }

  // ---- the checks, each against a fixture containing what it hunts -------
  const clean = parseCensus(PROBE_CENSUS)
  no(
    'census-membership',
    uncensusedRouters(blocks, clean, '<probe>'),
    'a fully censused router set',
  )
  no('derived-family-clean', writesInMigratedRouters(blocks, clean, '<probe>'), 'a clean fixture')
  no('pending-census', pendingDrift(blocks, clean, '<probe>'), 'a census that matches the router')
  no('ratchet', ratchet(blocks, clean), 'a total that matches')

  yes(
    'census-membership',
    uncensusedRouters(
      blocks,
      parseCensus(JSON.stringify({ total: 4, migrated: { routers: [] }, pending: {} })),
      '<probe>',
    ),
  )
  yes(
    'census-membership',
    uncensusedRouters(
      blocks,
      parseCensus(
        JSON.stringify({
          total: 4,
          migrated: { routers: ['beta', 'ghost'] },
          pending: { alpha: { keys: ['deep', 'after'] }, gamma: { keys: ['shaped', 'last'] } },
        }),
      ),
      '<probe>',
    ),
  )
  yes(
    'derived-family-clean',
    writesInMigratedRouters(
      blocks,
      parseCensus(
        JSON.stringify({
          total: 4,
          migrated: { routers: ['beta', 'gamma'] },
          pending: { alpha: { keys: ['deep', 'after'] } },
        }),
      ),
      '<probe>',
    ),
  )
  // …and the allowlist must actually forgive, or it is decorative.
  no(
    'derived-family-clean',
    writesInMigratedRouters(
      blocks,
      parseCensus(
        JSON.stringify({
          total: 4,
          migrated: { routers: ['beta', 'gamma'], allowed: { gamma: ['shaped', 'last'] } },
          pending: { alpha: { keys: ['deep', 'after'] } },
        }),
      ),
      '<probe>',
    ),
    'an allowlisted key',
  )
  // …but only on ITS OWN router: the same key elsewhere is still a finding.
  yes(
    'derived-family-clean',
    writesInMigratedRouters(
      blocks,
      parseCensus(
        JSON.stringify({
          total: 4,
          migrated: { routers: ['beta', 'gamma'], allowed: { beta: ['shaped', 'last'] } },
          pending: { alpha: { keys: ['deep', 'after'] } },
        }),
      ),
      '<probe>',
    ),
  )
  // An ADDED write, and a REMOVED one — the guard's two directions.
  yes(
    'pending-census',
    pendingDrift(
      blocks,
      parseCensus(
        JSON.stringify({
          total: 4,
          migrated: { routers: ['beta'] },
          pending: { alpha: { keys: ['deep'] }, gamma: { keys: ['shaped', 'last'] } },
        }),
      ),
      '<probe>',
    ),
  )
  const removed = pendingDrift(
    blocks,
    parseCensus(
      JSON.stringify({
        total: 4,
        migrated: { routers: ['beta'] },
        pending: {
          alpha: { keys: ['deep', 'after'] },
          gamma: { guard: true, owner: 'POD-352', keys: ['shaped', 'last', 'vanished'] },
        },
      }),
    ),
    '<probe>',
  )
  yes('settings-guard', removed)
  if (!removed.some((f) => f.check === 'settings-guard')) {
    failures.push({
      check: 'instrument',
      where: at,
      detail:
        'a `guard: true` entry losing a key did not report as `settings-guard` — the guard is ' +
        'indistinguishable from an ordinary pending entry, so its no-ratchet-relief rule is a comment',
    })
  }
  yes(
    'ratchet',
    ratchet(blocks, parseCensus(JSON.stringify({ total: 3, migrated: {}, pending: {} }))),
  )
  yes(
    'ratchet',
    ratchet(blocks, parseCensus(JSON.stringify({ total: 9, migrated: {}, pending: {} }))),
  )
  yes('ratchet', ratchet(blocks, parseCensus(JSON.stringify({ migrated: {}, pending: {} }))))
  return failures
}

// ---------------------------------------------------------------------------
// --update-census
// ---------------------------------------------------------------------------

/**
 * Rewrites `total` and every `pending` key list from the current source, leaving
 * the `migrated` list, the owners and the notes alone — those are decisions, not
 * measurements, and regenerating them would let a migration be "recorded" by the
 * same command that failed to notice it. Refuses to raise the total.
 */
function updateCensus(): void {
  const source = read(ROUTER)
  const blocks = parseRouterBlocks(source)
  const raw = JSON.parse(read(CENSUS)) as Record<string, unknown>
  const census = parseCensus(read(CENSUS))
  const total = blocks.reduce((n, b) => n + b.keys.length, 0)
  if (total > census.total) {
    console.error(
      `refusing to update: ${total} hand-written mutations, up from ${census.total}. This ` +
        'ratchet may only go DOWN — the write you added belongs in a contract table.',
    )
    process.exit(1)
  }
  const pending = raw.pending as Record<string, unknown>
  for (const block of blocks) {
    const entry = pending[block.name] as { keys?: string[] } | undefined
    if (entry) entry.keys = [...new Set(block.keys)]
  }
  raw.total = total
  writeFileSync(join(ROOT, CENSUS), `${JSON.stringify(raw, null, 2)}\n`)
  console.log(`census updated: total ${census.total} → ${total}`)
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Router mutation census: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('router mutation census: the parser and all 4 checks found their planted fixtures')
    return
  }
  if (wants('--update-census')) {
    updateCensus()
    return
  }

  const findings = auditRouterMutations(read(ROUTER), read(CENSUS))
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Router mutation census: ${findings.length} finding(s). POD-386's claims are:\n` +
        '  · every router in router.ts is accounted for — migrated, or pending with named keys\n' +
        '  · a DERIVED family carries no hand-written `.mutation(`\n' +
        '  · a pending router carries EXACTLY the writes the census names, both directions\n' +
        '  · settings is UNTOUCHED — a removal fails the guard as hard as an addition\n' +
        '  · the total may only go DOWN\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  const total = parseCensus(read(CENSUS)).total
  console.log(
    `router mutation census OK — ${total} hand-written \`.mutation(\` in ${ROUTER}, all named, ` +
      'every derived family clean, settings untouched',
  )
}

if (import.meta.main) main()
