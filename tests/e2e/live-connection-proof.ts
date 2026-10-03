import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { actorUser, asUserId, IssueProjection } from '@podium/model'
import { CLIENT_WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { build } from 'vite'
import {
  resolveMobileFile,
  resolveMobilePackage,
  resolveRootFile,
  resolveRootPackage,
} from '../../apps/mobile/resolve-package'
import { makeIssue } from '../../apps/web/src/lib/test-issue'

type ProofState = {
  app: string
  tab: string
  rows: string[]
  connected: boolean
  versionReads: number
  verdicts: string[]
  notices: string[]
}
type FixtureWindow = Window & { connectionProof: { state(): ProofState; stop(): Promise<void> } }
const snapshot = (page: Page) =>
  page.evaluate(() => (window as FixtureWindow).connectionProof.state())
const fixtureClaim = 'fixture-claim-00000000000000000000'

/** One Chromium capture per app. Every authority, cookie and store is synthetic,
 * bound to loopback ephemeral ports, and torn down by this fixture. */
export async function liveConnectionProof() {
  const root = resolve(import.meta.dirname, '../../apps/mobile')
  const bundle = await build({
      configFile: false,
      root,
      logLevel: 'warn',
      define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
      resolve: {
        extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
        conditions: ['@podium/source', 'browser', 'module', 'import'],
        alias: [
          { find: /^react-native$/, replacement: resolveMobilePackage('react-native-web') },
          { find: /^react$/, replacement: resolveRootPackage('react') },
          { find: /^react-dom$/, replacement: resolveRootPackage('react-dom') },
          { find: /^react-dom\/client$/, replacement: resolveRootFile('react-dom/client') },
          {
            find: /^react-native-svg$/,
            replacement: resolveMobileFile('react-native-svg/lib/module/ReactNativeSVG.web.js'),
          },
          ...[
            ['expo-blur', 'stub-expo-blur.tsx'],
            ['expo-haptics', 'stub-expo-haptics.ts'],
          ].map(([find, file]) => ({ find: new RegExp(`^${find}$`), replacement: resolve(root, 'harness', file!) })),
          {
            find: /^react-native-safe-area-context$/,
            replacement: resolve(import.meta.dirname, 'live-connection-safe-area.ts'),
          },
          {
            find: /^expo-symbols$/,
            replacement: resolve(import.meta.dirname, 'live-connection-symbols.ts'),
          },
          { find: /^\.\/BottomSheet$/, replacement: resolve(root, 'harness/stub-bottom-sheet.tsx') },
          { find: '@', replacement: resolve(root, '../web/src') },
          {
            find: /^\.\/ServerProfileGate$/,
            replacement: resolve(root, 'src/client/server-profile-context.ts'),
          },
          {
            find: /^expo\/fetch$/,
            replacement: resolve(root, 'node_modules/expo/src/winter/fetch/fetch.web.ts'),
          },
        ],
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: resolve(root, 'live-connection-harness.html') },
      },
    })
  const outputs = Array.isArray(bundle)
    ? bundle.flatMap((b) => b.output)
    : 'output' in bundle
      ? bundle.output
      : []
  const files = new Map(
    outputs.map((entry) => [entry.fileName, entry.type === 'chunk' ? entry.code : entry.source]),
  )
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const results: {
    app: string
    relayed: boolean
    cookieAuthenticated: boolean
    reconnects: number[]
    moved: boolean
    claimInFragment: boolean
  }[] = []
  try {
    for (const app of ['web', 'mobile']) {
      const sockets = new Map<string, Bun.ServerWebSocket<{ tab: string }>>()
      const dials = new Map<string, number>()
      let authority!: Bun.Server<{ tab: string }>,
        sequence = 0,
        wire = CLIENT_WIRE_VERSION,
        cookieAuthenticated = true
      const startAuthority = (port = 0) =>
        Bun.serve<{ tab: string }>({
          hostname: '127.0.0.1',
          port,
          fetch(request, server) {
            const url = new URL(request.url)
            if (url.pathname === '/client') {
              cookieAuthenticated &&=
                request.headers.get('cookie')?.includes('fixture-login=synthetic') ?? false
              if (server.upgrade(request, { data: { tab: url.searchParams.get('tab') ?? 'one' } }))
                return
            }
            if (url.pathname === '/version')
              return Response.json({ wireVersion: wire, wireSchemaDigest: wireSchemaDigest() })
            if (url.pathname.startsWith('/sync/')) {
              const seq = Number(url.searchParams.get('from') ?? sequence)
              return new Response(
                [
                  {
                    type: 'syncMeta',
                    formatVersion: 1,
                    mode: 'delta',
                    transferId: 'fixture',
                    feedId: 'fixture-feed',
                    epoch: 'fixture-epoch',
                    fromSeq: seq,
                    seq,
                    minAvailableSeq: 0,
                    wireVersion: CLIENT_WIRE_VERSION,
                    wireSchemaDigest: wireSchemaDigest(),
                  },
                  { type: 'syncComplete', transferId: 'fixture', seq, records: 0, rows: 0 },
                ]
                  .map((row) => JSON.stringify(row) + '\n')
                  .join(''),
                { headers: { 'content-type': 'application/x-ndjson' } },
              )
            }
            const path =
              url.pathname === '/' ? 'live-connection-harness.html' : url.pathname.slice(1)
            const file = files.get(path)
            if (file === undefined) return new Response('missing fixture file', { status: 404 })
            return new Response(file, {
              headers: {
                'content-type': path.endsWith('.html')
                  ? 'text/html'
                  : path.endsWith('.css')
                    ? 'text/css'
                    : 'text/javascript',
              },
            })
          },
          websocket: {
            open(socket) {
              sockets.set(socket.data.tab, socket)
              dials.set(socket.data.tab, (dials.get(socket.data.tab) ?? 0) + 1)
            },
            close(socket) {
              if (sockets.get(socket.data.tab) === socket) sockets.delete(socket.data.tab)
            },
            message(socket, message) {
              const frame = JSON.parse(String(message))
              if (frame.type === 'hello' || frame.type === 'ping')
                socket.send(JSON.stringify({ type: 'pong' }))
            },
          },
        })
      authority = startAuthority()
      const origin = `http://127.0.0.1:${authority.port}`
      const context = await browser.newContext()
      const movedRequests: string[] = []
      const promoted = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          movedRequests.push(request.url)
          return new Response('<h1>Fixture authority moved</h1>', {
            headers: { 'content-type': 'text/html' },
          })
        },
      })
      try {
        await context.addCookies([
          {
            name: 'fixture-login',
            value: 'synthetic',
            url: origin,
            httpOnly: true,
            sameSite: 'Lax',
          },
        ])
        const first = await context.newPage(),
          second = await context.newPage()
        const errors: string[] = []
        for (const page of [first, second]) {
          page.on('pageerror', (error) => {
            errors.push(error.message)
            console.error(`connection fixture ${app}: ${error.message}`)
          })
          page.on('console', (message) => {
            if (message.type() === 'error') console.error(`connection fixture ${app}: ${message.text()}`)
          })
        }
        await first.goto(`${origin}/?app=${app}&tab=one#pane`)
        await first.waitForFunction(
          () => (window as FixtureWindow).connectionProof?.state().connected,
          undefined,
          { timeout: 20_000 },
        )
        await second.goto(`${origin}/?app=${app}&tab=two#pane`)
        await second.waitForFunction(
          () => (window as FixtureWindow).connectionProof?.state().connected,
          undefined,
          { timeout: 20_000 },
        )
        const row = IssueProjection.parse({
          ...makeIssue({ id: 'fixture-issue', title: 'Relayed from the first tab' }),
          repoId: 'fixture-repo',
          createdBy: { actor: actorUser(asUserId('alice')), onBehalfOf: asUserId('alice') },
          owner: 'alice',
          visibility: 'personal',
          description: { value: '' },
        })
        sequence = 1
        sockets
          .get('one')!
          .send(
            JSON.stringify({
              type: 'feedDelta',
              feedId: 'fixture-feed',
              epoch: 'fixture-epoch',
              fromSeq: 0,
              seq: 1,
              minAvailableSeq: 0,
              changes: [
                {
                  seq: 1,
                  entity: 'issueProjection',
                  entityId: 'fixture-issue',
                  op: 'upsert',
                  value: row,
                },
              ],
            }),
          )
        for (const page of [first, second])
          await page.waitForFunction(
            () =>
              (window as FixtureWindow).connectionProof
                .state()
                .rows.includes('Relayed from the first tab'),
            undefined,
            { timeout: 15_000 },
          )
        const before = await Promise.all([snapshot(first), snapshot(second)])
        const port = authority.port
        await authority.stop(true)
        for (const page of [first, second])
          await page.waitForFunction(
            () => !(window as FixtureWindow).connectionProof.state().connected,
          )
        wire = CLIENT_WIRE_VERSION + 1
        authority = startAuthority(port)
        for (const page of [first, second])
          await page.waitForFunction(
            () => {
              const state = (window as FixtureWindow).connectionProof.state()
              return (
                state.connected &&
                (state.app === 'web'
                  ? state.verdicts.includes('client-too-old')
                  : state.notices.some((notice) => notice.includes('Reload')))
              )
            },
            undefined,
            { timeout: 20_000 },
          )
        const after = await Promise.all([snapshot(first), snapshot(second)])
        const reconnects = after.map(
          (state, index) => state.versionReads - before[index]!.versionReads,
        )
        if (dials.get('one') !== 2 || dials.get('two') !== 2 || reconnects.some((n) => n !== 1))
          throw new Error(
            `unexpected reconnect count: ${JSON.stringify({ dials: [...dials], reconnects })}`,
          )
        if (errors.length) throw new Error(errors.join('\n'))
        const proofDir = process.env.PODIUM_CONNECTION_PROOF_DIR
        if (proofDir) {
          await mkdir(proofDir, { recursive: true })
          await second.screenshot({ path: resolve(proofDir, `${app}-connection.png`) })
        }
        sockets
          .get('one')!
          .send(
            JSON.stringify({
              type: 'serverRelocation',
              publicUrl: `http://127.0.0.1:${promoted.port}`,
              transferId: '00000000-0000-4000-8000-000000000001',
              claimToken: fixtureClaim,
            }),
          )
        await first.waitForURL(`http://127.0.0.1:${promoted.port}/auth/server-transfer-claim#**`, {
          timeout: 10_000,
        })
        const destination = new URL(first.url())
        results.push({
          app,
          relayed: true,
          cookieAuthenticated,
          reconnects,
          moved: destination.pathname === '/auth/server-transfer-claim',
          claimInFragment:
            destination.hash.includes(fixtureClaim) &&
            movedRequests.every((url) => !url.includes(fixtureClaim)),
        })
        await second.evaluate(() => (window as FixtureWindow).connectionProof.stop())
      } finally {
        await context.close()
        await authority.stop(true)
        await promoted.stop(true)
      }
    }
    return results
  } finally {
    await browser.close()
  }
}
