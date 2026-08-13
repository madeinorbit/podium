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
  resolve(issue: IssueWire): ResolvedShippingPolicy
}

/** First-slice policy: only the guarded local ff-only compatibility executor.
 * Provider queues and outward publication are intentionally not inferred. */
export class CompatibilityShippingPolicyResolver implements ShippingPolicyResolver {
  constructor(private readonly defaultTargetBranch: () => string) {}

  resolve(issue: IssueWire): ResolvedShippingPolicy {
    const targetBranch = issue.parentBranch.trim() || this.defaultTargetBranch().trim() || 'main'
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
