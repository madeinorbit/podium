import { describe, expect, it } from 'vitest'
import { FIRST_ADMIN_USER_ID } from './identity/user'
import { asIssueId, asRepoId, asShipOrderId } from './ids'
import {
  descendantTipsMatch,
  integrationReceiptMatchesOrder,
  RootIntegrationReceipt,
  ShipOrder,
  type DescendantTip,
  type RootIntegrationReceipt as RootIntegrationReceiptValue,
} from './shipping'

const childA: DescendantTip = { issueId: asIssueId('iss_child_a'), approvedHeadSha: 'sha-a' }
const childB: DescendantTip = { issueId: asIssueId('iss_child_b'), approvedHeadSha: 'sha-b' }

const receipt = (
  over: Partial<RootIntegrationReceiptValue> = {},
): RootIntegrationReceiptValue => ({
  rootIssueId: asIssueId('iss_1'),
  approvedHeadSha: 'approved-head',
  descendants: [childA, childB],
  ...over,
})

const orderInput = (over: Record<string, unknown> = {}) => ({
  id: asShipOrderId('order-1'),
  issueId: asIssueId('iss_1'),
  descendantManifest: [childA, childB],
  repoId: asRepoId('repo-1'),
  targetBranch: 'main',
  destination: 'origin/main',
  approvedBaseSha: 'approved-base',
  approvedHeadSha: 'approved-head',
  deliveryDependsOn: [],
  currentIntegrationReceipt: receipt(),
  requestedBy: {
    actor: { kind: 'user' as const, id: FIRST_ADMIN_USER_ID },
    onBehalfOf: FIRST_ADMIN_USER_ID,
  },
  requestedAt: '2026-08-13T00:00:00.000Z',
  policyId: 'default',
  closeMode: 'after-destination' as const,
  state: 'queued' as const,
  stateChangedAt: '2026-08-13T00:00:00.000Z',
  ...over,
})

describe('descendantTipsMatch', () => {
  it('treats the same pairs as equal regardless of order', () => {
    expect(descendantTipsMatch([childA, childB], [childB, childA])).toBe(true)
  })

  it('rejects extra, missing, or drifted SHAs', () => {
    expect(descendantTipsMatch([childA, childB], [childA])).toBe(false)
    expect(descendantTipsMatch([childA], [childA, childB])).toBe(false)
    expect(
      descendantTipsMatch([childA], [{ ...childA, approvedHeadSha: 'sha-other' }]),
    ).toBe(false)
  })
})

describe('integrationReceiptMatchesOrder', () => {
  it('binds the approved root head to the exact descendant tips', () => {
    expect(
      integrationReceiptMatchesOrder(receipt(), {
        issueId: asIssueId('iss_1'),
        approvedHeadSha: 'approved-head',
        descendantManifest: [childB, childA],
      }),
    ).toBe(true)
  })

  it('rejects a wrong root, drifted head, extra descendant, or missing descendant', () => {
    const input = {
      issueId: asIssueId('iss_1'),
      approvedHeadSha: 'approved-head',
      descendantManifest: [childA, childB],
    }
    expect(
      integrationReceiptMatchesOrder(receipt({ rootIssueId: asIssueId('iss_other') }), input),
    ).toBe(false)
    expect(integrationReceiptMatchesOrder(receipt({ approvedHeadSha: 'other-head' }), input)).toBe(
      false,
    )
    expect(
      integrationReceiptMatchesOrder(
        receipt({
          descendants: [...input.descendantManifest, { issueId: asIssueId('iss_x'), approvedHeadSha: 'sha-x' }],
        }),
        input,
      ),
    ).toBe(false)
    expect(integrationReceiptMatchesOrder(receipt({ descendants: [childA] }), input)).toBe(false)
  })
})

describe('ShipOrder evidence', () => {
  it('accepts an optional evidenceManifestRef and a matching receipt', () => {
    const parsed = ShipOrder.parse(orderInput({ evidenceManifestRef: 'evidence://manifest/1' }))
    expect(parsed.evidenceManifestRef).toBe('evidence://manifest/1')
    expect(parsed.currentIntegrationReceipt).toEqual(receipt())
  })

  it('accepts a leaf root with no receipt', () => {
    expect(
      ShipOrder.parse(orderInput({ descendantManifest: [], currentIntegrationReceipt: undefined })),
    ).toMatchObject({ descendantManifest: [] })
  })

  it('requires a current receipt when the descendant manifest is non-empty', () => {
    const result = ShipOrder.safeParse(orderInput({ currentIntegrationReceipt: undefined }))
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => issue.path[0] === 'currentIntegrationReceipt')).toBe(
      true,
    )
  })

  it('rejects a receipt that does not bind the approved head to the manifest', () => {
    const result = ShipOrder.safeParse(
      orderInput({ currentIntegrationReceipt: receipt({ approvedHeadSha: 'stale-head' }) }),
    )
    expect(result.success).toBe(false)
  })

  it('parses RootIntegrationReceipt independently of DeliveryReceipt', () => {
    expect(RootIntegrationReceipt.parse(receipt()).descendants).toEqual([childA, childB])
  })
})
