/** Temporary counters in a production bundle; never instrument installed files. */
import { resolve } from 'node:path'
import { build } from 'vite'

const option = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const root = resolve(option('source', '.'))
const out = resolve(option('out', '.artifacts/live-sidebar/candidate-build'))
const off = option('off', '')
await build({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  build: { outDir: out, emptyOutDir: true },
  plugins: [
    {
      name: 'live-sidebar-census',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/packages/client-graph/src/pool.ts')) {
          const boundary = "    absent: AbsentRead = 'load',\n  ): Loaded<object> {"
          if (!code.includes(boundary)) throw new Error('Pool row census boundary changed')
          return (
            `const livePoolCounts: Record<string, number> = {}
;(globalThis as any).__livePoolCensus = () => ({ ...livePoolCounts })
` +
            code.replace(
              boundary,
              boundary +
                '\n    const censusKey = `${entity}:${absent}`\n    livePoolCounts[censusKey] = (livePoolCounts[censusKey] ?? 0) + 1',
            )
          )
        }
        if (id.endsWith('/packages/client-graph/src/shell-views.ts')) {
          if (!code.includes('  const cache =')) throw new Error('Shell census boundary changed')
          code = code.replace(
            '  const cache =',
            `  const liveShellCounts: Record<string, number> = {}
  ;(globalThis as any).__liveShellCensus = () => ({ ...liveShellCounts })
  const cache =`,
          )
          code = code.replace(
            / {2}function (issue|sessions|session|issues|chrome|dock)\(([^)]*)\)([^{]*)\{/g,
            (boundary, name) =>
              boundary + `\n    liveShellCounts.${name} = (liveShellCounts.${name} ?? 0) + 1`,
          )
          if (off === 'shell') {
            code = code.replace(
              '  function sessions(): Loaded<SessionView[]> {',
              '  function sessions(): Loaded<SessionView[]> {\n    return []',
            )
            code = code.replace(
              '  function issues(): Loaded<IssueViewModel[]> {',
              '  function issues(): Loaded<IssueViewModel[]> {\n    return []',
            )
          }
          return code
        }
        if (off === 'board' && id.endsWith('/packages/client-graph/src/issue-board-source.ts'))
          return code.replace(
            '  function track(id: string) {',
            '  function track(id: string) {\n    return',
          )
        if (off === 'page-catalog' && id.endsWith('/packages/client-graph/src/issue-page.ts'))
          return code.replace(
            '  function issues(): Loaded<IssueViewModel[]> {',
            '  function issues(): Loaded<IssueViewModel[]> {\n    return []',
          )
        if (off === 'motion' && id.endsWith('/worklist-motion-layout.tsx')) {
          if (
            !code.includes('projection.root?.didUpdate()') ||
            !code.includes('projection.willUpdate()')
          )
            throw new Error('Motion control boundary changed')
          return code
            .replaceAll('projection.root?.didUpdate()', 'void 0')
            .replaceAll('projection.willUpdate()', 'void 0')
        }
        if (off === 'sidebar-containment' && id.endsWith('/features/worklist/pool-sidebar.tsx')) {
          const boundary = 'data-testid="work-scroll"'
          if (!code.includes(boundary)) throw new Error('Sidebar containment boundary changed')
          return code.replace(boundary, boundary + '\n        style={{ contain: "layout paint" }}')
        }
        if (off === 'deck' && id.endsWith('/apps/web/src/app/FlightDeck.tsx')) {
          const start = code.indexOf('export function FlightDeckContent(')
          const boundary = code.indexOf('}): JSX.Element {', start)
          if (start < 0 || boundary < 0) throw new Error('Deck control boundary changed')
          const at = boundary + '}): JSX.Element {'.length
          return (
            code.slice(0, at) +
            '\n  return <div data-testid="flight-deck-scroller" />' +
            code.slice(at)
          )
        }
        if (off === 'chat' && id.endsWith('/apps/web/src/features/chat/ChatView.tsx')) {
          const start = code.indexOf('export function ChatView(')
          const boundary = code.indexOf('}): JSX.Element {', start)
          if (start < 0 || boundary < 0) throw new Error('Chat control boundary changed')
          const at = boundary + '}): JSX.Element {'.length
          return (
            code.slice(0, at) + '\n  return <div data-testid="chat-surface" />' + code.slice(at)
          )
        }
        if (id.endsWith('/packages/client-graph/src/chat-context.ts')) {
          if (!code.includes('  return {\n    counts,'))
            throw new Error('Chat census boundary changed')
          code = code.replace(
            '  return {\n    counts,',
            `  const census = ((globalThis as any).__liveChatReaders ??= [])
  census.push(counts)
  ;(globalThis as any).__liveChatCensus = () => census.reduce((sum: Record<string, number>, reader: Record<string, number>) => {
    for (const key of Object.keys(reader)) sum[key] = (sum[key] ?? 0) + reader[key]
    return sum
  }, {})
  return {
    counts,`,
          )
          if (off === 'references') {
            const boundary =
              'export function chatReferenceSessions(pool: MobxPool, counts = readerCounts(pool)) {'
            if (!code.includes(boundary)) throw new Error('Reference control boundary changed')
            code = code.replace(boundary, boundary + '\n  return { sessions: [], pending: 0 }')
          }
          return code
        }
        if (off === 'activity' && id.endsWith('/packages/client-graph/src/reader-queries.ts')) {
          const boundary = '  activity(question: SessionActivityQuestion): number {'
          if (!code.includes(boundary)) throw new Error('Activity control boundary changed')
          return code.replace(boundary, boundary + '\n    return 0')
        }
        if (!id.endsWith('/packages/client-graph/src/command-launch-views.ts')) return
        if (!code.includes('catalogBuilds: 0,') || !code.includes('launch: () => launch.get(),'))
          throw new Error('Launch census boundary changed')
        return code
          .replace('catalogBuilds: 0,', 'catalogBuilds: 0, launchReads: 0,')
          .replace(
            '  type Window =',
            '  ;(globalThis as any).__liveLaunchCensus = () => ({ ...counts })\n  type Window =',
          )
          .replace(
            'launch: () => launch.get(),',
            'launch: () => { counts.launchReads++; return launch.get() },',
          )
      },
    },
  ],
})
