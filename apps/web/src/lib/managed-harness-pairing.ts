import { providerOf } from '@podium/harness/browser'
import type { AccountId } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { HarnessAgent } from '@podium/runtime'
import { issueAgentDescriptors } from './issue-agents'

/**
 * Managed credential → harness pairing, read off descriptors (POD-4541).
 *
 * A coding session always runs a harness; a managed account only supplies the
 * credential it authenticates WITH. The pairing is account topology derived
 * from `descriptor.provider` — `managed:anthropic` pairs with every resolved
 * descriptor whose provider is `anthropic`, etc. — never a hand-written
 * harness list. Order follows the registry (the resolved descriptor order).
 *
 * The ONE provider fallback rule lives in `providerOf`
 * (`@podium/harness/browser`, POD-4542): a frame predating `provider`
 * resolves to `kind`. This file states no second `?? kind`.
 */

/** Provider namespace a managed account id draws its credential from. */
export function managedProviderForAccount(accountId: AccountId): string | undefined {
  const prefix = 'managed:'
  if (!accountId.startsWith(prefix)) return undefined
  const raw = accountId.slice(prefix.length)
  // The Claude subscription setup-token is an anthropic credential whose id
  // is not a provider name (see decodeAccount in @podium/runtime settings).
  if (raw === 'claude-oauth') return 'anthropic'
  return raw
}

/** Every harness a provider credential can authenticate, in registry order. */
export function harnessesForProvider(
  descriptors: readonly HarnessDescriptorWire[],
  provider: string,
): HarnessAgent[] {
  return descriptors
    .filter((d) => d.kind !== 'shell' && providerOf(d) === provider)
    .map((d) => d.kind as HarnessAgent)
}

/**
 * The harnesses a managed account can drive for the coding role; [] when it
 * can drive none (so it is never offered). Pass the resolved descriptors when
 * held; otherwise the bundled fallback applies (no machine connected).
 */
export function managedCodingHarnesses(
  accountId: AccountId,
  descriptors?: readonly HarnessDescriptorWire[],
): HarnessAgent[] {
  const provider = managedProviderForAccount(accountId)
  if (!provider) return []
  return harnessesForProvider(issueAgentDescriptors(descriptors), provider)
}
