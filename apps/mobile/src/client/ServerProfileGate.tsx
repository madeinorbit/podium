import { parseServerOrigin, type ServerConfig } from '@podium/client-core/transport'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { PairingScanner } from '../components/PairingScanner'
import { KeyboardAvoidingRoot } from '../components/KeyboardAvoidingRoot'
import { PressableScale } from '../components/PressableScale'
import { color, font, radius, sans, space } from '../theme/theme'
import { logout } from './auth'
import { LaunchReadyView } from './launch-ready'
import {
  configureNativeWebSocketCredential,
  installNativeWebSocketAuthentication,
} from './native-websocket'
import { clearLocalCredentialSurfaces, preflightNativeOverride } from './override-lifecycle'
import {
  claimMobilePairing,
  type MobilePairingEnvelope,
  normalizeManualServer,
  type PairingClaim,
  parsePairingLink,
  pollMobilePairing,
  preflightServer,
  type ServerPreflight,
} from './pairing'
import {
  deleteProfileCredential,
  getProfileCredential,
  purgeOrphanedProfileCredentials,
  setProfileCredential,
} from './profile-credentials'
import { ServerProfileContext, type ServerProfileContextValue } from './server-profile-context'
import {
  canOpenProfileOffline,
  classifyServerTransport,
  createProfileId,
  defaultProfileName,
  enqueuePendingProfileCleanup,
  loadServerProfiles,
  reusableProfileAtOrigin,
  type ServerProfile,
  type ServerProfileState,
  saveServerProfiles,
} from './server-profiles'
import { envServer, setActiveServerRuntime } from './trpc'
import {
  CredentialWriteQueue,
  StaleCredentialOwnerError,
  replaceCredentialForOwner,
} from './credential-ownership'

// The context and its two hooks live in `./server-profile-context`, which does
// NOT import expo-router, expo-camera or expo-crypto — see the note there.
// Re-exported so existing importers of `./ServerProfileGate` are unaffected.
export { useOptionalServerProfile, useServerProfile } from './server-profile-context'

function configFor(origin: string, override: boolean): ServerConfig {
  const parsed = parseServerOrigin(origin)
  if (!parsed) throw new Error('invalid server profile origin')
  return { ...parsed, override }
}

function webProfile(): { profile: ServerProfile; config: ServerConfig } {
  // A served web app belongs to its page origin because its HttpOnly session
  // cookie belongs there. Only an explicit ?server development override may
  // redirect it; native build-time injection must never win on web.
  const explicitOverride = overrideFromUrl(window.location.href)
  const origin = explicitOverride ?? window.location.origin
  const config = configFor(origin, explicitOverride !== null)
  const now = new Date().toISOString()
  return {
    config,
    profile: {
      id: `web:${config.httpOrigin}`,
      name: defaultProfileName(config.httpOrigin),
      httpOrigin: config.httpOrigin,
      mode: 'protected',
      transport: config.httpOrigin.startsWith('https:') ? 'trusted-https' : 'insecure-lan',
      createdAt: now,
      updatedAt: now,
    },
  }
}

function consumeWebPairingLink(): string | null {
  if (
    Platform.OS !== 'web' ||
    typeof window === 'undefined' ||
    !window.location.hash.includes('pair=')
  ) {
    return null
  }
  const raw = window.location.href
  // The fragment is a bearer secret. Remove it before a child, logger, redirect,
  // or browser-history entry can observe it.
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return raw
}

// Module evaluation precedes the root logger and every provider. A secret in a
// fragment therefore gets one synchronous history replacement before any app
// component, redirect, or navigation observer exists.
let initialWebPairing = (() => {
  const raw = consumeWebPairingLink()
  if (!raw) return { present: false, envelope: null, error: null }
  try {
    return { present: true, envelope: parsePairingLink(raw).envelope, error: null }
  } catch (error) {
    return {
      present: true,
      envelope: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})()

/** Native cold-start pairing link, consumed once per process — see the boot effect. */
let initialNativePairingConsumed = false

function overrideFromUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const value = new URL(raw).searchParams.get('server')
    return value ? normalizeManualServer(value) : null
  } catch {
    return null
  }
}

interface ActivationFailure {
  title: string
  detail: string
}

function profileReplacementFailure(profile: ServerProfile): ActivationFailure {
  return {
    title: 'This server was replaced',
    detail: `${profile.name} now reports a different Podium instance. Its saved session was not sent. Remove this profile or verify and pair with the replacement as a new server.`,
  }
}

