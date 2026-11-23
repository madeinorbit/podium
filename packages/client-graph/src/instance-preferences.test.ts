/**
 * THE INSTANCE SETTINGS IN THE POOL (POD-6677): one shared model for the one
 * record, moved by the record's arrival, and its feature flags joined from the
 * LiveStore's `welcome` facts and the record's own toggles.
 */
import { FEATURES, type ServerFeatureFacts } from '@podium/protocol'
import { autorun } from 'mobx'
import { afterEach, expect, it } from 'vitest'
import { featureEnabled, featureStates, instancePreferences } from './instance-preferences'
import { seedInstancePreferences } from './instance-preferences-fixture'
import { liveFixture } from './live-fixture'
import { MobxPool } from './pool'

const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})
const pool = () => {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pools.push(p)
  return p
}

/** A packaged stable server with this config override. */
const facts = (config: Record<string, boolean> = {}): ServerFeatureFacts => ({
  devMode: false,
  developmentBuild: false,
  flags: FEATURES.map((def) => ({
    ...def,
    ...(config[def.id] !== undefined ? { config: config[def.id] } : {}),
  })),
})

it('is absent until the record arrives, then one shared model the record moves', () => {
  const p = pool()
  expect(instancePreferences(p)).toBeUndefined()
  expect(featureStates(p)).toBeUndefined()
  expect(featureEnabled(p, 'git-panel')).toBe(false)

  seedInstancePreferences(p, { gitWorkflow: { defaultParentBranch: 'main' } })
  const model = instancePreferences(p)
  expect(model?.defaultParentBranch).toBe('main')
  // Defaults for every leaf the record does not name.
  expect(model?.hibernation.memoryPct).toBe(80)

  const seen: (number | null | undefined)[] = []
  const stop = autorun(() => seen.push(instancePreferences(p)?.loadPerCoreThreshold))
  try {
    // An admin's change on another device: the same model, moved.
    seedInstancePreferences(p, { hibernation: { loadPerCore: 2 } })
    expect(instancePreferences(p)).toBe(model)
    seedInstancePreferences(p, { hibernation: { enabled: false } })
    expect(seen).toEqual([1.5, 2, null])
  } finally {
    stop()
  }
  expect(model?.lifecycle.worktreeGc).toEqual({ mode: 'propose', afterDays: 14 })
})

it('joins the server’s facts with the saved toggles, and follows the toggles before a welcome', () => {
  const p = pool()
  seedInstancePreferences(p, { experimental: { 'git-panel': true, 'runtime-drivers': true } })
  // Offline start: no welcome yet, so each flag follows its saved toggle.
  expect(featureEnabled(p, 'git-panel')).toBe(true)
  expect(featureEnabled(p, 'workflows')).toBe(false)

  const live = liveFixture(p, () => 1_000)
  live.connection({
    state: 'online',
    since: 1_000,
    serverFeatures: facts({ 'runtime-drivers': false }),
  })
  // A stable server: an edge flag is not listed, so its toggle is not honoured.
  expect(featureEnabled(p, 'git-panel')).toBe(false)
  // config.json forces a flag off, whatever the toggle says, and locks it.
  const drivers = featureStates(p)?.flags.find((flag) => flag.id === 'runtime-drivers')
  expect(drivers).toMatchObject({ enabled: false, locked: true, source: 'config' })
  expect(featureStates(p)?.channel).toBe('stable')

  // The instance's stored channel moves the listing: the record decides it.
  seedInstancePreferences(p, {
    experimental: { 'git-panel': true },
    deployment: { updateChannel: 'edge' },
  })
  expect(featureStates(p)?.channel).toBe('edge')
  expect(featureEnabled(p, 'git-panel')).toBe(true)
})
