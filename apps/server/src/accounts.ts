// Account discovery for the Accounts & Keys settings hub (SP-6454, stream B2).
//
// Native login facts come from the authenticated machine inventory catalog. The
// server never reads a host-local HOME here: every machine contributes through
// its replicated, non-secret inventory record. Managed credentials remain in the
// server-only accounts table and only their masked identities are projected.

import { providerOf, resolveDescriptors } from '@podium/harness/browser'
import { harnessDetectLogin } from '@podium/harness/metadata'
import { asAccountId, type HarnessAgent, type MachineId, type UserId } from '@podium/model'
import { isBuiltinHarnessKind, type HarnessDescriptorWire } from '@podium/protocol'
import { buildLoginCatalog, catalogEntriesForHarness, type LoginCatalog } from './login-catalog'
import { type AccountsRepository, type ManagedAccountRow, SHARED_WITH_EVERYONE } from './store/accounts'
import type { MachineRecord } from './store/types'

/** A row in the Accounts hub. Native rows are observed from the machine catalog;
 * managed rows reflect what Podium stores. */
export type { AccountView } from '@podium/model'

import type { AccountView } from '@podium/model'

/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '""""'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/**
 * Compatibility seam for older unit tests that explicitly provide a HOME. Production
 * calls pass machine records, so this path is never reached by the account query.
 */
function detectNative(homeDir: string, kind: HarnessAgent, provider: string): AccountView {
  const login = harnessDetectLogin(kind, homeDir, {})
  if (!login) {
    return {
      id: `native:${kind}`,
      provider,
      source: 'native',
      harness: kind,
      status: 'not-configured',
    }
  }
  return {
    id: `native:${kind}`,
    provider,
    source: 'native',
    harness: kind,
    identity: login.account,
    status: login.state === 'in' ? 'connected' : 'not-configured',
  }
}

/**
 * Native `{kind, provider}` pairs, read off the served descriptors over the
 * bundled fallback (spec §4.4: accounts consume inventoryReport fields and
 * stop naming a harness). Served wins by kind; a report-only kind this build
 * never heard of is skipped — it cannot be typed `HarnessAgent`, and clients
 * render those rows from the descriptor directly.
 */
function nativePairs(
  served: readonly HarnessDescriptorWire[],
): readonly { kind: HarnessAgent; provider: string }[] {
  const pairs: { kind: HarnessAgent; provider: string }[] = []
  for (const descriptor of resolveDescriptors(served)) {
    if (!isBuiltinHarnessKind(descriptor.kind)) continue
    // POD-4542: an older daemon's descriptor carries no provider — the one
    // {@link providerOf} rule falls back to kind, shared with the parsers.
    pairs.push({ kind: descriptor.kind, provider: providerOf(descriptor) })
  }
  return pairs
}

function nativeFromCatalog(
  catalog: LoginCatalog,
  machines: readonly MachineRecord[],
  pairs: readonly { kind: HarnessAgent; provider: string }[],
): AccountView[] {
  return pairs.flatMap(({ kind: harness, provider }): AccountView[] => {
    const entries = catalogEntriesForHarness(catalog, harness)
    if (entries.length === 0) {
      const reports = machines
        .filter((machine) => !machine.revokedAt)
        .flatMap((machine) =>
          (machine.inventory?.agents ?? [])
            .filter((agent) => agent.kind === harness)
            .map((agent) => ({ machine, login: agent.login })),
        )
      const loggedIn = reports.filter(({ login }) => login.state === 'in')
      if (loggedIn.length > 0) {
        const labels = [...new Set(loggedIn.map(({ login }) => login.account).filter(Boolean))]
        return [
          {
            id: `native:${harness}`,
            provider,
            source: 'native' as const,
            harness,
            ...(labels.length === 1 ? { identity: labels[0] } : {}),
            machines: [...new Set(loggedIn.map(({ machine }) => machine.name))],
            status: 'connected' as const,
          },
        ]
      }
      return [
        {
          id: `native:${harness}`,
          provider,
          source: 'native' as const,
          harness,
          // No report is not evidence of a logout. Only an explicit detector
          // result may claim the native login is not configured.
          status:
            reports.length > 0 && reports.every(({ login }) => login.state === 'out')
              ? ('not-configured' as const)
              : ('unknown' as const),
        },
      ]
    }
    return entries.map((entry) => ({
      id: entries.length === 1 ? `native:${harness}` : `native:${harness}:${entry.fingerprint}`,
      provider,
      source: 'native' as const,
      harness,
      identity: entry.email ?? entry.providerAccountId,
      machines: [
        ...new Set(
          entry.machines
            .filter((machine) => machine.harness === harness)
            .map((machine) => machine.machineName),
        ),
      ],
      identityFingerprint: entry.fingerprint,
      status: 'connected' as const,
    }))
  })
}

