/** POD-5133: tables for docs/measurements/POD-pool-memory-breakdown.md from
 * the capture's records.jsonl and per-arm `*.analysis.json`. Read-only.
 *   bun apps/web/harness/pool-memory-report.ts [--out=capture] */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const arg = (name: string, fallback: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback
const dir = resolve(process.cwd(), '.artifacts/pool-memory', arg('out', 'capture'))
const build = resolve(process.cwd(), '.artifacts/pool-memory/build/assets')
const cells = ['1x', '4x', 'h10a1']
const cellName: Record<string, string> = { '1x': '1×', '4x': '4×', h10a1: '10× history' }
const MiB = 1024 * 1024
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}
const f1 = (x: number) => x.toFixed(1),
  pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`

type Analysis = {
  totals: { liveMiB: number; jsMiB: number; nativeMiB: number }
  rows: Record<string, number> | null
  heap: { usedSize: number }
  counterfactuals: {
    group: string
    freedMiB: number
    blocked: number
    topSites: { key: string; MiB: number }[]
  }[]
  sites: { key: string; count: number; MiB: number }[]
  classes: Record<string, { MiB: number; count: number }>
  rowCopies: {
    kind: string
    count: number
    distinctIds: number
    bytesPerCopy: number
    shallowMiB: number
    propertyNames: string
    properties: number
  }[]
}
const load = async (stem: string) =>
  JSON.parse(await readFile(resolve(dir, `${stem}.analysis.json`), 'utf8')) as Analysis
const records = (await readFile(resolve(dir, 'records.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const a: Record<string, { legacy: Analysis; pool: Analysis }> = {}
for (const cell of cells)
  a[cell] = { legacy: await load(`${cell}-legacy`), pool: await load(`${cell}-pool`) }
const used = (cell: string, arm: string) =>
  median(
    records
      .filter((r) => r.cell === cell && r.arm === arm && !r.devLocal)
      .map((r) => r.heap.usedSize / MiB),
  )
const samples = (cell: string, arm: string) =>
  records.filter((r) => r.cell === cell && r.arm === arm && !r.devLocal).length
const freed = (x: Analysis, group: string) => {
  const found = x.counterfactuals.find((c) => c.group === group)
  if (!found) throw new Error(`Missing counterfactual ${group}`)
  return found.freedMiB
}
const resident = (cell: string) =>
  Object.values(a[cell]!.pool.rows ?? {}).reduce((n, v) => n + v, 0)

const out: string[] = []
const table = (head: string[], rows: (string | number)[][]) => {
  out.push(
    `| ${head.join(' | ')} |`,
    `| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
  )
  for (const row of rows) out.push(`| ${row.join(' | ')} |`)
  out.push('')
}

out.push('### T1. Retained heap, switch off vs on', '')
table(
  [
    'Cell',
    'Samples per arm',
    'Legacy V8 used',
    'Pool V8 used',
    'Difference',
    'Regression',
    'Snapshot live legacy',
    'Snapshot live pool',
    'Snapshot difference',
    'Resident pool rows',
  ],
  cells.map((cell) => {
    const l = used(cell, 'legacy'),
      p = used(cell, 'pool')
    const { legacy, pool } = a[cell]!
    return [
      cellName[cell]!,
      `${samples(cell, 'legacy')} / ${samples(cell, 'pool')}`,
      f1(l),
      f1(p),
      f1(p - l),
      pct(p / l - 1),
      f1(legacy.totals.liveMiB),
      f1(pool.totals.liveMiB),
      f1(pool.totals.liveMiB - legacy.totals.liveMiB),
      resident(cell).toLocaleString('en-US'),
    ]
  }),
)

