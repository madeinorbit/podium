/** Measurement-only transforms: the shipped modules contain no counter hooks.
 * Every seam is exact and required, so a changed derivation cannot silently
 * turn a positive guard into an empty report. Both unit and browser probes use
 * these same counters around the real production computations. */
import { fileURLToPath } from 'node:url'

const boardMeter = fileURLToPath(new URL('./issue-board.ts', import.meta.url))
const headerMeter = fileURLToPath(new URL('./header.ts', import.meta.url))

function once(code: string, anchor: string, replacement: string, file: string): string {
  if (code.split(anchor).length !== 2)
    throw new Error(`Missing or ambiguous work measurement boundary ${file}: ${anchor}`)
  return code.replace(anchor, replacement)
}

export function instrumentProductWork(code: string, id: string): string | undefined {
  const file = id.split('?')[0]!.replaceAll('\\', '/')
  if (file.endsWith('/packages/mobx-helpers/src/lazy.ts')) {
    // Preserve the cachedGroup census labels when a model moves to @lazy.
    // Expose the owner to the outside meter as well. The body already closes
    // over `this`; MobX's context changes attribution only, not its answer.
    // Every computed body is still counted, and generic lazy getters keep
    // their ordinary names.
    return once(code, "name: debugName(() => `${this.constructor?.name ?? 'Object'}.${name}`)",
      `context: this,
      name: debugName(() => {
        const target = this as { constructor?: { name?: string }; id?: string }
        const group = ({ nestingValue: 'nesting', nestCandidateValue: 'nestCandidate', seatActivity: 'activity' } as Record<string, string>)[name] ?? name
        return target.id === undefined
          ? \`\${target.constructor?.name ?? 'Object'}.\${name}\`
          : \`\${target.constructor?.name ?? 'Object'}@\${target.id}.\${group}\`
      })`, file)
  }
  let meter = boardMeter
  let binding = 'countIssueBoard as __countIssueBoard'
  if (file.endsWith('/packages/client-graph/src/issue-board-source.ts')) {
    code = once(code, 'export function createIssueBoardSource(', 'export function createIssueBoardSource(', file)
    for (const [anchor, counter] of [
      ['function facts(id: string): Loaded<IssueViewModel> {', "'factReads'"],
      ["return memo(`${visible ? 'visibleRow' : 'row'}:${id}`, () => {", "'rowModels'"],
      ['return memo(`card:${JSON.stringify({ id: options.id, agents: options.agents ?? false })}`, () => {', "'cards'"],
    ]) code = once(code, anchor!, `${anchor}\n    __countIssueBoard(${counter})`, file)
  } else if (file.endsWith('/packages/client-graph/src/issue-board-layout.ts')) {
    for (const anchor of ["const matching = keyedComputed('IssueBoard.matchingIds'", "const columnIds = keyedComputed('IssueBoard.columnIds'"])
      code = once(code, anchor, anchor, file)
    for (const [anchor, counter] of [
      ["const needle = query.filter?.text?.trim() ?? ''", "'queries'"],
      ['return ids.sort(byId)', "'matchedIds', ids.length"],
      ['const options = JSON.parse(key) as BoardColumnOptions', '`column.${options.stage}`'],
    ]) code = once(code, anchor!, `__countIssueBoard(${counter});\n    ${anchor}`, file)
    // The stage label needs the parsed options before it is counted.
    code = code.replace('__countIssueBoard(`column.${options.stage}`);\n    const options = JSON.parse(key) as BoardColumnOptions',
      'const options = JSON.parse(key) as BoardColumnOptions;\n    __countIssueBoard(`column.${options.stage}`)')
  } else if (file.endsWith('/packages/client-graph/src/header-views.ts')) {
    code = once(code, 'function createHeaderViews(', 'function createHeaderViews(', file)
    meter = headerMeter
    binding = 'measureHeader as __measureHeader'
    code = once(code, '(_key: string, read: () => unknown) => read()',
      "(key: string, read: () => unknown) => __measureHeader(`pool.${key.split(':')[0]}`, read)", file)
  } else if (file.endsWith('/packages/client-graph/src/header-session.ts')) {
    meter = headerMeter
    binding = 'measureHeader as __measureHeader'
    for (const [name, counter] of [
      ['headerWorkingSession', 'pool.workingSession'],
      ['headerHostSession', 'pool.hostSession'],
    ]) {
      const start = code.indexOf(`export function ${name}(`)
      if (start < 0) throw new Error(`Missing work measurement boundary ${file}:${name}`)
      const body = code.indexOf('{', start)
      const end = code.indexOf('\n}', body)
      if (body < 0 || end < 0) throw new Error(`Incomplete work measurement boundary ${file}:${name}`)
      code = code.slice(0, body + 1) + `\n  return __measureHeader('${counter}', () => {` +
        code.slice(body + 1, end) + '\n  })' + code.slice(end)
    }
  } else if (file.endsWith('/apps/web/src/features/machines/HostIndicators.tsx')) {
    meter = headerMeter
    binding = 'measureHeader as __measureHeader'
    const start = code.indexOf('const PoolMachineReadout = memo(function PoolMachineReadout(')
    const end = code.indexOf('\n})', start)
    if (start < 0 || end < 0) throw new Error(`Missing work measurement boundary ${file}: PoolMachineReadout`)
    const section = once(code.slice(start, end), 'return (\n    host ?',
      "return __measureHeader('pool.metricRow', () =>\n    host ?", file)
    code = code.slice(0, start) + section + code.slice(end)
  } else return undefined
  return `import { ${binding} } from ${JSON.stringify(meter)};\n${code}`
}

export function productWorkMeter() {
  return {
    name: 'test-product-work-counters',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const measured = instrumentProductWork(code, id)
      if (measured !== undefined) return { code: measured, map: null }
    },
  }
}