export function ServerProfileGate({ children }: { children: ReactNode }) {
  // Deliberately the static `router`, not `useRouter()`: that hook returns a
  // NEW object every render, and it sat in the boot effect's dependency chain
  // (via handleLink). Every state change re-ran the boot, whose own setStates
  // re-rendered, whose new router re-ran the boot — a livelock that killed each
  // run's `alive` before setReady(true) landed, leaving the launch splash up
  // forever on any cold start that raced a render (found 2026-08-27).
  const credentialWrites = useMemo(() => new CredentialWriteQueue(), [])
  const consumedInitialPairing = initialWebPairing
  const initialWeb = Platform.OS === 'web' ? webProfile() : null
  const [profileState, setProfileState] = useState<ServerProfileState>(() =>
    initialWeb
      ? { activeProfileId: initialWeb.profile.id, profiles: [initialWeb.profile] }
      : { activeProfileId: null, profiles: [] },
  )
  const [ready, setReady] = useState(Platform.OS === 'web')
  const [bearer, setBearer] = useState<string | null>(null)
  const [credentialReleased, setCredentialReleased] = useState(Platform.OS === 'web')
  const [activation, setActivation] = useState<'verified' | 'offline-cache'>('verified')
  const [ephemeralConfig, setEphemeralConfig] = useState<ServerConfig | null>(
    initialWeb?.config ?? null,
  )
  const [revision, setRevision] = useState(0)
  const [setupOpen, setSetupOpen] = useState(consumedInitialPairing.present)
  const [incoming, setIncoming] = useState<MobilePairingEnvelope | null>(
    consumedInitialPairing.envelope,
  )
  const [linkError, setLinkError] = useState<string | null>(consumedInitialPairing.error)
  const [activationFailure, setActivationFailure] = useState<ActivationFailure | null>(null)
  const [activationRetry, setActivationRetry] = useState(0)
  const switchOperation = useRef(0)
  const switchInFlight = useRef(false)
  const revalidationInFlight = useRef(false)
  const activeProfileIdRef = useRef(profileState.activeProfileId)
  const bearerRef = useRef<string | null>(null)
  const nativeOverrideActiveRef = useRef(false)
  activeProfileIdRef.current = profileState.activeProfileId

  useEffect(() => {
    bearerRef.current = bearer
  }, [bearer])

  useEffect(() => {
    initialWebPairing = { present: false, envelope: null, error: null }
  }, [])

  const clearUntrustedNativeCredentials = useCallback(() => {
    clearLocalCredentialSurfaces({
      clearHttpRuntime: () => setActiveServerRuntime(undefined, null),
      clearWebSocket: () => configureNativeWebSocketCredential(null, null),
      clearBearer: () => {
        bearerRef.current = null
        setBearer(null)
      },
      markCredentialUnreleased: () => setCredentialReleased(false),
    })
  }, [])

  useEffect(
    () => () => {
      if (!nativeOverrideActiveRef.current) return
      // Component teardown has no trusted server identity. Clear process-wide
      // clients and the synchronous token ref; never attempt remote logout.
      setActiveServerRuntime(undefined, null)
      configureNativeWebSocketCredential(null, null)
      bearerRef.current = null
    },
    [],
  )

  const handleLink = useCallback((raw: string) => {
    // Native app links can contain the one-time secret in router state. Drop
    // that route before parsing, rendering, logging, or awaiting network I/O.
    // Best-effort: on a cold launch the router may not be mounted yet, and a
    // throw here silently swallowed the whole pairing link (found 2026-08-27).
    // The app/pair route also redirects itself, so a failed replace is safe.
    if (Platform.OS !== 'web') {
      try {
        router.replace('/')
      } catch {
        // not mounted yet — the pair route's own <Redirect> covers it
      }
    }
    try {
      const parsed = parsePairingLink(raw)
      setIncoming(parsed.envelope)
      setSetupOpen(true)
      setLinkError(null)
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error))
      setSetupOpen(true)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: activationRetry is a deliberate retrigger counter — bumping it re-runs activation from the retry buttons
  useEffect(() => {
    installNativeWebSocketAuthentication()
    if (Platform.OS === 'web') {
      const onHashChange = () => {
        const raw = consumeWebPairingLink()
        if (raw) handleLink(raw)
      }
      window.addEventListener('hashchange', onHashChange)
      return () => window.removeEventListener('hashchange', onHashChange)
    }
    let alive = true
    void (async () => {
      const initialUrl = await Linking.getInitialURL()
      const isPairingLink = Boolean(
        initialUrl && (initialUrl.startsWith('podium:') || initialUrl.includes('#pair=')),
      )
      if (isPairingLink) {
        try {
          router.replace('/')
        } catch {
          // router not mounted yet — the pair route's own <Redirect> covers it
        }
      }
      const buildOverride =
        (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ ?? envServer()
      const override =
        overrideFromUrl(initialUrl) ?? (buildOverride ? normalizeManualServer(buildOverride) : null)
      if (override) {
        nativeOverrideActiveRef.current = true
        const result = await preflightNativeOverride({
          clearLocalCredentials: clearUntrustedNativeCredentials,
          preflight: () => preflightServer(override),
        })
        const now = new Date().toISOString()
        const profile: ServerProfile = {
          id: createProfileId(),
          name: 'Server override',
          httpOrigin: result.ok ? result.httpOrigin : override,
          ...(result.ok ? { instanceId: result.instanceId } : {}),
          mode: result.ok ? result.mode : 'protected',
          transport: result.transport,
          createdAt: now,
          updatedAt: now,
        }
        if (alive) {
          setProfileState({ activeProfileId: profile.id, profiles: [profile] })
          setEphemeralConfig(configFor(override, true))
          setCredentialReleased(result.ok)
          setActivationFailure(result.ok ? null : { title: result.title, detail: result.detail })
          setReady(true)
        }
      } else {
        nativeOverrideActiveRef.current = false
        const stored = await loadServerProfiles()
        await purgeOrphanedProfileCredentials(stored.profiles.map((row) => row.id))
        const active = stored.profiles.find((profile) => profile.id === stored.activeProfileId)
        if (!active) {
          if (alive) {
            setProfileState(stored)
            setCredentialReleased(false)
            setReady(true)
          }
        } else {
          // Preflight is credential-free. A positive answer must revalidate
          // identity, wire support, and transport policy before SecureStore is
          // opened. The narrow unreachable arm below may instead reuse the
          // trust boundary from a previously verified profile.
          const result = await preflightServer(active.httpOrigin)
          if (!alive) return
          setProfileState(stored)
          if (!result.ok) {
            if (canOpenProfileOffline(active, result.kind)) {
              // Absence of a network answer does not invalidate the immutable
              // local profile boundary established by the last verified boot.
              // Let only the profileId + userId SQLite namespace paint. Do not
              // release the saved bearer yet. A later network return
              // must prove the same instance still answers at this origin
              // before transport or the outbox can use it.
              setBearer(null)
              setActivation('offline-cache')
              setActivationFailure(null)
              setCredentialReleased(true)
              setReady(true)
            } else {
              setActivationFailure({ title: result.title, detail: result.detail })
              setCredentialReleased(false)
              setReady(true)
            }
          } else if (active.instanceId && active.instanceId !== result.instanceId) {
            setActivationFailure(profileReplacementFailure(active))
            setCredentialReleased(false)
            setReady(true)
          } else {
            const validated: ServerProfile = {
              ...active,
              httpOrigin: result.httpOrigin,
              instanceId: result.instanceId,
              mode: result.mode,
              transport: result.transport,
              updatedAt: new Date().toISOString(),
            }
            const next = {
              ...stored,
              profiles: stored.profiles.map((row) => (row.id === active.id ? validated : row)),
            }
            await saveServerProfiles(next)
            const credential = await getProfileCredential(active.id)
            if (!alive) return
            setProfileState(next)
            setBearer(credential)
            setActivation('verified')
            setCredentialReleased(true)
            setReady(true)
          }
        }
      }
      // ONCE PER PROCESS, module-level like web's `initialWebPairing`:
      // `getInitialURL()` answers the same pairing URL for the app's whole
      // lifetime, and `handleLink`'s router.replace('/') mid-init remounts the
      // root layout — which remounts this gate, wiping any per-mount guard and
      // re-handling the same URL in a remount storm that kept the launch splash
      // up forever (~75 remounts/s, found 2026-08-27 chasing pairing links).
      if (isPairingLink && initialUrl && !initialNativePairingConsumed) {
        initialNativePairingConsumed = true
        handleLink(initialUrl)
      }
    })().catch((error) => {
      if (alive) {
        setActivationFailure({
          title: 'Could not open this server',
          detail: error instanceof Error ? error.message : String(error),
        })
        setCredentialReleased(false)
        setReady(true)
      }
    })
    const subscription = Linking.addEventListener('url', ({ url }) => handleLink(url))
    return () => {
      alive = false
      subscription.remove()
    }
  }, [activationRetry, clearUntrustedNativeCredentials, handleLink])

  const profile =
    profileState.profiles.find((row) => row.id === profileState.activeProfileId) ?? null
  const profileOrigin = profile?.httpOrigin
  const config = useMemo(
    () => ephemeralConfig ?? (profileOrigin ? configFor(profileOrigin, false) : null),
    [ephemeralConfig, profileOrigin],
  )
  const runtimeConfig = Platform.OS === 'web' || credentialReleased ? config : null
  setActiveServerRuntime(runtimeConfig ?? undefined, credentialReleased ? bearer : null)
  configureNativeWebSocketCredential(
    runtimeConfig?.httpOrigin ?? null,
    credentialReleased ? bearer : null,
  )

  const persistState = useCallback(async (next: ServerProfileState) => {
    await saveServerProfiles(next)
    setProfileState(next)
  }, [])

  const finishSetup = useCallback(
    async (
      result: Extract<ServerPreflight, { ok: true }>,
      token: string | null,
      userId?: string,
    ) => {
      // Invalidate an offline identity probe before any pairing write can race
      // it into restoring the previous profile or credential.
      switchOperation.current += 1
      if (Platform.OS === 'web') {
        setIncoming(null)
        setSetupOpen(false)
        setRevision((value) => value + 1)
        return
      }
      const now = new Date().toISOString()
      // Never reuse a profile/replica/credential boundary because a new origin
      // reports the same public instanceId. Address migration needs a separate,
      // authenticated rekey flow; ordinary setup creates a fresh profile.
      const existing = reusableProfileAtOrigin(profileState.profiles, result.httpOrigin, userId)
      const nextProfile: ServerProfile = existing
        ? {
            ...existing,
            httpOrigin: result.httpOrigin,
            instanceId: result.instanceId,
            mode: result.mode,
            transport: result.transport,
            ...(userId ? { userId } : {}),
            updatedAt: now,
          }
        : {
            id: createProfileId(),
            name: defaultProfileName(result.httpOrigin),
            httpOrigin: result.httpOrigin,
            instanceId: result.instanceId,
            mode: result.mode,
            transport: result.transport,
            ...(userId ? { userId } : {}),
            createdAt: now,
            updatedAt: now,
          }
      const next: ServerProfileState = {
        activeProfileId: nextProfile.id,
        profiles: existing
          ? profileState.profiles.map((row) => (row.id === existing.id ? nextProfile : row))
          : [...profileState.profiles, nextProfile],
      }
      const priorCredential = existing
        ? await credentialWrites.run(() => getProfileCredential(existing.id))
        : null
      try {
        // Metadata first, then the secure value. If either store refuses the
        // issuance, restore the prior state and revoke the just-minted session.
        await saveServerProfiles(next)
        if (token) {
          await credentialWrites.run(() => setProfileCredential(nextProfile.id, token))
        }
      } catch (cause) {
        await saveServerProfiles(profileState).catch(() => {})
        if (token) {
          if (priorCredential && existing) {
            await credentialWrites
              .run(() => setProfileCredential(existing.id, priorCredential))
              .catch(() => {})
          } else {
            await credentialWrites
              .run(() => deleteProfileCredential(nextProfile.id))
              .catch(() => {})
          }
          const revoked = await logout(result.httpOrigin, token)
            .then(() => true)
            .catch(() => false)
          const detail = cause instanceof Error ? cause.message : String(cause)
          throw new Error(
            revoked
              ? `Could not save this phone session: ${detail}`
              : `Could not save this phone session, and remote revocation failed. Revoke it from Settings → Connected devices: ${detail}`,
          )
        }
        throw cause
      }
      // Cross-server switches clear the transport credential first. Even if a
      // renderer exposes intermediate state, a bearer is never sent to the old
      // or new wrong origin.
      setActiveServerRuntime(undefined, null)
      configureNativeWebSocketCredential(null, null)
      setBearer(null)
      setProfileState(next)
      setBearer(token)
      setActivation('verified')
      setCredentialReleased(true)
      setEphemeralConfig(null)
      setIncoming(null)
      setSetupOpen(false)
      setActivationFailure(null)
      setRevision((value) => value + 1)
    },
    [credentialWrites, profileState],
  )

  const saveOfflineProfile = useCallback(
    async (httpOrigin: string) => {
      switchOperation.current += 1
      if (Platform.OS === 'web') return
      const now = new Date().toISOString()
      const existing = profileState.profiles.find((row) => row.httpOrigin === httpOrigin)
      const nextProfile: ServerProfile = existing
        ? {
            ...existing,
            httpOrigin,
            transport: classifyServerTransport(httpOrigin),
            updatedAt: now,
          }
        : {
            id: createProfileId(),
            name: defaultProfileName(httpOrigin),
            httpOrigin,
            mode: 'protected',
            transport: classifyServerTransport(httpOrigin),
            createdAt: now,
            updatedAt: now,
          }
      const next: ServerProfileState = {
        activeProfileId: nextProfile.id,
        profiles: existing
          ? profileState.profiles.map((row) => (row.id === existing.id ? nextProfile : row))
          : [...profileState.profiles, nextProfile],
      }
      await saveServerProfiles(next)
      setBearer(null)
      setProfileState(next)
      setSetupOpen(false)
      setCredentialReleased(false)
      setActivationFailure({
        title: 'Server saved for later',
        detail:
          'No credential was stored or sent. Retry when this phone can reach the secure server.',
      })
    },
    [profileState],
  )

  const context = useMemo<ServerProfileContextValue | null>(() => {
    if (!profile || !config) return null
    const credentialOwnerOperation = switchOperation.current
    return {
      profile,
      profiles: profileState.profiles,
      config,
      bearer,
      activation,
      runtimeKey: `${profile.id}:${revision}`,
      isEphemeralOverride: config.override,
      beginAddServer: () => {
        setIncoming(null)
        setLinkError(null)
        setSetupOpen(true)
      },
      switchProfile: async (profileId) => {
        if (config.override || profileId === profile.id || switchInFlight.current) return
        const selected = profileState.profiles.find((row) => row.id === profileId)
        if (!selected) return
        switchInFlight.current = true
        const operation = ++switchOperation.current
        const priorBearer = bearer
        setActiveServerRuntime(undefined, null)
        configureNativeWebSocketCredential(null, null)
        setBearer(null)
        setCredentialReleased(false)
        try {
          const result = await preflightServer(selected.httpOrigin)
          if (operation !== switchOperation.current) return
          if (!result.ok) {
            if (!canOpenProfileOffline(selected, result.kind)) {
              throw new Error(`${result.title}: ${result.detail}`)
            }
            const next = { activeProfileId: selected.id, profiles: profileState.profiles }
            await saveServerProfiles(next)
            if (operation !== switchOperation.current) return
            setProfileState(next)
            setBearer(null)
            setActivation('offline-cache')
            setCredentialReleased(true)
            setRevision((value) => value + 1)
            return
          }
          if (selected.instanceId && selected.instanceId !== result.instanceId) {
            const failure = profileReplacementFailure(selected)
            throw new Error(`${failure.title}: ${failure.detail}`)
          }
          const credential = await credentialWrites.run(() => getProfileCredential(selected.id))
          if (operation !== switchOperation.current) return
          const validated: ServerProfile = {
            ...selected,
            httpOrigin: result.httpOrigin,
            instanceId: result.instanceId,
            mode: result.mode,
            transport: result.transport,
            updatedAt: new Date().toISOString(),
          }
          const next = {
            activeProfileId: selected.id,
            profiles: profileState.profiles.map((row) =>
              row.id === selected.id ? validated : row,
            ),
          }
          await saveServerProfiles(next)
          if (operation !== switchOperation.current) return
          setProfileState(next)
          setBearer(credential)
          setActivation('verified')
          setCredentialReleased(true)
          setRevision((value) => value + 1)
        } catch (cause) {
          if (operation === switchOperation.current) {
            setBearer(priorBearer)
            setCredentialReleased(true)
          }
          throw cause
        } finally {
          switchInFlight.current = false
        }
      },
      renameProfile: async (profileId, name) => {
        const clean = name.trim().slice(0, 120)
        if (!clean || config.override) return
        const now = new Date().toISOString()
        await persistState({
          ...profileState,
          profiles: profileState.profiles.map((row) =>
            row.id === profileId ? { ...row, name: clean, updatedAt: now } : row,
          ),
        })
      },
      removeProfile: async (profileId) => {
        if (config.override) return
        switchOperation.current += 1
        await credentialWrites.run(() => deleteProfileCredential(profileId))
        const profiles = profileState.profiles.filter((row) => row.id !== profileId)
        const nextId =
          profileState.activeProfileId === profileId
            ? (profiles[0]?.id ?? null)
            : profileState.activeProfileId
        let next: ServerProfileState = { profiles, activeProfileId: nextId }
        if (profileState.activeProfileId !== profileId) {
          await saveServerProfiles(next)
          setProfileState(next)
          return
        }
        setActiveServerRuntime(undefined, null)
        configureNativeWebSocketCredential(null, null)
        setBearer(null)
        setCredentialReleased(false)
        const selected = profiles.find((row) => row.id === nextId)
        let nextCredential: string | null = null
        if (selected) {
          const result = await preflightServer(selected.httpOrigin)
          if (!result.ok) {
            if (canOpenProfileOffline(selected, result.kind)) {
              await saveServerProfiles(next)
              setProfileState(next)
              setBearer(null)
              setActivation('offline-cache')
              setCredentialReleased(true)
              setRevision((value) => value + 1)
              return
            }
            await saveServerProfiles(next)
            setProfileState(next)
            setActivationFailure({ title: result.title, detail: result.detail })
            return
          }
          if (selected.instanceId && selected.instanceId !== result.instanceId) {
            await saveServerProfiles(next)
            setProfileState(next)
            setActivationFailure(profileReplacementFailure(selected))
            return
          }
          nextCredential = await credentialWrites.run(() => getProfileCredential(selected.id))
          const validated: ServerProfile = {
            ...selected,
            httpOrigin: result.httpOrigin,
            instanceId: result.instanceId,
            mode: result.mode,
            transport: result.transport,
            updatedAt: new Date().toISOString(),
          }
          next = {
            activeProfileId: validated.id,
            profiles: profiles.map((row) => (row.id === validated.id ? validated : row)),
          }
          await saveServerProfiles(next)
        } else {
          await saveServerProfiles(next)
        }
        setProfileState(next)
        setBearer(nextCredential)
        setActivation('verified')
        setCredentialReleased(next.activeProfileId !== null)
        setRevision((value) => value + 1)
      },
      updateCredential: async (token) => {
        if (
          switchOperation.current !== credentialOwnerOperation ||
          activeProfileIdRef.current !== profile.id
        ) {
          throw new StaleCredentialOwnerError()
        }
        const operation = ++switchOperation.current
        if (Platform.OS !== 'web' && !config.override) {
          await credentialWrites.run(() =>
            replaceCredentialForOwner({
              token,
              isCurrent: () =>
                switchOperation.current === operation && activeProfileIdRef.current === profile.id,
              read: () => getProfileCredential(profile.id),
              write: (next) => setProfileCredential(profile.id, next),
              remove: () => deleteProfileCredential(profile.id),
            }),
          )
        }
        if (switchOperation.current !== operation || activeProfileIdRef.current !== profile.id) {
          throw new StaleCredentialOwnerError()
        }
        setBearer(token)
        setActivation('verified')
        setCredentialReleased(true)
        setRevision((value) => value + 1)
      },
      recordUser: async (userId) => {
        if (Platform.OS === 'web' || profile.userId === userId || config.override) return
        await persistState({
          ...profileState,
          profiles: profileState.profiles.map((row) =>
            row.id === profile.id ? { ...row, userId, updatedAt: new Date().toISOString() } : row,
          ),
        })
      },
      revalidateOfflineProfile: async () => {
        if (activation !== 'offline-cache' || revalidationInFlight.current) return
        const operation = switchOperation.current
        revalidationInFlight.current = true
        try {
          const result = await preflightServer(profile.httpOrigin)
          if (operation !== switchOperation.current) return
          if (!result.ok) {
            if (result.kind !== 'unreachable') {
              setCredentialReleased(false)
              setActivationFailure({ title: result.title, detail: result.detail })
            }
            return
          }
          if (profile.instanceId && profile.instanceId !== result.instanceId) {
            setCredentialReleased(false)
            setActivationFailure(profileReplacementFailure(profile))
            return
          }
          const validated: ServerProfile = {
            ...profile,
            httpOrigin: result.httpOrigin,
            instanceId: result.instanceId,
            mode: result.mode,
            transport: result.transport,
            updatedAt: new Date().toISOString(),
          }
          const credential = await credentialWrites.run(() => getProfileCredential(profile.id))
          if (operation !== switchOperation.current) return
          setProfileState((current) => ({
            ...current,
            profiles: current.profiles.map((row) => (row.id === profile.id ? validated : row)),
          }))
          setBearer(credential)
          setActivation('verified')
          setCredentialReleased(true)
          setRevision((value) => value + 1)
        } finally {
          revalidationInFlight.current = false
        }
      },
    }
  }, [activation, bearer, config, credentialWrites, persistState, profile, profileState, revision])

  if (!ready) return null
  if (activationFailure && !setupOpen) {
    return (
      <LaunchReadyView>
        <ActivationFailureView
          failure={activationFailure}
          onRetry={() => {
            setActivationFailure(null)
            setReady(false)
            setActivationRetry((value) => value + 1)
          }}
          onPairAnother={() => {
            setIncoming(null)
            setSetupOpen(true)
          }}
          onForget={async () => {
            if (!profile) return
            switchOperation.current += 1
            const profiles = config?.override
              ? []
              : profileState.profiles.filter((row) => row.id !== profile.id)
            const next: ServerProfileState = {
              profiles,
              activeProfileId: profiles[0]?.id ?? null,
            }
            if (!config?.override) {
              if (!profile.userId) {
                throw new Error(
                  "Podium cannot identify this profile's local account data. Retry the connection instead of deleting it incompletely.",
                )
              }
              // Commit the exact local-erasure intent before making either the
              // profile or its credential unreachable. A failure leaves the
              // saved profile intact and the tombstone retryable.
              await enqueuePendingProfileCleanup(profile.id, profile.userId)
              await saveServerProfiles(next)
            }
            // This recovery path deliberately does not call logout: identity
            // preflight failed, so the saved bearer must never reach whatever
            // now answers at the old origin.
            setActiveServerRuntime(undefined, null)
            configureNativeWebSocketCredential(null, null)
            setBearer(null)
            setCredentialReleased(false)
            if (!config?.override) {
              // Metadata is already durable. If SecureStore refuses here,
              // startup's orphan purge retries without making the bearer live.
              await credentialWrites.run(() => deleteProfileCredential(profile.id)).catch(() => {})
            }
            if (next.activeProfileId) {
              setReady(false)
            }
            setEphemeralConfig(null)
            setProfileState(next)
            setActivationFailure(null)
            if (next.activeProfileId) {
              setActivationRetry((value) => value + 1)
            }
          }}
        />
      </LaunchReadyView>
    )
  }
  if (!profile || !config || setupOpen) {
    return (
      <LaunchReadyView>
        <PairingSetup
          incoming={incoming}
          initialError={linkError}
          canCancel={profile !== null}
          onCancel={() => {
            setIncoming(null)
            setSetupOpen(false)
            setLinkError(null)
          }}
          onComplete={finishSetup}
          onSaveOffline={saveOfflineProfile}
        />
      </LaunchReadyView>
    )
  }
  return (
    <ServerProfileContext.Provider value={context}>
      <View style={styles.fill} key={context?.runtimeKey}>
        {config.override ? (
          <View style={styles.overrideBanner}>
            <Text style={styles.overrideText}>SERVER OVERRIDE · NOT SAVED</Text>
          </View>
        ) : null}
        {children}
      </View>
    </ServerProfileContext.Provider>
  )
}

function ActivationFailureView({
  failure,
  onRetry,
  onPairAnother,
  onForget,
}: {
  failure: ActivationFailure
  onRetry(): void
  onPairAnother(): void
  onForget(): Promise<void>
}) {
  const [confirmForget, setConfirmForget] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [forgetError, setForgetError] = useState<string | null>(null)

  const forgetLocally = async () => {
    if (forgetting) return
    setForgetting(true)
    setForgetError(null)
    try {
      await onForget()
    } catch (error) {
      setForgetError(error instanceof Error ? error.message : String(error))
      setForgetting(false)
    }
  }

  return (
    <View style={styles.recovery} accessibilityLiveRegion="polite">
      <Text style={styles.eyebrow}>SERVER CONNECTION PAUSED</Text>
      <Text style={styles.setupTitle}>{failure.title}</Text>
      <Text style={styles.setupBody}>{failure.detail}</Text>
      {confirmForget ? (
        <View style={styles.serverCard} accessibilityLiveRegion="polite">
          <Text style={styles.serverName}>Forget locally only?</Text>
          <Text style={styles.setupBody}>
            Podium cannot safely contact or trust this server, so its remote mobile session may
            remain active. The saved bearer will not be sent. Revoke the session later from Settings
            → Connected devices on another signed-in client.
          </Text>
          <PrimaryButton
            label={forgetting ? 'Forgetting…' : 'Forget locally'}
            onPress={() => void forgetLocally()}
            disabled={forgetting}
          />
          <SecondaryButton
            label="Keep server"
            onPress={() => {
              setConfirmForget(false)
              setForgetError(null)
            }}
            disabled={forgetting}
          />
          {forgetError ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {forgetError}
            </Text>
          ) : null}
        </View>
      ) : (
        <>
          <PrimaryButton label="Retry safely" onPress={onRetry} />
          <SecondaryButton label="Pair another server" onPress={onPairAnother} />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Forget this saved server"
            style={styles.forgetButton}
            onPress={() => setConfirmForget(true)}
          >
            <Text style={styles.linkText}>Forget this server</Text>
          </PressableScale>
        </>
      )}
    </View>
  )
}

type SetupStep = 'welcome' | 'scan' | 'manual' | 'checking' | 'confirm' | 'claiming' | 'waiting'

function PairingSetup({
  incoming,
  initialError,
  canCancel,
  onCancel,
  onComplete,
  onSaveOffline,
}: {
  incoming: MobilePairingEnvelope | null
  initialError: string | null
  canCancel: boolean
  onCancel(): void
  onComplete(
    result: Extract<ServerPreflight, { ok: true }>,
    bearer: string | null,
    userId?: string,
  ): Promise<void>
  onSaveOffline(httpOrigin: string): Promise<void>
}) {
  const [step, setStep] = useState<SetupStep>(incoming ? 'checking' : 'welcome')
  const [manual, setManual] = useState('')
  const [deviceName, setDeviceName] = useState(
    Platform.OS === 'ios'
      ? 'My iPhone'
      : Platform.OS === 'android'
        ? 'My Android phone'
        : 'My phone',
  )
  const [deviceId] = useState(() => createProfileId())
  const [envelope, setEnvelope] = useState(incoming)
  const [preflight, setPreflight] = useState<Extract<ServerPreflight, { ok: true }> | null>(null)
  const [claim, setClaim] = useState<PairingClaim | null>(null)
  const [error, setError] = useState<string | null>(initialError)
  const [offlineCandidate, setOfflineCandidate] = useState<string | null>(null)
  const connectInFlight = useRef(false)

  const check = useCallback(async (origin: string, nextEnvelope: MobilePairingEnvelope | null) => {
    setStep('checking')
    setError(null)
    setOfflineCandidate(null)
    try {
      const result = await preflightServer(origin)
      if (!result.ok) {
        setError(`${result.title}\n${result.detail}`)
        if (
          !nextEnvelope &&
          result.kind === 'unreachable' &&
          (result.transport === 'trusted-https' || result.transport === 'tailscale-serve')
        ) {
          setOfflineCandidate(normalizeManualServer(origin))
        }
        setStep(nextEnvelope ? 'welcome' : 'manual')
        return
      }
      if (nextEnvelope?.instanceId && nextEnvelope.instanceId !== result.instanceId) {
        setError(
          'This code belongs to a different server instance at the same address. Create a new code.',
        )
        setStep('welcome')
        return
      }
      if (nextEnvelope?.mode === 'pair' && result.mode !== 'protected') {
        setError(
          'This protected pairing code no longer matches the server mode. Create a new code.',
        )
        setStep('welcome')
        return
      }
      setEnvelope(nextEnvelope)
      setPreflight(result)
      setStep('confirm')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStep(nextEnvelope ? 'welcome' : 'manual')
    }
  }, [])

  useEffect(() => {
    if (incoming) void check(incoming.serverUrl, incoming)
  }, [check, incoming])

  useEffect(() => {
    if (initialError) setError(initialError)
  }, [initialError])

  useEffect(() => {
    if (step !== 'waiting' || !claim || !preflight) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await pollMobilePairing(
          preflight.httpOrigin,
          claim,
          Platform.OS === 'web' ? 'web' : 'native',
        )
        if (!alive) return
        if (result.status === 'pending') {
          timer = setTimeout(() => void poll(), 1_500)
        } else if (result.status === 'denied') {
          setError(result.reason)
          setStep('confirm')
        } else {
          await onComplete(preflight, result.bearer, result.userId)
        }
      } catch (cause) {
        if (alive) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setStep('confirm')
        }
      }
    }
    void poll()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [claim, onComplete, preflight, step])

  const scan = (raw: string) => {
    try {
      const parsed = parsePairingLink(raw)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      void check(parsed.envelope.serverUrl, parsed.envelope)
    } catch (cause) {
      // Open mode's QR is intentionally URL-only: no secret, claim, approval,
      // or envelope is meaningful when network reachability already grants the
      // open principal. It still passes the same preflight and warning policy.
      try {
        const url = new URL(raw)
        if (
          (url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.username ||
          url.password ||
          url.pathname !== '/mobile' ||
          url.search ||
          url.hash
        ) {
          throw cause
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
        void check(url.origin, null)
      } catch {
        setError(cause instanceof Error ? cause.message : String(cause))
        setStep('welcome')
      }
    }
  }

  if (step === 'scan')
    return <PairingScanner onScanned={scan} onCancel={() => setStep('welcome')} />

  const connect = async () => {
    if (!preflight || connectInFlight.current) return
    connectInFlight.current = true
    try {
      if (!envelope || envelope.mode === 'open') {
        await onComplete(preflight, null)
        return
      }
      setStep('claiming')
      setError(null)
      const nextClaim = await claimMobilePairing(
        envelope,
        deviceId,
        deviceName.trim().slice(0, 120) || 'My phone',
        Platform.OS,
      )
      setClaim(nextClaim)
      setStep('waiting')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStep('confirm')
    } finally {
      connectInFlight.current = false
    }
  }

  return (
    <KeyboardAvoidingRoot
      style={styles.setup}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      automaticOffset
    >
      <ScrollView contentContainerStyle={styles.setupContent} keyboardShouldPersistTaps="handled">
        {canCancel ? (
          <PressableScale
            style={styles.cancelSetup}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel server setup"
          >
            <Text style={styles.linkText}>Cancel</Text>
          </PressableScale>
        ) : null}
        <Text style={styles.eyebrow}>PODIUM MOBILE</Text>
        <Text style={styles.setupTitle}>
          {step === 'waiting' ? 'Confirm on your computer' : 'Connect to your Podium'}
        </Text>
        {step === 'welcome' ? (
          <>
            <Text style={styles.setupBody}>Scan the code shown in Podium on your computer.</Text>
            {Platform.OS !== 'web' ? (
              <PrimaryButton label="Scan QR code" onPress={() => setStep('scan')} />
            ) : null}
            <SecondaryButton label="Enter server address" onPress={() => setStep('manual')} />
            <Text style={styles.help}>
              On your computer, open Settings → Connected devices → Pair a phone.
            </Text>
          </>
        ) : null}
        {step === 'manual' ? (
          <>
            <Text style={styles.setupBody}>Enter the address your phone can reach.</Text>
            <TextInput
              style={styles.urlInput}
              value={manual}
              onChangeText={setManual}
              placeholder="https://podium.example"
              placeholderTextColor={color.textMicro}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <PrimaryButton
              label="Check server"
              onPress={() => {
                try {
                  void check(normalizeManualServer(manual), null)
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause))
                }
              }}
            />
            <SecondaryButton label="Back" onPress={() => setStep('welcome')} />
          </>
        ) : null}
        {step === 'checking' || step === 'claiming' ? (
          <View style={styles.busy}>
            <ActivityIndicator color={color.workingText} />
            <Text style={styles.setupBody}>
              {step === 'checking'
                ? 'Checking server and transport…'
                : 'Claiming this one-time code…'}
            </Text>
          </View>
        ) : null}
        {step === 'confirm' && preflight ? (
          <>
            <View style={styles.serverCard}>
              <Text style={styles.serverName}>{defaultProfileName(preflight.httpOrigin)}</Text>
              <Text style={styles.serverOrigin}>{preflight.httpOrigin}</Text>
              <Text
                style={[styles.grade, preflight.transport === 'insecure-lan' && styles.warning]}
              >
                {preflight.transport === 'tailscale-serve'
                  ? 'PRIVATE · TAILSCALE HTTPS'
                  : preflight.transport === 'trusted-https'
                    ? 'TRUSTED HTTPS'
                    : 'INSECURE LAN · OPEN MODE ONLY'}
              </Text>
            </View>
            {envelope?.mode === 'pair' ? (
              <TextInput
                style={styles.urlInput}
                value={deviceName}
                onChangeText={setDeviceName}
                accessibilityLabel="Device name"
              />
            ) : null}
            {preflight.transport === 'insecure-lan' ? (
              <Text style={styles.warningText}>
                Anyone on this network may read Podium traffic. No password or pairing credential
                will be sent.
              </Text>
            ) : null}
            <PrimaryButton
              label={
                preflight.transport === 'insecure-lan'
                  ? 'Connect insecurely'
                  : envelope?.mode === 'pair'
                    ? 'Request approval'
                    : 'Connect'
              }
              onPress={() => void connect()}
            />
            <SecondaryButton label="Back" onPress={() => setStep('welcome')} />
          </>
        ) : null}
        {step === 'waiting' && claim ? (
          <>
            <View
              style={styles.phrase}
              accessible
              accessibilityLabel={`Confirmation words: ${claim.phrase.join(', ')}`}
              accessibilityLiveRegion="polite"
            >
              {claim.phrase.map((word, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the phrase is a fixed, never-reordered word list, and words can repeat
                <Text key={`${index}:${word}`} style={styles.phraseText}>
                  {word}
                </Text>
              ))}
            </View>
            <Text style={styles.setupBody}>
              Confirm these exact words on your computer, then approve this phone.
            </Text>
            <ActivityIndicator color={color.workingText} />
            <SecondaryButton label="Cancel" onPress={() => setStep('welcome')} />
          </>
        ) : null}
        {offlineCandidate ? (
          <SecondaryButton
            label="Save for later"
            onPress={() => void onSaveOffline(offlineCandidate)}
          />
        ) : null}
        {error ? (
          <Text
            style={styles.errorText}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingRoot>
  )
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string
  onPress(): void
  disabled?: boolean
}) {
  return (
    <PressableScale
      style={[styles.primary, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </PressableScale>
  )
}

function SecondaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string
  onPress(): void
  disabled?: boolean
}) {
  return (
    <PressableScale
      style={[styles.secondary, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  overrideBanner: { backgroundColor: color.needsYou, paddingVertical: 4, alignItems: 'center' },
  overrideText: { color: color.onAccent, ...sans(700), fontSize: font.micro, letterSpacing: 1 },
  setup: { flex: 1, backgroundColor: color.bg },
  recovery: {
    flex: 1,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.lg,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  setupContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.lg,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  cancelSetup: {
    position: 'absolute',
    top: 54,
    right: 24,
    zIndex: 2,
    minHeight: 44,
    justifyContent: 'center',
  },
  linkText: { color: color.accentTint, ...sans(600), fontSize: font.body },
  forgetButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: color.accentTint, ...sans(700), fontSize: font.micro, letterSpacing: 1.5 },
  setupTitle: { color: color.text, ...sans(700), fontSize: font.largeTitle },
  setupBody: { color: color.body, fontSize: font.body, lineHeight: 24 },
  help: { color: color.textFaint, fontSize: font.small, lineHeight: 20 },
  primary: {
    minHeight: 50,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  primaryText: { color: color.onAccent, ...sans(700), fontSize: font.body },
  buttonDisabled: { opacity: 0.5 },
  secondary: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: color.text, ...sans(600), fontSize: font.body },
  urlInput: {
    minHeight: 50,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    color: color.text,
    fontSize: font.body,
    paddingHorizontal: space.lg,
  },
  busy: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  serverCard: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    padding: space.lg,
    gap: space.sm,
  },
  serverName: { color: color.text, ...sans(700), fontSize: font.heading },
  serverOrigin: { color: color.textDim, fontSize: font.small },
  grade: { color: color.successText, ...sans(700), fontSize: font.micro, letterSpacing: 1 },
  warning: { color: color.needsYouText },
  warningText: { color: color.needsYouText, fontSize: font.small, lineHeight: 20 },
  phrase: {
    paddingVertical: space.xl,
    paddingHorizontal: space.md,
    backgroundColor: color.accentSoft,
    borderColor: color.accentBorder,
    borderWidth: 1,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  phraseText: { color: color.accentTint, ...sans(700), fontSize: font.heading },
  errorText: { color: color.dangerText, fontSize: font.small, lineHeight: 20 },
})