const POOL_GROUPS = [
  ['pool: per-row model computeds (cached.ts)', 'Per-row model computeds (`cached.ts`)'],
  [
    'pool: tracked has() entries (ObservableMap hasMap_)',
    'Tracked key lookups (`ObservableMap.hasMap_`)',
  ],
  ['pool: boxed map entries (ObservableMap values)', 'Boxed map entries (`ObservableMap` values)'],
  ['pool: relation engine and buckets', 'Relation engine and buckets'],
  ['pool: residency', 'Residency (cold-row registry, summaries)'],
  ['pool: MobX debug names', 'MobX debug-name strings'],
  ['pool: per-issue file reactions (visible.ts)', 'Per-issue filing reactions (`visible.ts`)'],
  ['pool: sidebar indexes and groups', 'Sidebar indexes and groups'],
  ['pool: read-state lane', 'Read-state lane'],
] as const
out.push('### T2. What the pool machinery holds (pool arm, removal counterfactuals, MiB)', '')
out.push(
  'Each row is measured alone; rows overlap and do not add. "All pool machinery" cuts the pool object, every MobX object and every closure from the pool chunks at once.',
  '',
)
table(
  [
    'Structure',
    ...cells.map((c) => cellName[c]!),
    ...cells.map((c) => `bytes / resident row ${cellName[c]}`),
  ],
  [
    ...POOL_GROUPS.map(([group, label]) => [
      label,
      ...cells.map((c) => f1(freed(a[c]!.pool, group))),
      ...cells.map((c) =>
        Math.round((freed(a[c]!.pool, group) * MiB) / resident(c)).toLocaleString('en-US'),
      ),
    ]),
    [
      '**All pool machinery**',
      ...cells.map((c) => `**${f1(freed(a[c]!.pool, 'pool: all machinery'))}**`),
      ...cells.map(
        (c) =>
          `**${Math.round((freed(a[c]!.pool, 'pool: all machinery') * MiB) / resident(c)).toLocaleString('en-US')}**`,
      ),
    ],
    [
      'Share of the snapshot difference',
      ...cells.map((c) =>
        pct(
          freed(a[c]!.pool, 'pool: all machinery') /
            (a[c]!.pool.totals.liveMiB - a[c]!.legacy.totals.liveMiB),
        ).replace('+', ''),
      ),
      '',
      '',
      '',
    ],
  ],
)

out.push('### T3. Legacy-side owners in both arms (removal counterfactuals, MiB)', '')
const SIDE = [
  [
    'legacy store (published snapshot, engine state and base arrays, view-model cache)',
    'Legacy store: published snapshot, engine state, view models, mission index',
  ],
  ['kernel replica and its cache', 'Kernel replica and its cache (exclusive part)'],
  ['old issue record (POD-4949 retires it)', 'Old issue record (one per issue)'],
  [
    'temporary old-record join (temporary-issue-input.ts)',
    'Temporary old-record join (`temporary-issue-input.ts`)',
  ],
] as const
table(
  ['Owner', ...cells.flatMap((c) => [`${cellName[c]} legacy`, `${cellName[c]} pool`])],
  SIDE.map(([group, label]) => [
    label,
    ...cells.flatMap((c) => [f1(freed(a[c]!.legacy, group)), f1(freed(a[c]!.pool, group))]),
  ]),
)

out.push('### T4. Projected pool-only end state (MiB, V8 used after GC)', '')
out.push(
  "Projection = pool arm V8 used minus what the cut frees in the pool arm; regression against today's legacy V8 used. End state A removes the legacy store; B also retires the temporary join and the old issue record (POD-4949), and adds back 64 bytes per issue for the fields the one record absorbs.",
  '',
)
table(
  [
    'Cell',
    'Legacy today',
    'Pool arm today',
    'End state A',
    'A regression',
    'End state B',
    'B regression',
    'Pool machinery in B',
    'Budget at +10%',
  ],
  cells.map((cell) => {
    const l = used(cell, 'legacy'),
      p = used(cell, 'pool')
    const issues = a[cell]!.pool.rowCopies.filter(
      (r) =>
        r.kind === 'issue' &&
        r.propertyNames.includes('childDoneCount') &&
        !r.propertyNames.includes('displayRef'),
    ).reduce((n, r) => n + r.count, 0)
    const A = p - freed(a[cell]!.pool, 'end state A: legacy store removed')
    const B =
      p -
      freed(
        a[cell]!.pool,
        'end state B: legacy store, temporary join and old issue record removed (POD-4949)',
      ) +
      (issues * 64) / MiB
    return [
      cellName[cell]!,
      f1(l),
      f1(p),
      f1(A),
      pct(A / l - 1),
      f1(B),
      pct(B / l - 1),
      f1(freed(a[cell]!.pool, 'pool: all machinery')),
      f1(l * 1.1),
    ]
  }),
)

