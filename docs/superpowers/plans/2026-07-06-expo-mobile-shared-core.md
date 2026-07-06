# Expo Mobile Shared Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first end-to-end Expo mobile web surface at `/mobile`, backed by one shared Podium client core consumed by both desktop web and mobile.

**Architecture:** Create `@podium/client-core` for app-neutral client behavior, then move the current pure focus selectors and storage-neutral write/outbox primitives into it before `apps/mobile` consumes them. `apps/web` keeps its UI but imports shared primitives through compatibility barrels, so desktop and mobile do not fork attention ordering, endpoint parsing, or queued-write semantics. `apps/mobile` is a separate Expo Router app configured as a single-page web export under `/mobile`; the server mounts it next to the existing desktop web bundle.

**Tech Stack:** TypeScript, Bun workspaces, Vitest, React 19, Expo Router, React Native / React Native Web, tRPC, Hono, `@podium/protocol`, `@podium/terminal-client`, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-06-expo-mobile-shared-core-design.md`

---

## Baseline and Constraints

- Worktree: `/home/user/src/other/podium/.worktrees/issue-80-expo-mobile-shared-core`
- Baseline before implementation:
  - `bun install --frozen-lockfile` passed.
  - `bun run typecheck` passed.
  - `bun test` failed before edits with `1596 pass / 245 fail / 109 errors`.
- Use narrow verification commands in each task. Do not use the full root test suite as a success gate until the existing baseline failures are repaired.
- Any dependency installation or Expo scaffold command may need network approval.
- Keep all product code in this worktree. Do not edit the main checkout.

## File Map

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/client-core/package.json` | shared package manifest and exports | create |
| `packages/client-core/tsconfig.json` | app-neutral TypeScript config | create |
| `packages/client-core/src/focus.ts` | attention grouping, summaries, recency, kanban lanes, mobile focus queue | create from `apps/web/src/home.ts` |
| `packages/client-core/src/focus.test.ts` | shared focus behavior tests | create |
| `packages/client-core/src/transport.ts` | server URL parsing and same-origin endpoint derivation | create from `apps/web/src/trpc.ts` |
| `packages/client-core/src/outbox.ts` | storage-neutral durable FIFO and mutation-id replay logic | create from `apps/web/src/outbox.ts` without browser storage |
| `packages/client-core/src/index.ts` | package barrel | create |
| `apps/web/src/home.ts` | web compatibility barrel for focus selectors | replace with re-exports |
| `apps/web/src/trpc.ts` | web tRPC factory plus shared endpoint re-exports | modify |
| `apps/web/src/outbox.ts` | web localStorage adapter plus shared outbox re-exports | modify |
| `apps/web/src/replica.ts` | import storage-neutral outbox types/functions from shared core | modify |
| `apps/web/package.json` | dependency on `@podium/client-core` | modify |
| `packages/terminal-client/package.json` | optional `./connection` and `./session-mount` source exports for mobile web adapter | modify |
| `apps/mobile/*` | new Expo Router mobile app | create |
| `apps/mobile/src/client/*` | mobile metadata provider, tRPC adapter, focus state | create |
| `apps/mobile/src/screens/*` | Focus, session detail, terminal, settings screens | create |
| `apps/mobile/src/terminal/*` | platform terminal adapters | create |
| `apps/server/src/static-web.ts` | static SPA mounting under `/` and `/mobile` | modify |
| `apps/server/src/server.ts` | register `/mobile` bundle and phone redirect | modify |
| `apps/server/src/static-web.test.ts` | static mount and redirect tests | modify |
| `scripts/systemd/podium-web.service` | build both desktop web and mobile web bundles | modify |
| `package.json`, `bun.lock` | workspace scripts and dependency lock updates | modify |

---

### Task 1: Create `@podium/client-core` and move Focus logic into it

