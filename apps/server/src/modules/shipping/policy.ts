import type { IssueWire, ProviderPullRequestRef, ShipOrderId } from '@podium/model'
import type { ShippingValidationProfile } from '@podium/protocol/daemon'

export interface ResolvedShippingPolicy {
  id: string
  targetBranch: string
  destination: string
  validationProfileId: string
  validationProfile: ShippingValidationProfile
  closeMode: 'after-destination' | 'leave-open'
  evidenceOptional: boolean
  deliveryDependsOn: ShipOrderId[]
  providerRef?: ProviderPullRequestRef
}

export interface ShippingPolicyResolver {
  /** WIDENED, never a union (rule 52b). As `T | Promise<T>` every consumer
   *  typechecked whether or not it awaited, and a test resolver that spread the
   *  result got the promise's own (empty) properties instead of the policy —
   *  a policy with no `validationProfile` at all (POD-3499). */
  resolve(issue: IssueWire): Promise<ResolvedShippingPolicy>
}

/** First-slice policy: only the guarded local ff-only compatibility executor.
 * Provider queues and outward publication are intentionally not inferred. */
export class CompatibilityShippingPolicyResolver implements ShippingPolicyResolver {
  constructor(private readonly defaultTargetBranch: () => string | Promise<string>) {}

  async resolve(issue: IssueWire): Promise<ResolvedShippingPolicy> {
    const targetBranch =
      issue.parentBranch.trim() || (await this.defaultTargetBranch()).trim() || 'main'
    return {
      id: `compatibility-local:${targetBranch}`,
      targetBranch,
      destination: `local:${targetBranch}`,
      validationProfileId: 'podium-agent',
      validationProfile: {
        id: 'podium-agent',
        argv: ['bun', 'run', 'test'],
        cwd: 'integration-root',
        timeoutMs: 10 * 60 * 1000,
        resourceLocks: ['validation:agent'],
      },
      closeMode: 'after-destination',
      evidenceOptional: true,
      deliveryDependsOn: [],
    }
  }
}
