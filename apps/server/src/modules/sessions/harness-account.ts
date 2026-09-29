/**
 * ONE harness-login rule (POD-4827 review 2).
 *
 * A role default names the CLI whose login it represents. Since the coding
 * default is shared across agent kinds, an omitted account must not carry a
 * different CLI's identity into per-session driver resolution: a native id
 * for ANOTHER harness falls back to this harness's bare native id (never
 * spend another CLI's login silently). An EXPLICIT account is user intent
 * and never reaches this function — the caller passes it through
 * byte-for-byte for the existing downstream compatibility/refusal behavior.
 * The bare id resolves to the machine's fingerprint downstream, in
 * `nativeAccountIdForMachine`.
 *
 * PURE by construction: the caller resolves the role preference (the headed
 * spawn passes the coding role's account; the superagent passes its
 * superagent-or-coding preference) and the machine fingerprint, and passes
 * them in. One function, two callers — `SessionStart.spawn` and
 * `SuperagentService.ensureHeadlessSession` — so the composer path and the
 * superagent path resolve the same account for the same settings.
 */

import type { AccountId, HarnessAgent } from '@podium/model'
import { nativeAccountId } from '@podium/runtime'

export function selectHarnessAccountId(
  agent: HarnessAgent,
  roleAccount: AccountId | undefined,
): AccountId {
  const prefix = `native:${agent}`
  const matches = roleAccount === prefix || roleAccount?.startsWith(`${prefix}:`) === true
  if (roleAccount?.startsWith('native:') && !matches) return nativeAccountId(agent)
  return roleAccount || nativeAccountId(agent)
}
