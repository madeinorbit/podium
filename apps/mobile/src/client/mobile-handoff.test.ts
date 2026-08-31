import { PODIUM_SCHEME, formatPodiumLink } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  captureMobileHandoffUrl,
  consumePendingMobileHandoff,
  decideMobileHandoff,
  mobileHandoffFallbackStatus,
  parseMobileHandoffUrl,
  pendingMobileHandoffSnapshot,
  type MobileHandoffContext,
  type MobileHandoffRequest,
} from './mobile-handoff'
import type { ServerProfile } from './server-profiles'

const ORIGIN = 'https://podium.example'
const INSTANCE_ID = 'instance-one'
const SESSION_ID = 'session-private-id'

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'profile-one',
    name: 'Podium',
    httpOrigin: ORIGIN,
    instanceId: 'instance-one',
    mode: 'protected',
    transport: 'trusted-https',
    userId: 'user-one',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  }
}

function href(origin = ORIGIN, instanceId = INSTANCE_ID, sessionId = SESSION_ID): string {
  return formatPodiumLink(PODIUM_SCHEME, {
    kind: 'session',
    session: sessionId,
    search: `?origin=${encodeURIComponent(origin)}&instance=${encodeURIComponent(instanceId)}`,
  })
}

function request(
  origin = ORIGIN,
  instanceId = INSTANCE_ID,
  sessionId = SESSION_ID,
): MobileHandoffRequest {
  const parsed = parseMobileHandoffUrl(href(origin, instanceId, sessionId))
  if (!parsed) throw new Error('expected a handoff request')
  return parsed
}

function context(overrides: Partial<MobileHandoffContext> = {}): MobileHandoffContext {
  return {
    profiles: [profile()],
    activeProfileId: 'profile-one',
    activation: 'verified',
    authentication: 'authenticated',
    authenticatedUserId: 'user-one',
    replicaReady: true,
    sessions: [{ sessionId: SESSION_ID }],
    ...overrides,
  }
}

beforeEach(() => {
  const snapshot = pendingMobileHandoffSnapshot()
  consumePendingMobileHandoff(snapshot.id)
})

describe('profile-bound mobile handoff decisions', () => {
  it('opens a matching authenticated profile only after its replica proves the session', () => {
    expect(decideMobileHandoff(request(), context())).toEqual({
      kind: 'open',
      target: { kind: 'session', session: SESSION_ID },
    })
  })

  it('holds the destination for a matching unauthenticated profile', () => {
    expect(
      decideMobileHandoff(
        request(),
        context({ authentication: 'unauthenticated', authenticatedUserId: undefined }),
      ),
    ).toEqual({ kind: 'authenticate', profileId: 'profile-one' })
  })

  it('fails closed when the same origin has no verified instance identity', () => {
    expect(
      decideMobileHandoff(request(), context({ profiles: [profile({ instanceId: undefined })] })),
    ).toEqual({ kind: 'fallback', reason: 'profile-unavailable' })
  })

  it('fails an old link closed after the same origin is replaced by a new instance', () => {
    expect(
      decideMobileHandoff(
        request(ORIGIN, 'old-instance'),
        context({ profiles: [profile({ instanceId: 'new-instance' })] }),
      ),
    ).toEqual({ kind: 'fallback', reason: 'profile-unavailable' })
  })

  it('selects the exact saved profile on another paired origin', () => {
    const other = profile({
      id: 'profile-other',
      httpOrigin: 'https://other.example',
      instanceId: 'instance-other',
      userId: 'user-other',
    })
    expect(
      decideMobileHandoff(
        request(other.httpOrigin, 'instance-other'),
        context({ profiles: [profile(), other], activeProfileId: 'profile-one' }),
      ),
    ).toEqual({ kind: 'switch-profile', profileId: 'profile-other' })
  })

  it('falls back when the requested profile is unavailable', () => {
    expect(
      decideMobileHandoff(request('https://missing.example', 'missing-instance'), context()),
    ).toEqual({
      kind: 'fallback',
      reason: 'profile-unavailable',
    })
  })

  it('falls back when the authorized replica does not contain the session', () => {
    expect(decideMobileHandoff(request(), context({ sessions: [] }))).toEqual({
      kind: 'fallback',
      reason: 'session-unavailable',
    })
  })

  it('waits for the authorized replica instead of treating startup as absence', () => {
    expect(decideMobileHandoff(request(), context({ replicaReady: false, sessions: [] }))).toEqual({
      kind: 'wait-replica',
    })
  })

  it('preserves the credential owner fence between profile and authenticated principal', () => {
    expect(decideMobileHandoff(request(), context({ authenticatedUserId: 'user-two' }))).toEqual({
      kind: 'fallback',
      reason: 'profile-unavailable',
    })
  })
})

describe('incoming handoff scope', () => {
  it('fails an unscoped session destination closed to Work', () => {
    const parsed = parseMobileHandoffUrl(
      formatPodiumLink(PODIUM_SCHEME, { kind: 'session', session: SESSION_ID }),
    )
    expect(parsed).toEqual({ kind: 'unscoped' })
    expect(decideMobileHandoff(parsed!, context())).toEqual({
      kind: 'fallback',
      reason: 'unscoped',
    })
  })

  it('rejects noncanonical origins and expanded server scope', () => {
    for (const search of [
      '?origin=HTTPS%3A%2F%2FPODIUM.EXAMPLE&instance=instance-one',
      '?origin=https%3A%2F%2Fpodium.example&instance=instance-one&token=secret',
    ]) {
      expect(
        parseMobileHandoffUrl(
          formatPodiumLink(PODIUM_SCHEME, { kind: 'session', session: SESSION_ID, search }),
        ),
      ).toEqual({ kind: 'unscoped' })
    }
  })

  it('rejects missing, duplicated, or malformed instance scope', () => {
    for (const search of [
      '?origin=https%3A%2F%2Fpodium.example',
      '?origin=https%3A%2F%2Fpodium.example&instance=',
      '?origin=https%3A%2F%2Fpodium.example&instance=instance-one&instance=instance-two',
      `?origin=https%3A%2F%2Fpodium.example&instance=${'x'.repeat(257)}`,
    ]) {
      expect(
        parseMobileHandoffUrl(
          formatPodiumLink(PODIUM_SCHEME, { kind: 'session', session: SESSION_ID, search }),
        ),
      ).toEqual({ kind: 'unscoped' })
    }
  })

  it('leaves pairing links on the pairing parser and stores no raw URL', () => {
    expect(captureMobileHandoffUrl('podium://pair/credential')).toBe(false)
    expect(pendingMobileHandoffSnapshot().request).toBeNull()

    expect(captureMobileHandoffUrl(href())).toBe(true)
    expect(pendingMobileHandoffSnapshot().request).toEqual(request())
    expect(JSON.stringify(pendingMobileHandoffSnapshot())).not.toContain('podium:')
  })

  it('never includes the raw session id in fail-closed status text', () => {
    for (const reason of [
      'identity-unverified',
      'profile-unavailable',
      'session-unavailable',
      'unscoped',
    ] as const) {
      expect(mobileHandoffFallbackStatus(reason)).not.toContain(SESSION_ID)
      expect(mobileHandoffFallbackStatus(reason)).not.toContain(INSTANCE_ID)
      expect(mobileHandoffFallbackStatus(reason)).not.toContain(ORIGIN)
      expect(mobileHandoffFallbackStatus(reason)).toContain('Work')
    }
  })
})