out.push(
  '### T5. Copies of each issue row (shallow bytes per copy; same in both arms unless marked)',
  '',
)
const role = (names: string) =>
  names.includes('sessionFacts')
    ? 'Temporary old-record join output (pool only)'
    : names.includes('displayRef') && names.includes('sessionSummary')
      ? 'Legacy issue view model'
      : names.includes('childDoneCount') && names.includes('unread')
        ? 'Old issue record (replica)'
        : names.includes('createdBy') && names.includes('priority') && !names.includes('unread')
          ? 'Issue projection (replica)'
          : names.includes('displayRef') && names.includes('memberSessionIds')
            ? 'Legacy issue-view entry'
            : names.includes('prefix') && names.includes('stage')
              ? 'Legacy published sorted-issue entry'
              : names === '__proto__,entity,host,id'
                ? 'Pool IssueModel (pool only)'
                : null
for (const cell of ['1x', '4x']) {
  const rows = new Map<string, { legacy: number; pool: number; bytes: number[] }>()
  for (const arm of ['legacy', 'pool'] as const)
    for (const r of a[cell]![arm].rowCopies) {
      if (r.kind !== 'issue') continue
      const name = role(r.propertyNames)
      if (!name) continue
      const entry = rows.get(name) ?? { legacy: 0, pool: 0, bytes: [] }
      entry[arm] += r.count
      if (arm === 'pool' || !rows.has(name)) entry.bytes.push(r.bytesPerCopy)
      rows.set(name, entry)
    }
  out.push(`${cellName[cell]}:`, '')
  table(
    ['Copy', 'Objects (legacy arm)', 'Objects (pool arm)', 'Shallow bytes per copy (median shape)'],
    [...rows].map(([name, v]) => [
      name,
      v.legacy.toLocaleString('en-US'),
      v.pool.toLocaleString('en-US'),
      median(v.bytes).toFixed(0),
    ]),
  )
}

// Creation sites, pool minus legacy, with the bundle region (source module) of each closure site.
const regions = new Map<string, string[]>()
const regionOf = async (file: string, line: number) => {
  if (!regions.has(file)) {
    const path = resolve(build, file)
    const text = existsSync(path) ? await readFile(path, 'utf8') : ''
    let current = ''
    regions.set(
      file,
      text
        .split('\n')
        .map(
          (l) =>
            (current = l.startsWith('//#region ')
              ? l.slice(10).replace(/^.*node_modules\//, '')
              : current),
        ),
    )
  }
  return regions.get(file)![line - 1] ?? '?'
}
out.push('### T6. Largest pool-only creation sites at 4× (pool minus legacy, MiB)', '')
{
  const L = new Map(a['4x']!.legacy.sites.map((s) => [s.key, s]))
  const diff = a['4x']!.pool.sites.map((s) => ({
    ...s,
    d: s.MiB - (L.get(s.key)?.MiB ?? 0),
    dc: s.count - (L.get(s.key)?.count ?? 0),
  }))
    .filter((s) =>
      /^(ObservableValue|ComputedValue|Atom|Reaction|ObservableMap|ObservableSet|ObservableObjectAdministration|ObservableArrayAdministration|closure|\(MobX)/.test(
        s.key,
      ),
    )
    .sort((x, y) => y.d - x.d)
    .slice(0, 25)
  const rows: string[][] = []
  for (const s of diff) {
    const at = s.key.match(/@ ([^ :]+):(\d+):\d+$/)
    const module = at ? await regionOf(at[1]!, Number(at[2])) : ''
    rows.push([
      `\`${s.key.replace(/ @ .*$/, '').replace(/\|/g, '\\|')}\``,
      module ? `\`${module}\`` : '',
      s.dc.toLocaleString('en-US'),
      s.d.toFixed(2),
    ])
  }
  table(
    [
      'Site (MobX object and debug name, or closure)',
      'Source module of the closure',
      'Objects',
      'MiB',
    ],
    rows,
  )
}
console.log(out.join('\n'))