const MANAGED_KEY_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const

/**
 * All accounts for the hub, as ONE VIEWER sees them: the catalog of native CLI
 * logins plus the managed credentials Podium holds. Managed rows are read from
 * the accounts table, never from the settings blob, so credential bytes cannot
 * reach a client.
 *
 * Managed keys are per user (POD-6360). For each managed account id the viewer
 * sees their OWN key (`stored`, with who they share it with); else a key another
 * user explicitly shares with them (`shared`, with its owner, never with its
 * sharing list); else the legacy settings key; else not configured. Another
 * user's unshared key is never shown.
 *
 * The fourth argument accepts an explicit HOME only for legacy unit tests. The
 * production query passes machine records and therefore has no homedir fallback.
 */
export async function accountViews(
  legacyApiKey: (provider: string) => string | undefined | Promise<string | undefined>,
  accounts: AccountsRepository,
  viewer: UserId,
  machinesOrHome: readonly MachineRecord[] | string = [],
  /** Served descriptors across the fleet (one `machines.descriptors` report
   *  per machine); resolved over the bundled fallback, so an older daemon or
   *  a test that passes none still renders every harness this build knows. */
  servedDescriptors: readonly HarnessDescriptorWire[] = [],
): Promise<AccountView[]> {
  const pairs = nativePairs(servedDescriptors)
  const native =
    typeof machinesOrHome === 'string'
      ? pairs.map(({ kind, provider }) => detectNative(machinesOrHome, kind, provider))
      : nativeFromCatalog(buildLoginCatalog(machinesOrHome), machinesOrHome, pairs)

  const own = new Map((await accounts.ownedBy(viewer)).map((a) => [a.accountKey, a]))
  const shared = new Map<string, ManagedAccountRow>()
  // Oldest first: the same key the spawn picks (`managedKeyFor`).
  for (const row of await accounts.sharedWithUser(viewer)) {
    if (!shared.has(row.accountKey)) shared.set(row.accountKey, row)
  }
  const managed: AccountView[] = await Promise.all(MANAGED_KEY_PROVIDERS.map(async (provider) => {
    const id = `managed:${provider}`
    const base = { id, provider, source: 'managed' as const, kind: 'api-key' as const }
    const row = own.get(asAccountId(id))
    if (row) return { ...base, ...storedView(row) }
    const sharedRow = shared.get(asAccountId(id))
    if (sharedRow) return { ...base, ...sharedView(sharedRow) }
    const legacyKey = (await legacyApiKey(provider)) ?? ''
    if (legacyKey) {
      return {
        ...base,
        identity: maskCredential(legacyKey),
        status: 'connected' as const,
        credentialSource: 'legacy' as const,
      }
    }
    return { ...base, status: 'not-configured' as const }
  }))

  const oauthId = asAccountId('managed:claude-oauth')
  const oauthOwn = own.get(oauthId)
  const oauthShared = shared.get(oauthId)
  const claudeOauth: AccountView = {
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    source: 'managed',
    kind: 'oauth',
    ...(oauthOwn
      ? storedView(oauthOwn)
      : oauthShared
        ? sharedView(oauthShared)
        : { status: 'not-configured' as const }),
  }

  return [...native, ...managed, claudeOauth]
}

/** The viewer's own key: connected, masked, and who they share it with. */
function storedView(row: ManagedAccountRow) {
  return {
    ...(row.identity ? { identity: row.identity } : {}),
    status: 'connected' as const,
    credentialSource: 'stored' as const,
    sharing: {
      everyone: row.sharedWith.includes(SHARED_WITH_EVERYONE),
      users: row.sharedWith.filter((grantee) => grantee !== SHARED_WITH_EVERYONE),
    },
  }
}

/** Another user's key shared with the viewer: masked, with its owner only. */
function sharedView(row: ManagedAccountRow) {
  return {
    ...(row.identity ? { identity: row.identity } : {}),
    status: 'connected' as const,
    credentialSource: 'shared' as const,
    sharedBy: row.ownerUserId,
  }
}
