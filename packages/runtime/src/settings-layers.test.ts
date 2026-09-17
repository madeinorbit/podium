import { describe, expect, it } from 'vitest'
import {
  LAYERED_KEYS,
  LAYERED_ENV,
  LAYERED_SCOPES,
  resolveSetting,
  type LayeredKey,
  type LayeredSettings,
  type PodiumConfig,
} from './config'

const probe = 'ed25519:' + 'A'.repeat(43)
const cases: Record<
  LayeredKey,
  { env: Record<string, string>; file: PodiumConfig; value: unknown }
> = {
  telemetryInstallId: {
    env: {},
    file: { telemetry: { installId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe' } },
    value: '2b170e96-009a-4adb-8ff9-65dbf5b243fe',
  },
  telemetrySince: { env: {}, file: { telemetry: { since: 123 } }, value: 123 },
  authOpenMode: { env: {}, file: { auth: { openMode: true } }, value: true },
  port: { env: { PODIUM_PORT: '23456' }, file: { port: 23456 }, value: 23456 },
  hookPort: { env: { PODIUM_HOOK_PORT: '23457' }, file: { hookPort: 23457 }, value: 23457 },
  agentRelayPort: {
    env: { PODIUM_AGENT_RELAY_PORT: '23458' },
    file: { agentRelayPort: 23458 },
    value: 23458,
  },
  agentHome: {
    env: { PODIUM_AGENT_HOME: '/tmp/agent' },
    file: { agentHome: '/tmp/agent' },
    value: '/tmp/agent',
  },
  mode: { env: { PODIUM_MODE: 'server' }, file: { mode: 'server' }, value: 'server' },
  publicUrl: {
    env: { PODIUM_PUBLIC_URL: 'https://server.test' },
    file: { publicUrl: 'https://server.test' },
    value: 'https://server.test',
  },
  appUrl: {
    env: { PODIUM_APP_URL: 'https://app.test' },
    file: { appUrl: 'https://app.test' },
    value: 'https://app.test',
  },
  allowedOrigins: {
    env: { PODIUM_ALLOWED_ORIGINS: 'https://app.test' },
    file: { allowedOrigins: ['https://app.test'] },
    value: ['https://app.test'],
  },
  authMode: {
    env: { PODIUM_AUTH_MODE: 'cloud' },
    file: { auth: { mode: 'cloud' } },
    value: 'cloud',
  },
  authSignInUrl: {
    env: { PODIUM_AUTH_SIGN_IN_URL: 'https://login.test' },
    file: { auth: { signInUrl: 'https://login.test' } },
    value: 'https://login.test',
  },
  updateChannel: {
    env: { PODIUM_UPDATE_CHANNEL: 'dev' },
    file: { updateChannel: 'dev' },
    value: 'dev',
  },
  updateFeed: {
    env: { PODIUM_UPDATE_FEED: 'https://feed.test' },
    file: { updateFeed: 'https://feed.test' },
    value: 'https://feed.test',
  },
  updateScope: {
    env: { PODIUM_UPDATE_SCOPE: 'fleet-only' },
    file: { updateScope: 'fleet-only' },
    value: 'fleet-only',
  },
  transcriptLake: {
    env: { PODIUM_TRANSCRIPT_LAKE: 'off' },
    file: { transcriptLake: 'off' },
    value: 'off',
  },
  connectEnabled: {
    env: { PODIUM_CONNECT: 'off' },
    file: { connect: { enabled: false } },
    value: false,
  },
  connectBaseUrl: {
    env: { PODIUM_CONNECT_URL: 'https://connect.test' },
    file: { connect: { baseUrl: 'https://connect.test' } },
    value: 'https://connect.test',
  },
  connectProbeKeys: {
    env: { PODIUM_CONNECT_PROBE_KEYS: probe },
    file: { connect: { trustedProbeKeys: [probe] } },
    value: [probe],
  },
  telemetryUsage: {
    env: { PODIUM_TELEMETRY: 'off' },
    file: { telemetry: { usage: 'off' } },
    value: 'off',
  },
  telemetryCrash: {
    env: { PODIUM_TELEMETRY: 'off' },
    file: { telemetry: { crash: 'off' } },
    value: 'off',
  },
}

describe('settings layer precedence and scopes', () => {
  it.each(LAYERED_KEYS)('%s resolves each applicable layer with provenance', (key) => {
    const { env, file, value } = cases[key]
    const table = { [key]: value } as LayeredSettings
    expect(resolveSetting(key, file, env, table)).toMatchObject({
      value,
      source: LAYERED_ENV[key] === undefined ? 'file' : 'env',
    })
    expect(resolveSetting(key, file, {}, table)).toEqual({ value, source: 'file' })
    const stored = resolveSetting(key, {}, {}, table)
    if (LAYERED_SCOPES[key] === 'instance') expect(stored).toEqual({ value, source: 'settings' })
    else expect(stored.source).toBe('default')
    expect(resolveSetting(key, {}, {}, {}).source).toBe('default')
  })
  it('reports DO_NOT_TRACK as the actual forcing variable per consent key', () => {
    for (const key of ['telemetryUsage', 'telemetryCrash'] as const) {
      expect(resolveSetting(key, {}, { DO_NOT_TRACK: '1' }, { [key]: 'on' })).toEqual({
        value: 'off',
        source: 'env',
        env: 'DO_NOT_TRACK',
      })
    }
  })
})
