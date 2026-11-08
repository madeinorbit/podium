/**
 * THE PHONE RECEIVES APPROVAL RECORDS (POD-6674).
 *
 * An agent's approval request is an `approval` effect record on the feed. The
 * phone has no approval screen yet (a separate product decision); what this
 * pins is that its replica and production pool hold the records like every
 * other device's, with the viewer's undecided requests listed and a decided
 * one dropped, so a phone surface needs only to read them.
 */

import { pendingApprovals } from '@podium/client-graph/approval-effects'
import { here } from '@podium/client-graph/lookup'
import type { EffectModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, expect, it } from 'vitest'
import { useMobilePool } from './mobile-pool'
import { createMobileTestReplica } from './test-replica'
import { renderWithMobileStore } from './test-support'

afterEach(() => cleanup())

const approval = (
  id: string,
  options: { createdAt?: string; createdBy?: string; decision?: 'approve' | null } = {},
) => ({
  id,
  kind: 'approval',
  target: { kind: 'session', id: 'sess-asks' },
  input: {
    op: { kind: 'update' },
    machineId: 'm-host',
    sessionId: 'sess-asks',
    issueId: null,
  },
  cancelRequested: false,
  decision: options.decision === undefined ? null : options.decision,
  effect: { status: 'pending', attempts: 0, stage: 'awaiting-approval' },
  createdBy: options.createdBy ?? 'user:test',
  createdAt: options.createdAt ?? '2026-11-08T10:00:00.000Z',
  updatedAt: options.createdAt ?? '2026-11-08T10:00:00.000Z',
  revision: 1,
})

const Probe = observer(function Probe() {
  const pool = useMobilePool()
  if (!pool) return <Text testID="approvals">loading</Text>
  const record = here(pool.model('effect', 'apr_first')) as EffectModel | undefined
  return (
    <>
      <Text testID="approvals">
        {pendingApprovals(pool)
          .map((model) => model.id)
          .join(',')}
      </Text>
      <Text testID="first-op">{JSON.stringify(record?.approvalRequest?.op ?? null)}</Text>
    </>
  )
})

it("the phone's pool holds the approval records and lists the viewer's undecided ones", async () => {
  const replica = createMobileTestReplica()
  replica.applySnapshot('effects', [
    approval('apr_later', { createdAt: '2026-11-08T10:05:00.000Z' }),
    approval('apr_first'),
    // Another person's request: received as a reader of its target, not listed.
    approval('apr_theirs', { createdBy: 'user:someone-else' }),
  ] as never)
  replica.finishBootstrap()
  await renderWithMobileStore(<Probe />, { replica })

  await waitFor(() =>
    expect(screen.getByTestId('approvals').textContent).toBe('apr_first,apr_later'),
  )
  expect(screen.getByTestId('first-op').textContent).toBe('{"kind":"update"}')

  // Decided on another device: the record moves on the feed, and drops out.
  act(() => {
    replica.applySnapshot('effects', [
      approval('apr_later', { createdAt: '2026-11-08T10:05:00.000Z' }),
      approval('apr_first', { decision: 'approve' }),
      approval('apr_theirs', { createdBy: 'user:someone-else' }),
    ] as never)
  })
  await waitFor(() => expect(screen.getByTestId('approvals').textContent).toBe('apr_later'))
})
