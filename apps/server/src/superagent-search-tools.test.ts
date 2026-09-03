import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { forceFeature } from './test-support/features'

/**
 * The belt never offers a search it cannot back [PDM-25].
 *
 * `search_conversations` and `search_all` answer out of the full-text index, and
 * whether that index exists is decided once, when the store is constructed. So
 * the tools follow the store, not a re-read of the flag: an assistant told about
 * a tool that returns nothing is worse than one that was never offered it.
 */

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

async function toolNames(): Promise<string[]> {
  const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const sa = SuperagentService.create(registry.modules, repos, registry.sessionStore)
  sa.history(FIRST_ADMIN_USER_ID)
  return sa.mcpToolSpecs().map((t) => t.name)
}

describe('superagent search tools', () => {
  it('are absent when the search index is off', async () => {
    forceFeature('command-palette', false)
    const names = await toolNames()
    expect(names).not.toContain('search_conversations')
    expect(names).not.toContain('search_all')
    // Only search goes; the rest of the belt is untouched.
    expect(names).toContain('list_sessions')
  })

  it('are offered when the search index is on', async () => {
    forceFeature('command-palette', true)
    const names = await toolNames()
    expect(names).toContain('search_conversations')
    expect(names).toContain('search_all')
  })
})
