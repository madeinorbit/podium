import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  ConversationDiscoveryCache,
  compareConversationSummaries,
  loadAgentConversation,
  scanAgentConversations,
  scanAgentConversationsCached,
} from '../packages/agent-bridge/src/discovery/index.js'

type Timed<T> = { label: string; ms: number; value: T }

async function time<T>(label: string, fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now()
  const value = await fn()
  return { label, ms: performance.now() - start, value }
}

function timeSync<T>(label: string, fn: () => T): Timed<T> {
  const start = performance.now()
  const value = fn()
  return { label, ms: performance.now() - start, value }
}

function print(label: string, ms: number, conversations: number, diagnostics: number): void {
  console.log(
    `${label}: ${ms.toFixed(1)}ms (${conversations} conversations, ${diagnostics} diagnostics)`,
  )
}

const homeDir = process.env.HOME ?? process.cwd()
const cachePath =
  process.env.PODIUM_DISCOVERY_BENCH_DB ?? join(tmpdir(), 'podium-discovery-benchmark.db')

const fullParse = await time('legacy full parse all transcripts', async () => {
  const scan = await scanAgentConversations({ homeDir })
  const loaded = await Promise.allSettled(
    scan.conversations.map((summary) => loadAgentConversation(summary)),
  )
  return {
    conversations: scan.conversations,
    diagnostics: [
      ...scan.diagnostics,
      ...loaded
        .filter((result) => result.status === 'rejected')
        .map(() => ({ severity: 'warning' as const, message: 'load failed' })),
    ],
  }
})
print(
  fullParse.label,
  fullParse.ms,
  fullParse.value.conversations.length,
  fullParse.value.diagnostics.length,
)

const full = await time('head-only uncached scan', () => scanAgentConversations({ homeDir }))
print(full.label, full.ms, full.value.conversations.length, full.value.diagnostics.length)

const fillCache = new ConversationDiscoveryCache(cachePath)
const coldQuick = await time('quick scan cache fill', () =>
  scanAgentConversationsCached({ cache: fillCache, homeDir }),
)
print(
  coldQuick.label,
  coldQuick.ms,
  coldQuick.value.conversations.length,
  coldQuick.value.diagnostics.length,
)
fillCache.close()

const persistedCache = new ConversationDiscoveryCache(cachePath)
const persisted = timeSync('persisted cache load', () =>
  persistedCache.listSummaries().sort(compareConversationSummaries),
)
print(persisted.label, persisted.ms, persisted.value.length, 0)

const warmQuick = await time('warm quick scan', () =>
  scanAgentConversationsCached({ cache: persistedCache, homeDir }),
)
print(
  warmQuick.label,
  warmQuick.ms,
  warmQuick.value.conversations.length,
  warmQuick.value.diagnostics.length,
)
persistedCache.close()
console.log(`cache: ${cachePath}`)
