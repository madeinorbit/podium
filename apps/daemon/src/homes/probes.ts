/**
 * QUOTA AND MODEL PROBES PER HOME (credential management §10: "each home
 * reports its own login state, identity, quota and model list").
 *
 * The default directory's probes are unchanged; these add one answer per
 * Podium home, each read with the harness's directory variable pointed at
 * that home, so a second subscription's quota and models are its own.
 */

import {
  declaredValue,
  type HarnessAccountScope,
  type HarnessContext,
  type HarnessEnvironment,
  type HarnessHomeSide,
  harnessAccount,
  type ModelChoice,
  manifestFor,
  PROBEABLE_AGENTS,
  type ProbeableAgent,
  probeAgentModels,
  probeClaudeHomeModels,
  probeClaudeModels,
  withHarnessHome,
  withHomeScope,
} from '@podium/harness'
import { makeQuotaFetcher } from '@podium/harness/inventory'
import type { AgentQuotaWire } from '@podium/model'
import type { HarnessHome } from './registry'

type Account = { home: string; env: HarnessEnvironment }
type QuotaFetch = (
  kind: string,
  scope: HarnessAccountScope,
  deps: { now: number },
) => Promise<AgentQuotaWire>

/** The harness's own quota probe over one scope. */
const manifestQuota: QuotaFetch = async (kind, scope, deps) => {
  const manifest = manifestFor(kind)
  const usage = manifest ? declaredValue(manifest.usage) : undefined
  const quota = usage ? declaredValue(usage.quota) : undefined
  if (!quota) throw new Error(`${kind} has no quota to read`)
  return await quota.fetchQuota({ ...deps, account: scope })
}

/**
 * A reader of every home's quota, one cached fetcher per home (the same TTL
 * and stale-while-revalidate rule as the default directory's). Each wire
 * carries its `homeId`; a removed home is forgotten.
 */
export function homeQuotaReader(deps: {
  homes(): readonly HarnessHome[]
  account(): Promise<Account | undefined>
  fetchQuota?: QuotaFetch
}): (refresh: boolean) => Promise<AgentQuotaWire[]> {
  const fetchQuota = deps.fetchQuota ?? manifestQuota
  const fetchers = new Map<string, ReturnType<typeof makeQuotaFetcher>>()
  const fetcherFor = (home: HarnessHome) => {
    let fetcher = fetchers.get(home.homeId)
    if (!fetcher) {
      fetcher = makeQuotaFetcher({
        fetchers: [
          {
            key: home.harness,
            fetch: async ({ now }) => {
              const account = await deps.account()
              if (!account) throw new Error('quota read refused: no account home')
              const scope = withHomeScope(
                home.harness,
                harnessAccount(home.harness, account.home, account.env),
                home.dir,
              )
              return await fetchQuota(home.harness, scope, { now: now ?? Date.now() })
            },
          },
        ],
      })
      fetchers.set(home.homeId, fetcher)
    }
    return fetcher
  }
  return async (refresh) => {
    const homes = deps.homes()
    const present = new Set(homes.map((home) => home.homeId))
    for (const homeId of fetchers.keys()) if (!present.has(homeId)) fetchers.delete(homeId)
    const answers = await Promise.all(
      homes.map(async (home) =>
        (await fetcherFor(home).getAgentQuota(refresh)).map((wire) => ({
          ...wire,
          homeId: home.homeId,
        })),
      ),
    )
    return answers.flat()
  }
}

export interface HomeModelProbeDeps {
  account: Account
  /**
   * The installed harness's context on one side (managed installs §4.2), in
   * the account's own folders, if that side has an install. A home Podium made
   * asks for `podium`: Podium's install when there is one, else the person's.
   */
  context(kind: string, side: HarnessHomeSide): HarnessContext | undefined
  probeClaude?: (account: HarnessAccountScope) => Promise<ModelChoice[]>
  probeAgent?: (kind: ProbeableAgent, context: HarnessContext) => Promise<ModelChoice[]>
}

/**
 * Each home's model list, read in that home: Claude Code's through the
 * home's own login (never the daemon's API key: a home is a subscription),
 * a CLI-probed harness through the home's executable (Podium's install when
 * there is one) run in the home. A home whose harness is not installed, or
 * whose probe fails, reports nothing.
 */
export async function homeModelProbe(
  homes: readonly HarnessHome[],
  deps: HomeModelProbeDeps,
): Promise<Record<string, Record<string, ModelChoice[]>>> {
  const probeClaude = deps.probeClaude ?? ((account) => probeClaudeModels({ account }))
  const probeAgent =
    deps.probeAgent ??
    ((kind, context) => probeAgentModels(kind, { contexts: { [kind]: context } }))
  const byHome: Record<string, Record<string, ModelChoice[]>> = {}
  await Promise.all(
    homes.map(async (home) => {
      let models: ModelChoice[] = []
      try {
        if ((PROBEABLE_AGENTS as readonly string[]).includes(home.harness)) {
          const context = deps.context(home.harness, 'podium')
          if (!context) return
          models = await probeAgent(
            home.harness as ProbeableAgent,
            withHarnessHome(context, { id: home.homeId, dir: home.dir }),
          )
        } else {
          models = await probeClaudeHomeModels(
            home.harness,
            withHomeScope(
              home.harness,
              harnessAccount(home.harness, deps.account.home, deps.account.env),
              home.dir,
            ),
            probeClaude,
          )
        }
      } catch {
        return
      }
      if (models.length > 0) byHome[home.homeId] = { [home.harness]: models }
    }),
  )
  return byHome
}