**Files:**
- Create: `packages/client-core/package.json`
- Create: `packages/client-core/tsconfig.json`
- Create: `packages/client-core/src/index.ts`
- Create: `packages/client-core/src/focus.ts`
- Create: `packages/client-core/src/focus.test.ts`
- Modify: `apps/web/src/home.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Create the package manifest**

Create `packages/client-core/package.json`:

```json
{
  "name": "@podium/client-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "@podium/source": "./src/index.ts",
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    },
    "./focus": {
      "@podium/source": "./src/focus.ts",
      "types": "./src/focus.ts",
      "import": "./src/focus.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@podium/protocol": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

Create `packages/client-core/tsconfig.json`:

```json
{
  "extends": "../../tooling/tsconfig/base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Move the current focus implementation**

Run:

```bash
mkdir -p packages/client-core/src
cp apps/web/src/home.ts packages/client-core/src/focus.ts
```

Then replace `apps/web/src/home.ts` with:

```ts
export * from '@podium/client-core/focus'
```

Create `packages/client-core/src/index.ts`:

```ts
export * from './focus'
```

- [ ] **Step 4: Add the web dependency**

Add this dependency to `apps/web/package.json`:

```json
"@podium/client-core": "workspace:*"
```

Keep the existing dependencies sorted in the same local style as the surrounding `@podium/*` entries.

- [ ] **Step 5: Write shared focus tests**

Create `packages/client-core/src/focus.test.ts`:

```ts
import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  attentionGroup,
  attentionSummary,
  compareRecency,
  groupSessions,
  withoutShells,
} from './focus'

const needsUser = (since: string): AgentRuntimeState => ({
  phase: 'needs_user',
  since,
  openTaskCount: 0,
  need: { kind: 'question', summary: 'Need a decision' },
})

const working = (since: string): AgentRuntimeState => ({
  phase: 'working',
  since,
  openTaskCount: 0,
})

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    sessionId: over.sessionId,
    agentKind: 'claude-code',
    title: 'task',
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    ...over,
  }
}

describe('shared focus selectors', () => {
  it('classifies attention, working, and idle sessions', () => {
    expect(attentionGroup(meta({ sessionId: 'need', agentState: needsUser('2026-07-01T01:00:00.000Z') }))).toBe('needsYou')
    expect(attentionGroup(meta({ sessionId: 'work', agentState: working('2026-07-01T01:00:00.000Z') }))).toBe('working')
    expect(attentionGroup(meta({ sessionId: 'idle', status: 'exited' }))).toBe('idle')
  })

  it('uses the captured need summary on attention cards', () => {
    const s = meta({ sessionId: 'need', agentState: needsUser('2026-07-01T01:00:00.000Z') })
    expect(attentionSummary(s)).toBe('Need a decision')
  })

  it('orders each focus group by effective recency', () => {
    const old = meta({
      sessionId: 'old',
      lastActiveAt: '2026-07-01T01:00:00.000Z',
      agentState: needsUser('2026-07-01T01:00:00.000Z'),
    })
    const draft = meta({
      sessionId: 'draft',
      lastActiveAt: '2026-07-01T00:00:00.000Z',
      draftUpdatedAt: '2026-07-01T02:00:00.000Z',
      agentState: needsUser('2026-07-01T00:00:00.000Z'),
    })
    expect([old, draft].sort(compareRecency).map((s) => s.sessionId)).toEqual(['draft', 'old'])
    expect(groupSessions([old, draft]).needsYou.map((s) => s.sessionId)).toEqual(['draft', 'old'])
  })

  it('drops shells and headless sessions from command-center lists', () => {
    const agent = meta({ sessionId: 'agent' })
    const shell = meta({ sessionId: 'shell', agentKind: 'shell' })
    const headless = meta({ sessionId: 'headless', headless: true })
    expect(withoutShells([agent, shell, headless]).map((s) => s.sessionId)).toEqual(['agent'])
  })
})
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
bun run --filter @podium/client-core test
bun run --filter @podium/client-core typecheck
bun run --filter @podium/web test:unit -- src/home.test.ts src/recency-order.test.ts test/derive.test.ts
bun run --filter @podium/web typecheck
```

Expected: all four commands pass.

- [ ] **Step 7: Commit**

```bash
git add packages/client-core apps/web/src/home.ts apps/web/package.json bun.lock
git commit -m "feat(client-core): share focus selectors"
```

---

### Task 2: Move endpoint parsing into shared core and keep web on it

**Files:**
- Create: `packages/client-core/src/transport.ts`
- Create: `packages/client-core/src/transport.test.ts`
- Modify: `packages/client-core/package.json`
- Modify: `packages/client-core/src/index.ts`
- Modify: `apps/web/src/trpc.ts`

- [ ] **Step 1: Add the transport export**

Add this export to `packages/client-core/package.json`:

```json
"./transport": {
  "@podium/source": "./src/transport.ts",
  "types": "./src/transport.ts",
  "import": "./src/transport.ts"
}
```

Update `packages/client-core/src/index.ts`:

```ts
export * from './focus'
export * from './transport'
```

- [ ] **Step 2: Write transport tests**

Create `packages/client-core/src/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseServerOrigin, resolveServerConfig } from './transport'

describe('shared transport endpoint parsing', () => {
  it('accepts ws and http origins and normalizes to ws/http endpoint pairs', () => {
    expect(parseServerOrigin('ws://host.test:1234')).toMatchObject({
      wsClientUrl: expect.stringContaining('ws://host.test:1234/client?v='),
      httpOrigin: 'http://host.test:1234',
    })
    expect(parseServerOrigin('https://host.test')).toMatchObject({
      wsClientUrl: expect.stringContaining('wss://host.test/client?v='),
      httpOrigin: 'https://host.test',
    })
  })

  it('derives same-origin endpoints when no override exists', () => {
    const config = resolveServerConfig({
      protocol: 'https:',
      host: 'podium.test',
      origin: 'https://podium.test',
      search: '',
    })
    expect(config).toMatchObject({
      httpOrigin: 'https://podium.test',
      wsClientUrl: expect.stringContaining('wss://podium.test/client?v='),
      override: false,
    })
  })

  it('honors a server query override', () => {
    const config = resolveServerConfig({
      protocol: 'https:',
      host: 'podium.test',
      origin: 'https://podium.test',
      search: '?server=http://127.0.0.1:18787',
    })
    expect(config).toMatchObject({
      httpOrigin: 'http://127.0.0.1:18787',
      wsClientUrl: expect.stringContaining('ws://127.0.0.1:18787/client?v='),
      override: true,
    })
  })
})
```

- [ ] **Step 3: Implement shared transport**

Create `packages/client-core/src/transport.ts` by moving the endpoint types and parser functions from `apps/web/src/trpc.ts`. The final file must contain these exports:

```ts
import { WIRE_VERSION } from '@podium/protocol'

export type ServerOrigin = {
  wsClientUrl: string
  httpOrigin: string
}

export interface ServerConfig extends ServerOrigin {
  override: boolean
}

export interface LocationLike {
  protocol: string
  host: string
  origin: string
  search: string
}

export function parseServer(search: string): ServerOrigin | null {
  const server = new URLSearchParams(search).get('server')
  return server ? parseServerOrigin(server) : null
}

export function parseServerOrigin(server: string): ServerOrigin | null {
  let url: URL
  try {
    url = new URL(server)
  } catch {
    return null
  }

  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') return null

  const rawPortMatch = server.match(/^(?:wss?|https?):\/\/[^/:]+:(\d+)/)
  const explicitPort = rawPortMatch ? rawPortMatch[1] : url.port || ''
  const hostWithPort = explicitPort ? `${url.hostname}:${explicitPort}` : url.hostname
  const wsProto = secure ? 'wss:' : 'ws:'
  const httpProto = secure ? 'https:' : 'http:'
  return {
    wsClientUrl: `${wsProto}//${hostWithPort}/client?v=${WIRE_VERSION}`,
    httpOrigin: `${httpProto}//${hostWithPort}`,
  }
}

export function resolveServerConfig(loc: LocationLike, injected?: string): ServerConfig {
  const fromInjected = injected ? parseServerOrigin(injected) : null
  if (fromInjected) return { ...fromInjected, override: true }
  const parsed = parseServer(loc.search)
  if (parsed) return { ...parsed, override: true }
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    wsClientUrl: `${wsProto}//${loc.host}/client?v=${WIRE_VERSION}`,
    httpOrigin: loc.origin,
    override: false,
  }
}
```

- [ ] **Step 4: Rewire the web tRPC module**

Modify `apps/web/src/trpc.ts` so it imports and re-exports the shared transport functions, while keeping `makeTrpc` local because it depends on `@podium/server`:

```ts
import type { AppRouter } from '@podium/server'
import {
  parseServer,
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
  type ServerOrigin,
} from '@podium/client-core/transport'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type { ServerConfig, ServerOrigin }
export { parseServer, parseServerOrigin }
export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

export function serverConfig(loc: Location): ServerConfig {
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  return resolveServerConfig(loc, injected)
}

export function makeTrpc(httpOrigin: string): Trpc {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      }),
    ],
  })
}
```

- [ ] **Step 5: Run transport and web tests**

Run:

```bash
bun run --filter @podium/client-core test -- src/transport.test.ts
bun run --filter @podium/client-core typecheck
bun run --filter @podium/web typecheck
```

Expected: all three commands pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client-core apps/web/src/trpc.ts
git commit -m "feat(client-core): share server endpoint resolution"
```

---

### Task 3: Extract storage-neutral outbox into shared core

**Files:**
- Create: `packages/client-core/src/outbox.ts`
- Create: `packages/client-core/src/outbox.test.ts`
- Modify: `packages/client-core/package.json`
- Modify: `packages/client-core/src/index.ts`
- Modify: `apps/web/src/outbox.ts`
- Modify: `apps/web/src/replica.ts`
- Modify: `apps/web/src/outbox.test.ts`

- [ ] **Step 1: Add the outbox export**

Add this export to `packages/client-core/package.json`:

```json
"./outbox": {
  "@podium/source": "./src/outbox.ts",
  "types": "./src/outbox.ts",
  "import": "./src/outbox.ts"
}
```

Update `packages/client-core/src/index.ts`:

```ts
export * from './focus'
export * from './transport'
export * from './outbox'
```

- [ ] **Step 2: Move storage-neutral outbox code**

Copy `apps/web/src/outbox.ts` to `packages/client-core/src/outbox.ts`, then delete the browser-specific pieces from the shared file:

- Remove `OUTBOX_LS_KEY`.
- Remove `localStorageBacking`.
- Remove direct reads of `localStorage`.
- Replace `crypto.randomUUID()` with an injected `randomId`.
- Replace direct `window.addEventListener('online', ...)` with an optional `onlineEvents` adapter.

The shared initializer must include these fields:

```ts
export interface OnlineEvents {
  add(cb: () => void): void
  remove(cb: () => void): void
}

export interface OutboxInit<M extends Record<string, object>> {
  executors: OutboxExecutors<M>
  onPoison?: (entry: OutboxEntry, error: unknown) => void
  storage: OutboxStorage
  retryMs?: number
  isOnline?: () => boolean
  now?: () => number
  randomId?: () => string
  onlineEvents?: OnlineEvents
}
```

The constructor must set defaults with no browser globals:

```ts
this.retryMs = init.retryMs ?? 5000
this.entries = this.storage.load()
this.now = init.now ?? Date.now
this.randomId = init.randomId ?? (() => crypto.randomUUID())
```

The `attach` and `dispose` methods must only touch `onlineEvents`:

```ts
attach(): void {
  this.init.onlineEvents?.add(this.onOnline)
  if (this.entries.length > 0 && this.online()) queueMicrotask(() => void this.drain())
}

dispose(): void {
  this.init.onlineEvents?.remove(this.onOnline)
  this.clearRetry()
}
```

- [ ] **Step 3: Add shared outbox tests**

Create `packages/client-core/src/outbox.test.ts` by copying the non-browser tests from `apps/web/src/outbox.test.ts`. Use this in-memory storage helper so no DOM globals are required:

```ts
import type { OutboxStorage } from './outbox'

function memoryStorage(seed: string | null = null): { storage: OutboxStorage; raw: () => string | null } {
  let raw = seed
  return {
    storage: {
      load: () => parseOutboxEntries(raw),
      save: (entries) => {
        raw = JSON.stringify(entries)
      },
    },
    raw: () => raw,
  }
}
```

The tests must cover:

- FIFO drain with stable mutation ids.
- Reload from persisted storage.
- poison entry drop.
- network error retention and retry.
- single-flight drain.
- subscriber size notifications.
- corrupt storage reads as an empty queue.

Use `randomId: (() => { let n = 0; return () => `m-${++n}` })()` in tests so mutation ids are deterministic.

- [ ] **Step 4: Keep browser storage in the web adapter**

Replace `apps/web/src/outbox.ts` with a browser adapter plus re-exports:

```ts
import {
  Outbox,
  parseOutboxEntries,
  type OnlineEvents,
  type OutboxInit,
  type OutboxStorage,
} from '@podium/client-core/outbox'

export {
  Outbox,
  parseOutboxEntries,
  type OnlineEvents,
  type OutboxEntry,
  type OutboxExecutors,
  type OutboxInit,
  type OutboxStorage,
} from '@podium/client-core/outbox'

export const OUTBOX_LS_KEY = 'podium.outbox.v1'

export function localStorageBacking(key = OUTBOX_LS_KEY): OutboxStorage {
  return {
    load: () => {
      try {
        return parseOutboxEntries(localStorage.getItem(key))
      } catch {
        return []
      }
    },
    save: (entries) => {
      try {
        localStorage.setItem(key, JSON.stringify(entries))
      } catch {
        return
      }
    },
  }
}

function browserOnlineEvents(): OnlineEvents | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    add: (cb) => window.addEventListener('online', cb),
    remove: (cb) => window.removeEventListener('online', cb),
  }
}

export function createOutbox<M extends Record<string, object>>(
  init: Omit<OutboxInit<M>, 'storage' | 'onlineEvents'> & {
    storage?: OutboxStorage
    onlineEvents?: OnlineEvents
  },
): Outbox<M> {
  return new Outbox({
    ...init,
    storage: init.storage ?? localStorageBacking(),
    onlineEvents: init.onlineEvents ?? browserOnlineEvents(),
  })
}
```

- [ ] **Step 5: Update replica imports**

In `apps/web/src/replica.ts`, change outbox type/function imports so shared types come from `@podium/client-core/outbox` and browser storage remains from `./outbox`:

```ts
import {
  type OutboxEntry,
  type OutboxStorage,
  parseOutboxEntries,
} from '@podium/client-core/outbox'
import { localStorageBacking, OUTBOX_LS_KEY } from './outbox'
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
bun run --filter @podium/client-core test -- src/outbox.test.ts
bun run --filter @podium/client-core typecheck
bun run --filter @podium/web test:unit -- src/outbox.test.ts
bun run --filter @podium/web typecheck
```

Expected: all four commands pass.

- [ ] **Step 7: Commit**

```bash
git add packages/client-core apps/web/src/outbox.ts apps/web/src/outbox.test.ts apps/web/src/replica.ts
git commit -m "feat(client-core): share storage-neutral outbox"
```

---

### Task 4: Scaffold `apps/mobile` with Expo Router and shared core

**Files:**
- Create: `apps/mobile/*`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Scaffold the Expo app**

Run from the repo root:

```bash
bun create expo-app apps/mobile --template blank-typescript
```

Expected: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/tsconfig.json`, and starter source files exist. If the scaffolder creates a nested Git repository, remove only `apps/mobile/.git`:

```bash
test ! -d apps/mobile/.git || rm -rf apps/mobile/.git
```

- [ ] **Step 2: Install Router and web dependencies through Expo**

Run:

```bash
cd apps/mobile
bunx expo install expo-router react-dom react-native-web @expo/metro-runtime react-native-safe-area-context react-native-screens
bun add @podium/client-core@workspace:* @podium/protocol@workspace:* @podium/server@workspace:* @podium/terminal-client@workspace:* @trpc/client lucide-react-native
```

Expected: `apps/mobile/package.json` contains Expo-managed React Native dependencies plus workspace dependencies on Podium packages.

- [ ] **Step 3: Configure Expo web as a single-page export under `/mobile`**

Edit `apps/mobile/app.json` so the `expo` object contains:

```json
{
  "expo": {
    "name": "Podium Mobile",
    "slug": "podium-mobile",
    "scheme": "podium",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "experiments": {
      "baseUrl": "/mobile"
    },
    "web": {
      "bundler": "metro",
      "output": "single",
      "favicon": "./assets/favicon.png"
    },
    "plugins": ["expo-router"]
  }
}
```

`web.output: "single"` is required because Podium session routes are dynamic and unknown at build time.

- [ ] **Step 4: Configure package scripts**

Set `apps/mobile/package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "expo start --web --port 8082",
    "start": "expo start",
    "web": "expo start --web --port 8082",
    "build:web": "expo export -p web",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

- [ ] **Step 5: Replace generated entry with Router**

Create `apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { MobileClientProvider } from '../src/client/MobileClientProvider'

export default function RootLayout() {
  return (
    <MobileClientProvider>
      <View style={{ flex: 1, backgroundColor: '#101114' }}>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="light" />
      </View>
    </MobileClientProvider>
  )
}
```

Create `apps/mobile/app/index.tsx`:

```tsx
import { Redirect } from 'expo-router'

export default function Index() {
  return <Redirect href="/focus" />
}
```

- [ ] **Step 6: Add the initial provider shell**

Create `apps/mobile/src/client/MobileClientProvider.tsx`:

```tsx
import { createContext, type ReactNode, useContext } from 'react'

export interface MobileClientValue {
  ready: boolean
}

const MobileClientContext = createContext<MobileClientValue | null>(null)

export function MobileClientProvider({ children }: { children: ReactNode }) {
  return <MobileClientContext.Provider value={{ ready: true }}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
```

- [ ] **Step 7: Verify scaffold**

Run:

```bash
bun install --frozen-lockfile
bun run --filter @podium/mobile typecheck
bun run --filter @podium/mobile build:web
```

Expected: install and typecheck pass; `apps/mobile/dist/index.html` exists after export.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile package.json bun.lock
git commit -m "feat(mobile): scaffold Expo Router app"
```

---

### Task 5: Add mobile live metadata provider using shared transport and Focus selectors

**Files:**
- Create: `apps/mobile/src/client/trpc.ts`
- Create: `apps/mobile/src/client/metadata.ts`
- Modify: `apps/mobile/src/client/MobileClientProvider.tsx`
- Modify: `packages/terminal-client/package.json`

- [ ] **Step 1: Export connection-only terminal-client subpath**

Modify `packages/terminal-client/package.json` exports:

```json
"./connection": {
  "@podium/source": "./src/connection.ts",
  "types": "./src/connection.ts",
  "import": "./src/connection.ts"
}
```

This lets mobile metadata import `SocketHub` without Metro loading xterm view modules.

- [ ] **Step 2: Create mobile tRPC adapter**

Create `apps/mobile/src/client/trpc.ts`:

```ts
import { resolveServerConfig, type ServerConfig } from '@podium/client-core/transport'
import { WIRE_VERSION } from '@podium/protocol'
import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type MobileTrpc = ReturnType<typeof createTRPCClient<AppRouter>>

export function readServerConfig(): ServerConfig {
  if (typeof window === 'undefined') {
    return {
      wsClientUrl: `ws://127.0.0.1:18787/client?v=${WIRE_VERSION}`,
      httpOrigin: 'http://127.0.0.1:18787',
      override: false,
    }
  }
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  return resolveServerConfig(window.location, injected)
}

export function makeMobileTrpc(httpOrigin: string): MobileTrpc {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      }),
    ],
  })
}
```

- [ ] **Step 3: Create metadata state types**

Create `apps/mobile/src/client/metadata.ts`:

```ts
import type { ConversationSummaryWire, IssueWire, SessionMeta } from '@podium/protocol'

export interface MobileMetadataState {
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  connected: boolean
  error: string | null
}

export const EMPTY_METADATA: MobileMetadataState = {
  sessions: [],
  issues: [],
  conversations: [],
  connected: false,
  error: null,
}
```

- [ ] **Step 4: Wire `SocketHub` into the provider**

Replace `apps/mobile/src/client/MobileClientProvider.tsx` with:

```tsx
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client/connection'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { EMPTY_METADATA, type MobileMetadataState } from './metadata'
import { makeMobileTrpc, readServerConfig } from './trpc'

export interface MobileClientValue extends MobileMetadataState {
  sessionById(sessionId: string): SessionMeta | undefined
  issueById(issueId: string): IssueWire | undefined
}

const MobileClientContext = createContext<MobileClientValue | null>(null)

export function MobileClientProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(() => makeMobileTrpc(config.httpOrigin), [config.httpOrigin])
  const [metadata, setMetadata] = useState<MobileMetadataState>(EMPTY_METADATA)

  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio },
        fetchChangesSince: (cursor) => trpc.sync.changesSince.query({ cursor }),
        onMetadataApplied: (state) =>
          setMetadata({
            sessions: state.sessions,
            issues: state.issues,
            conversations: state.conversations,
            connected: true,
            error: null,
          }),
        onError: (message) => setMetadata((prev) => ({ ...prev, error: message })),
      }),
    [config.wsClientUrl, trpc],
  )

  useEffect(() => {
    const offSessions = hub.onSessions((sessions) => setMetadata((prev) => ({ ...prev, sessions })))
    const offIssues = hub.onIssues((issues) => setMetadata((prev) => ({ ...prev, issues })))
    const offConversations = hub.onConversations((conversations) =>
      setMetadata((prev) => ({ ...prev, conversations })),
    )
    const offHealth = hub.onConnectionHealth((health) =>
      setMetadata((prev) => ({ ...prev, connected: health.status !== 'down' })),
    )
    hub.connect()
    return () => {
      offSessions()
      offIssues()
      offConversations()
      offHealth()
      hub.close()
    }
  }, [hub])

  const value = useMemo<MobileClientValue>(
    () => ({
      ...metadata,
      sessionById: (sessionId) => metadata.sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => metadata.issues.find((i) => i.id === issueId),
    }),
    [metadata],
  )

  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
```

The `SocketHub` methods used here are current public methods in `packages/terminal-client/src/connection.ts`: `connect`, `close`, `onSessions`, `onIssues`, `onConversations`, and `onConnectionHealth`.

- [ ] **Step 5: Verify provider type safety**

Run:

```bash
bun run --filter @podium/mobile typecheck
bun run --filter @podium/terminal-client typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/client packages/terminal-client/package.json
git commit -m "feat(mobile): connect metadata through shared transport"
```

---

### Task 6: Build Focus home using shared Focus queue

**Files:**
- Create: `apps/mobile/app/focus.tsx`
- Create: `apps/mobile/src/screens/FocusScreen.tsx`
- Create: `apps/mobile/src/screens/focusStyles.ts`

- [ ] **Step 1: Add the route**

Create `apps/mobile/app/focus.tsx`:

```tsx
import { FocusScreen } from '../src/screens/FocusScreen'

export default FocusScreen
```

- [ ] **Step 2: Build the Focus screen**

Create `apps/mobile/src/screens/FocusScreen.tsx`:

```tsx
import { attentionSummary, groupSessions, relativeTime, withoutShells } from '@podium/client-core/focus'
import { useRouter } from 'expo-router'
import { ChevronRight, RefreshCcw } from 'lucide-react-native'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { styles } from './focusStyles'

export function FocusScreen() {
  const router = useRouter()
  const { sessions, issues, connected, error } = useMobileClient()
  const groups = groupSessions(withoutShells(sessions))
  const now = Date.now()
  const cards = [...groups.needsYou, ...groups.idle, ...groups.working]

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Focus</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, connected ? styles.dotOk : styles.dotDown]} />
          <Text style={styles.statusText}>{connected ? 'Live' : 'Reconnecting'}</Text>
        </View>
      </View>
      {error ? (
        <View style={styles.notice}>
          <RefreshCcw size={16} color="#f4c430" />
          <Text style={styles.noticeText}>{error}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.list}>
        {cards.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No active sessions</Text>
            <Text style={styles.emptyText}>Start an agent on desktop and it will appear here.</Text>
          </View>
        ) : (
          cards.map((session) => {
            const issue = session.issueId ? issues.find((i) => i.id === session.issueId) : undefined
            const summary = attentionSummary(session)
            return (
              <Pressable
                key={session.sessionId}
                accessibilityRole="button"
                style={styles.card}
                onPress={() => router.push(`/session/${session.sessionId}`)}
              >
                <View style={styles.cardMain}>
                  <Text numberOfLines={1} style={styles.cardTitle}>
                    {session.title || session.cwd.split('/').pop() || session.agentKind}
                  </Text>
                  <Text numberOfLines={1} style={styles.cardMeta}>
                    {session.agentKind} · {relativeTime(session.lastActiveAt, now)}
                  </Text>
                  {issue ? (
                    <Text numberOfLines={1} style={styles.issue}>
                      #{issue.seq} {issue.title}
                    </Text>
                  ) : null}
                  {summary ? <Text style={styles.summary}>{summary}</Text> : null}
                </View>
                <ChevronRight size={20} color="#9ca3af" />
              </Pressable>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}
```

- [ ] **Step 3: Add styles**

Create `apps/mobile/src/screens/focusStyles.ts`:

```ts
import { StyleSheet } from 'react-native'

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114', paddingTop: 56 },
  header: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: '#f8fafc', fontSize: 30, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOk: { backgroundColor: '#22c55e' },
  dotDown: { backgroundColor: '#ef4444' },
  statusText: { color: '#cbd5e1', fontSize: 13 },
  notice: {
    marginHorizontal: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#453b12',
    backgroundColor: '#211c0a',
    borderRadius: 8,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noticeText: { color: '#fde68a', flex: 1, fontSize: 13 },
  list: { paddingHorizontal: 14, paddingBottom: 32, gap: 10 },
  card: {
    minHeight: 104,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2f333a',
    backgroundColor: '#181a20',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardMain: { flex: 1, gap: 4 },
  cardTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  cardMeta: { color: '#94a3b8', fontSize: 12 },
  issue: { color: '#93c5fd', fontSize: 13 },
  summary: { color: '#facc15', fontSize: 13, lineHeight: 18 },
  empty: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2f333a',
    backgroundColor: '#181a20',
    padding: 18,
  },
  emptyTitle: { color: '#f8fafc', fontSize: 17, fontWeight: '700', marginBottom: 6 },
  emptyText: { color: '#94a3b8', fontSize: 14, lineHeight: 20 },
})
```

- [ ] **Step 4: Verify Focus route**

Run:

```bash
bun run --filter @podium/mobile typecheck
bun run --filter @podium/mobile build:web
```

Expected: typecheck passes and `apps/mobile/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app apps/mobile/src/screens
git commit -m "feat(mobile): add Focus home"
```

---

### Task 7: Add session detail with transcript-first layout and next/back flow

**Files:**
- Create: `apps/mobile/app/session/[sessionId].tsx`
- Create: `apps/mobile/src/client/outbox.ts`
- Create: `apps/mobile/src/screens/SessionScreen.tsx`
- Modify: `apps/mobile/src/client/MobileClientProvider.tsx`

- [ ] **Step 1: Add mobile outbox adapter**

Create `apps/mobile/src/client/outbox.ts`:

```ts
import {
  Outbox,
  parseOutboxEntries,
  type OnlineEvents,
  type OutboxInit,
  type OutboxStorage,
} from '@podium/client-core/outbox'

export const MOBILE_OUTBOX_LS_KEY = 'podium.mobile.outbox.v1'

export function mobileStorageBacking(key = MOBILE_OUTBOX_LS_KEY): OutboxStorage {
  return {
    load: () => {
      if (typeof localStorage === 'undefined') return []
      try {
        return parseOutboxEntries(localStorage.getItem(key))
      } catch {
        return []
      }
    },
    save: (entries) => {
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(key, JSON.stringify(entries))
      } catch {
        return
      }
    },
  }
}

function browserOnlineEvents(): OnlineEvents | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    add: (cb) => window.addEventListener('online', cb),
    remove: (cb) => window.removeEventListener('online', cb),
  }
}

export function createMobileOutbox<M extends Record<string, object>>(
  init: Omit<OutboxInit<M>, 'storage' | 'onlineEvents'> & {
    storage?: OutboxStorage
    onlineEvents?: OnlineEvents
  },
): Outbox<M> {
  return new Outbox({
    ...init,
    storage: init.storage ?? mobileStorageBacking(),
    onlineEvents: init.onlineEvents ?? browserOnlineEvents(),
  })
}
```

- [ ] **Step 2: Add mobile client actions**

Extend `MobileClientValue` in `apps/mobile/src/client/MobileClientProvider.tsx`:

```ts
readTranscript(sessionId: string): Promise<{ items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }>
subscribeTranscript(
  sessionId: string,
  since: string | undefined,
  cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
): () => void
sendMessage(sessionId: string, text: string): Promise<void>
focusSessionIds: string[]
outboxSize: number
```

Add imports:

```ts
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { TranscriptItem } from '@podium/protocol'
import { useCallback } from 'react'
import { createMobileOutbox } from './outbox'
```

Add the mobile outbox kind:

```ts
type MobileOutboxKinds = {
  resumeAndSend: { sessionId: string; text: string }
}
```

Inside `MobileClientProvider`, after `trpc` is created, add:

```tsx
const outbox = useMemo(
  () =>
    createMobileOutbox<MobileOutboxKinds>({
      executors: {
        resumeAndSend: (input) => trpc.sessions.resumeAndSend.mutate(input),
      },
      onPoison: () =>
        setMetadata((prev) => ({
          ...prev,
          error: 'A queued message was rejected by the server.',
        })),
    }),
  [trpc],
)
const [outboxSize, setOutboxSize] = useState(0)

useEffect(() => {
  setOutboxSize(outbox.size())
  const off = outbox.subscribe(setOutboxSize)
  outbox.attach()
  return () => {
    off()
    outbox.dispose()
  }
}, [outbox])

const focusSessionIds = useMemo(() => {
  const groups = groupSessions(withoutShells(metadata.sessions))
  return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
}, [metadata.sessions])
```

Modify the existing connection-health observer so queued sends drain after a server restart. Update that effect's dependency list from `[hub]` to `[hub, outbox]`:

```tsx
const offHealth = hub.onConnectionHealth((health) => {
  if (health.status === 'ok') outbox.notifyConnected()
  setMetadata((prev) => ({ ...prev, connected: health.status !== 'down' }))
})
```

Create stable callbacks before the provider value:

```tsx
const readTranscript = useCallback(
  (sessionId: string) =>
    trpc.sessions.transcriptRead.query({ sessionId, direction: 'before', limit: 80 }),
  [trpc],
)

const subscribeTranscript = useCallback(
  (sessionId: string, since: string | undefined, cb: (items: TranscriptItem[], meta: { reset: boolean }) => void) =>
    hub.subscribeTranscript(sessionId, since, cb),
  [hub],
)

const sendMessage = useCallback(
  async (sessionId: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    outbox.enqueue('resumeAndSend', { sessionId, text: trimmed })
  },
  [outbox],
)
```

In the provider value, add these properties and include them in the value `useMemo` dependency list:

```ts
focusSessionIds,
outboxSize,
readTranscript,
subscribeTranscript,
sendMessage,
```

- [ ] **Step 3: Add route file**

Create `apps/mobile/app/session/[sessionId].tsx`:

```tsx
import { useLocalSearchParams } from 'expo-router'
import { SessionScreen } from '../../src/screens/SessionScreen'

export default function SessionRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  return <SessionScreen sessionId={sessionId} />
}
```

- [ ] **Step 4: Create transcript-first session screen**

Create `apps/mobile/src/screens/SessionScreen.tsx`:

```tsx
import { relativeTime } from '@podium/client-core/focus'
import type { TranscriptItem } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { ChevronLeft, Send, TerminalSquare } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const { sessionById, sendMessage, focusSessionIds, readTranscript, subscribeTranscript } = useMobileClient()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loadingTranscript, setLoadingTranscript] = useState(true)
  const session = sessionById(sessionId)
  const nextId = useMemo(() => {
    const idx = focusSessionIds.indexOf(sessionId)
    if (idx < 0 || focusSessionIds.length < 2) return null
    return focusSessionIds[(idx + 1) % focusSessionIds.length] ?? null
  }, [focusSessionIds, sessionId])

  useEffect(() => {
    let active = true
    let off: (() => void) | undefined
    setLoadingTranscript(true)
    setItems([])
    readTranscript(sessionId)
      .then((page) => {
        if (!active) return
        setItems(page.items)
        off = subscribeTranscript(sessionId, page.tail, (delta, meta) => {
          if (meta.reset) {
            void readTranscript(sessionId).then((fresh) => {
              if (active) setItems(fresh.items)
            })
            return
          }
          setItems((prev) => [...prev, ...delta])
        })
      })
      .finally(() => {
        if (active) setLoadingTranscript(false)
      })
    return () => {
      active = false
      off?.()
    }
  }, [readTranscript, sessionId, subscribeTranscript])

  if (!session) {
    return (
      <View style={styles.screen}>
        <Pressable style={styles.back} onPress={() => router.back()}>
          <ChevronLeft size={20} color="#e5e7eb" />
          <Text style={styles.backText}>Focus</Text>
        </Pressable>
        <Text style={styles.missing}>Session not found.</Text>
      </View>
    )
  }

  const submit = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await sendMessage(session.sessionId, text)
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable style={styles.back} onPress={() => router.back()}>
          <ChevronLeft size={20} color="#e5e7eb" />
          <Text style={styles.backText}>Focus</Text>
        </Pressable>
        {nextId ? (
          <Pressable style={styles.next} onPress={() => router.replace(`/session/${nextId}`)}>
            <Text style={styles.nextText}>Next</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.header}>
        <Text numberOfLines={2} style={styles.title}>
          {session.title || session.cwd}
        </Text>
        <Text style={styles.meta}>
          {session.agentKind} · {session.status} · {relativeTime(session.lastActiveAt, Date.now())}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.timeline}>
        {loadingTranscript ? <Text style={styles.timelineText}>Loading transcript...</Text> : null}
        {!loadingTranscript && items.length === 0 ? (
          <Text style={styles.timelineText}>No transcript yet.</Text>
        ) : null}
        {items.map((item) => (
          <View key={item.id} style={item.role === 'user' ? styles.userBubble : styles.agentBubble}>
            <Text style={styles.role}>{item.role}</Text>
            <Text style={styles.timelineText}>
              {item.text || item.toolTitle || item.toolResult || item.toolName || 'Event'}
            </Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.composerRow}>
        <Pressable style={styles.terminalButton} onPress={() => router.push(`/session/${sessionId}/terminal`)}>
          <TerminalSquare size={20} color="#d1d5db" />
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Reply to this agent"
          placeholderTextColor="#64748b"
          style={styles.input}
          multiline
        />
        <Pressable style={styles.sendButton} onPress={submit} disabled={sending || !draft.trim()}>
          <Send size={18} color="#101114" />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114', paddingTop: 48 },
  topbar: { height: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  next: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: '#e5e7eb' },
  nextText: { color: '#111827', fontWeight: '700' },
  header: { paddingHorizontal: 18, paddingBottom: 12 },
  title: { color: '#f8fafc', fontSize: 22, fontWeight: '800', lineHeight: 28 },
  meta: { color: '#94a3b8', fontSize: 13, marginTop: 4 },
  timeline: { padding: 18, gap: 12 },
  timelineText: { color: '#cbd5e1', fontSize: 15, lineHeight: 22 },
  role: { color: '#94a3b8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  userBubble: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 8, backgroundColor: '#1d4ed8', padding: 12 },
  agentBubble: { alignSelf: 'flex-start', maxWidth: '94%', borderRadius: 8, backgroundColor: '#181a20', padding: 12, borderWidth: 1, borderColor: '#2f333a' },
  composerRow: { padding: 12, borderTopWidth: 1, borderTopColor: '#272b33', flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  terminalButton: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#20242c' },
  input: { flex: 1, maxHeight: 120, minHeight: 42, borderRadius: 8, backgroundColor: '#181a20', color: '#f8fafc', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  sendButton: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' },
  missing: { color: '#f8fafc', fontSize: 18, padding: 18 },
})
```

- [ ] **Step 5: Verify session route**

Run:

```bash
bun run --filter @podium/mobile typecheck
bun run --filter @podium/mobile build:web
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/session apps/mobile/src/screens/SessionScreen.tsx apps/mobile/src/client/MobileClientProvider.tsx apps/mobile/src/client/outbox.ts
git commit -m "feat(mobile): add session detail flow"
```

---

### Task 8: Add terminal route and platform adapters

**Files:**
- Create: `apps/mobile/app/session/[sessionId]/terminal.tsx`
- Create: `apps/mobile/src/terminal/TerminalPane.web.tsx`
- Create: `apps/mobile/src/terminal/TerminalPane.native.tsx`
- Modify: `packages/terminal-client/package.json`

- [ ] **Step 1: Export session mount subpath**

Add this export to `packages/terminal-client/package.json`:

```json
"./session-mount": {
  "@podium/source": "./src/session-mount.ts",
  "types": "./src/session-mount.ts",
  "import": "./src/session-mount.ts"
}
```

- [ ] **Step 2: Add terminal route**

Create `apps/mobile/app/session/[sessionId]/terminal.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TerminalPane } from '../../../src/terminal/TerminalPane'

export default function TerminalRoute() {
  const router = useRouter()
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  return (
    <View style={styles.screen}>
      <Pressable style={styles.back} onPress={() => router.back()}>
        <ChevronLeft size={20} color="#e5e7eb" />
        <Text style={styles.backText}>Session</Text>
      </Pressable>
      <TerminalPane sessionId={sessionId} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#050608', paddingTop: 48 },
  back: { height: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
})
```

- [ ] **Step 3: Add native limited adapter**

Create `apps/mobile/src/terminal/TerminalPane.native.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'

export function TerminalPane({ sessionId }: { sessionId: string }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Terminal</Text>
      <Text style={styles.text}>
        Native terminal control for {sessionId} is not enabled in this build. Use the transcript and composer, or open the Expo web route for terminal control.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { margin: 16, padding: 16, borderRadius: 8, backgroundColor: '#111827', borderWidth: 1, borderColor: '#374151' },
  title: { color: '#f9fafb', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  text: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
})
```

- [ ] **Step 4: Add Expo web xterm adapter**

Create `apps/mobile/src/terminal/TerminalPane.web.tsx`:

```tsx
import { SocketHub } from '@podium/terminal-client/connection'
import { mountSession, type MountedSession } from '@podium/terminal-client/session-mount'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { readServerConfig } from '../client/trpc'

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const el = useRef<HTMLDivElement | null>(null)
  const mounted = useRef<MountedSession | null>(null)
  const [ready, setReady] = useState(false)
  const config = useMemo(readServerConfig, [])
  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: window.devicePixelRatio || 1 },
      }),
    [config.wsClientUrl],
  )

  useEffect(() => {
    hub.connect()
    return () => hub.close()
  }, [hub])

  useEffect(() => {
    if (!el.current) return
    mounted.current = mountSession(el.current, {
      hub,
      sessionId,
      active: true,
      focusOnMount: true,
      onReady: () => setReady(true),
    })
    return () => {
      mounted.current?.dispose()
      mounted.current = null
    }
  }, [hub, sessionId])

  return (
    <View style={{ flex: 1 }}>
      {!ready ? <Text style={{ color: '#94a3b8', padding: 12 }}>Connecting terminal...</Text> : null}
      <div ref={el} style={{ flex: 1, minHeight: 420, height: 'calc(100vh - 92px)', width: '100%' }} />
    </View>
  )
}
```

- [ ] **Step 5: Verify terminal route**

Run:

```bash
bun run --filter @podium/mobile typecheck
bun run --filter @podium/terminal-client typecheck
bun run --filter @podium/mobile build:web
```

Expected: all three commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/session apps/mobile/src/terminal packages/terminal-client/package.json
git commit -m "feat(mobile): add terminal route adapters"
```

---

### Task 9: Serve Expo web at `/mobile` and add phone redirect

**Files:**
- Modify: `apps/server/src/static-web.ts`
- Modify: `apps/server/src/static-web.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `scripts/systemd/podium-web.service`

- [ ] **Step 1: Add static SPA mount tests**

Extend `apps/server/src/static-web.test.ts` with:

```ts
it('serves a second SPA under /mobile without shadowing APIs', async () => {
  const mobile = mkdtempSync(join(tmpdir(), 'podium-mobile-'))
  try {
    writeFileSync(join(mobile, 'index.html'), '<!doctype html><title>Podium Mobile</title>')
    mkdirSync(join(mobile, '_expo'))
    writeFileSync(join(mobile, '_expo/app.js'), 'console.log("mobile")')
    const app = new Hono()
    app.get('/trpc/x', (c) => c.text('api'))
    expect(registerWebStatic(app, mobile, { basePath: '/mobile' })).toBe(true)
    expect(await (await app.request('/mobile')).text()).toContain('Podium Mobile')
    expect(await (await app.request('/mobile/session/s1')).text()).toContain('Podium Mobile')
    expect(await (await app.request('/mobile/_expo/app.js')).text()).toContain('mobile')
    expect(await (await app.request('/trpc/x')).text()).toBe('api')
  } finally {
    rmSync(mobile, { recursive: true, force: true })
  }
})

it('redirects mobile browsers from / to /mobile unless desktop is requested', async () => {
  const app = new Hono()
  registerMobileRedirect(app)
  app.get('/', (c) => c.text('desktop'))
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
  expect((await app.request('/', { headers: { 'user-agent': iphone } })).status).toBe(302)
  expect(await (await app.request('/', { headers: { 'user-agent': iphone, cookie: 'podium_desktop=1' } })).text()).toBe('desktop')
  expect((await app.request('/desktop', { headers: { 'user-agent': iphone } })).status).toBe(302)
})
```

- [ ] **Step 2: Implement `basePath` static serving and redirect helper**

Modify `apps/server/src/static-web.ts`:

```ts
export interface StaticWebOptions {
  basePath?: string
}

function routePattern(basePath: string): string {
  return basePath === '/' ? '/*' : `${basePath}/*`
}

function pathInsideBase(pathname: string, basePath: string): string | null {
  if (basePath === '/') return pathname
  if (pathname === basePath) return '/'
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || '/'
  return null
}

export function registerWebStatic(app: Hono, webDir: string, opts: StaticWebOptions = {}): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false
  const basePath = opts.basePath ?? '/'
  const handler = (c: Parameters<Parameters<Hono['get']>[1]>[0]) => {
    const pathname = new URL(c.req.url).pathname
    const inside = pathInsideBase(pathname, basePath)
    if (inside === null) return c.notFound()
    if (BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(`${pre}/`))) {
      return c.notFound()
    }
    const rel = normalize(decodeURIComponent(inside)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    if (
      (filePath === webDir || filePath.startsWith(webDir + sep)) &&
      existsSync(filePath) &&
      statSync(filePath).isFile()
    ) {
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    return new Response(readFileSync(join(webDir, 'index.html'), 'utf8'), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  if (basePath !== '/') app.get(basePath, handler)
  app.get(routePattern(basePath), handler)
  return true
}

function wantsMobile(userAgent: string): boolean {
  return /Android|iPhone|iPod|Mobile/i.test(userAgent) && !/iPad|Tablet/i.test(userAgent)
}

export function registerMobileRedirect(app: Hono): void {
  app.get('/desktop', (c) => {
    c.header('Set-Cookie', 'podium_desktop=1; Path=/; SameSite=Lax; Max-Age=2592000')
    return c.redirect('/')
  })
  app.use('/', async (c, next) => {
    const cookie = c.req.header('cookie') ?? ''
    if (!cookie.includes('podium_desktop=1') && wantsMobile(c.req.header('user-agent') ?? '')) {
      return c.redirect('/mobile')
    }
    await next()
  })
}
```

If the Hono handler type is awkward, define a local `type Handler = Parameters<Hono['get']>[1]` and use `const handler: Handler = (c) => { ... }`.

- [ ] **Step 3: Register mobile assets in the server**

In `apps/server/src/server.ts`, import `registerMobileRedirect`:

```ts
import { registerMobileRedirect, registerWebStatic } from './static-web'
```

Before `registerWebStatic(app, webDir)`, resolve and register mobile:

```ts
registerMobileRedirect(app)

let mobileWebDir = process.env.PODIUM_MOBILE_WEB_DIR
if (!mobileWebDir) {
  try {
    mobileWebDir = fileURLToPath(new URL('../../mobile/dist', import.meta.url))
  } catch {
    mobileWebDir = ''
  }
}
if (mobileWebDir) registerWebStatic(app, mobileWebDir, { basePath: '/mobile' })
```

Then keep the existing desktop `webDir` registration after mobile.

- [ ] **Step 4: Build mobile web in the web systemd unit**

Modify `scripts/systemd/podium-web.service` so `ExecStart` builds both bundles:

```ini
ExecStart=/usr/bin/env bash -lc 'cd %h/src/other/podium && bun run --filter @podium/web build && bun run --filter @podium/mobile build:web'
```

Keep existing comments about the backend serving the built bundle and update them to mention `apps/mobile/dist` under `/mobile`.

- [ ] **Step 5: Verify server routing**

Run:

```bash
bun run vitest run apps/server/src/static-web.test.ts
bun run --filter @podium/server typecheck
bun run --filter @podium/mobile build:web
```

Expected: all three commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/static-web.ts apps/server/src/static-web.test.ts apps/server/src/server.ts scripts/systemd/podium-web.service
git commit -m "feat(server): serve Expo mobile web under /mobile"
```

---

### Task 10: Runtime verification with Playwright

**Files:**
- Create: `tests/e2e/mobile-web-smoke.spec.ts`

- [ ] **Step 1: Add Playwright smoke test**

Create `tests/e2e/mobile-web-smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

test('mobile web serves focus route and desktop escape', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await context.setExtraHTTPHeaders({
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/mobile/)
  await expect(page.getByText('Focus')).toBeVisible()
  await page.goto('/desktop')
  await expect(page).toHaveURL(/\/$/)
})
```

- [ ] **Step 2: Start local dev stack**

Run:

```bash
bun run --filter @podium/mobile build:web
bun run --filter @podium/web build
PODIUM_WEB_DIR=apps/web/dist PODIUM_MOBILE_WEB_DIR=apps/mobile/dist bun --conditions=@podium/source scripts/server.ts
```

Expected: server prints `podium server up` with a localhost port. Keep that terminal running for the next step.

- [ ] **Step 3: Run the smoke test against the server**

In another terminal, using the printed port:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:18787 bunx playwright test tests/e2e/mobile-web-smoke.spec.ts
```

Expected: the test passes. If the server selected a different port, replace `18787` with the printed port.

- [ ] **Step 4: Manual terminal verification**

Open `http://127.0.0.1:18787/mobile` in a phone viewport. Verify:

- Focus screen renders without desktop breakpoint UI.
- Tapping a session opens `/mobile/session/<id>`.
- Back returns to Focus.
- Next moves to another session when at least two sessions exist.
- Terminal route `/mobile/session/<id>/terminal` shows the xterm surface on web.

Record any terminal attach failure with the exact browser console error and the session id.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/mobile-web-smoke.spec.ts
git commit -m "test(e2e): cover mobile web routing smoke"
```

---

### Task 11: Final verification and issue update

**Files:**
- No source files unless verification exposes a bug.

- [ ] **Step 1: Run focused verification**

Run:

```bash
bun run --filter @podium/client-core test
bun run --filter @podium/client-core typecheck
bun run --filter @podium/web typecheck
bun run --filter @podium/mobile typecheck
bun run --filter @podium/mobile build:web
bun run vitest run apps/server/src/static-web.test.ts
```

Expected: all commands pass.

- [ ] **Step 2: Run baseline-aware root checks**

Run:

```bash
bun run typecheck
bun test
```

Expected: `bun run typecheck` passes. `bun test` is allowed to fail only in the same pre-existing categories captured before implementation: environment/version, DOM-under-Bun, node-pty/tmux, and `node:sqlite`/Vitest API issues. If a new failure mentions `client-core`, `apps/mobile`, `/mobile`, static web serving, or focus selectors, fix it before continuing.

- [ ] **Step 3: Update issue #80**

Run:

```bash
podium issue state 80 --set "Implementation complete in issue/80-expo-mobile-shared-core: shared @podium/client-core created, desktop web consumes shared focus/transport/outbox primitives, apps/mobile Expo web Focus/session/terminal routes added, and server serves /mobile with phone redirect + desktop escape. Focused verification passed; root bun test still has pre-existing baseline failures if unchanged."
```

- [ ] **Step 4: Prepare handoff**

Run:

```bash
git status --short
git log --oneline --max-count=12
```

Expected: status is clean; log shows the implementation commits from this plan.
