/** Measurement-only transforms: the shipped modules contain no counter hooks.
 * Every seam is exact and required, so a changed derivation cannot silently
 * turn a positive guard into an empty report. Both unit and browser probes use
 * these same counters around the real production computations. */
import { fileURLToPath } from 'node:url'

const boardMeter = fileURLToPath(new URL('./issue-board.ts', import.meta.url))

function once(code: string, anchor: string, replacement: string, file: string): string {
  if (code.split(anchor).length !== 2)
    throw new Error(`Missing or ambiguous work measurement boundary ${file}: ${anchor}`)
  return code.replace(anchor, replacement)
}

export function instrumentProductWork(code: string, id: string): string | undefined {
  const file = id.split('?')[0]!.replaceAll('\\', '/')
  if (file.endsWith('/packages/client-graph/src/issue-board-source.ts')) {
    for (const [anchor, counter] of [
      ['function facts(id: string): Loaded<IssueViewModel> {', "'factReads'"],
      ["return memo(`${visible ? 'visibleRow' : 'row'}:${id}`, () => {", "'rowModels'"],
      ['return memo(`card:${JSON.stringify({ id: options.id, agents: options.agents ?? false })}`, () => {', "'cards'"],
    ]) code = once(code, anchor!, `${anchor}\n    __countIssueBoard(${counter})`, file)
  } else if (file.endsWith('/packages/client-graph/src/issue-board-layout.ts')) {
    for (const [anchor, counter] of [
      ["const needle = query.filter?.text?.trim() ?? ''", "'queries'"],
      ['return ids.sort(byId)', "'matchedIds', ids.length"],
      ['const options = JSON.parse(key) as BoardColumnOptions', '`column.${options.stage}`'],
    ]) code = once(code, anchor!, `__countIssueBoard(${counter});\n    ${anchor}`, file)
    // The stage label needs the parsed options before it is counted.
    code = code.replace('__countIssueBoard(`column.${options.stage}`);\n    const options = JSON.parse(key) as BoardColumnOptions',
      'const options = JSON.parse(key) as BoardColumnOptions;\n    __countIssueBoard(`column.${options.stage}`)')
  } else return undefined
  return `import { countIssueBoard as __countIssueBoard } from ${JSON.stringify(boardMeter)};\n${code}`
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
