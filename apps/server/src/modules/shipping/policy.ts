import type { IssueWire, ProviderPullRequestRef, ShipOrderId } from '@podium/model'

export interface ResolvedShippingPolicy {
  id: string
  targetBranch: string
  destination: string
  validationProfileId: string
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
      validationProfileId: 'compatibility-proof',
      closeMode: 'after-destination',
      evidenceOptional: true,
      deliveryDependsOn: [],
    }
  }
}
