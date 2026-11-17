// The machines' own (native) harness logins, as the Accounts hub lists them
// (SP-6454, stream B2). Login facts come from the authenticated machine
// inventory catalog. The server never reads a host-local HOME here: every
// machine contributes through its replicated, non-secret inventory record.
// The stored keys this hub once listed beside them are credentials (plan Task 21).

import { providerOf, resolveDescriptors } from '@podium/harness/browser'
import { harnessDetectLogin } from '@podium/harness/metadata'
import type { AccountView, HarnessAgent } from '@podium/model'
import { type HarnessDescriptorWire, isBuiltinHarnessKind } from '@podium/protocol'
import { buildLoginCatalog, catalogEntriesForHarness, type LoginCatalog } from '../../login-catalog'
import type { MachineRecord } from '../../store/types'

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

/**
 * The native logins for the hub, one row per harness (or per identity when a
 * harness has several), from the machines given (the caller's own, online).
 *
 * The first argument accepts an explicit HOME only for legacy unit tests. The
 * production query passes machine records and therefore has no homedir fallback.
 */
export function nativeAccountViews(
  machinesOrHome: readonly MachineRecord[] | string = [],
  /** Served descriptors across the fleet (one `machines.descriptors` report
   *  per machine); resolved over the bundled fallback, so an older daemon or
   *  a test that passes none still renders every harness this build knows. */
  servedDescriptors: readonly HarnessDescriptorWire[] = [],
): AccountView[] {
  const pairs = nativePairs(servedDescriptors)
  return typeof machinesOrHome === 'string'
    ? pairs.map(({ kind, provider }) => detectNative(machinesOrHome, kind, provider))
    : nativeFromCatalog(buildLoginCatalog(machinesOrHome), machinesOrHome, pairs)
}
