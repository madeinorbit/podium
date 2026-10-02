/** Synthetic words only; used by focused parity checks and browser evidence. */
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import type { SessionView } from '@podium/client-core/session-values'
import { asMutationId, asSessionId, type MessageRecordWire } from '@podium/model/browser'
import type { PendingInteractionWire } from '@podium/protocol'

export function noticeFixture(sessionId = 'synthetic-session-0') {
  const sessions = [
    { sessionId: asSessionId(sessionId), name: '  Named agent  ', title: 'Title', cwd: '/synthetic/project', agentKind: 'codex' },
    { sessionId: asSessionId('cold-notice-session'), title: 'Saved agent', cwd: '/synthetic/saved', agentKind: 'codex',
      stoppedAt: '2020-01-01T00:00:00Z', lastActiveAt: '2020-01-01T00:00:00Z', agentState: { phase: 'ended' } },
  ] as SessionView[]
  const messages: MessageRecordWire[] = (['failed', 'expired', 'unknown', 'typed', 'confirmed'] as const).map((status, i) => ({
    id: `notice-message-${i}`, sessionId: asSessionId(i === 1 ? 'cold-notice-session' : i === 2 ? 'missing-session' : sessionId),
    senderUserId: 'synthetic-user', body: i === 0 ? `  ${'careful '.repeat(15)}\nsecond line` : `Synthetic ${status} words`,
    status, reason: status === 'failed' ? 'delivery-failed' : undefined, createdAt: `2026-10-01T12:00:0${i}Z`,
  }))
  const base = { sessionId, status: 'asked', askedAt: '2026-10-01T12:00:00Z', fingerprint: 'synthetic',
    source: 'protocol', answerable: 'structured' }
  const interactions = [
    { kind: 'permission', payload: { v: 1, toolName: 'Read', inputSummary: 'Synthetic file', canAlwaysAllow: true } },
    { kind: 'permission', answerable: 'keystroke-emulated', payload: { v: 1, toolName: 'Read' } },
    { kind: 'question', payload: { v: 1, questions: [{ question: 'Synthetic choice?', options: [{ label: 'One' }, { label: 'Two' }] }] } },
    { kind: 'question', source: 'screen', payload: { v: 1, questions: [{ question: 'Synthetic screen choice?', options: [{ label: 'One' }] }] } },
    { kind: 'question', payload: { v: 1, questions: [] } },
    { kind: 'question', payload: { v: 1, questions: [{ question: 'Preview?', previewLayout: true, options: [{ label: 'One' }] }] } },
    { kind: 'question', payload: { v: 1, questions: [{ question: 'Several?', multiSelect: true, options: [{ label: 'One' }] }] } },
    { kind: 'plan-approval', payload: { v: 1, plan: ' Synthetic plan ' } },
    { kind: 'login', payload: { v: 1, provider: 'Synthetic provider', reason: 're-auth', url: 'https://example.invalid' } },
    { kind: 'recovery', payload: { v: 1, reason: 'context-overflow', prompt: 'Synthetic recovery', offered: ['full-resume', 'summary-resume', 'abandon', 'fresh-session'] } },
    { kind: 'recovery', answerable: 'keystroke-emulated', payload: { v: 1, reason: 'cache-miss', prompt: '', offered: ['full-resume'] } },
    { kind: 'elicitation', payload: { v: 1, serverName: 'Synthetic MCP', message: 'Synthetic form' } },
  ].map((row, i) => ({ ...base, ...row, id: `notice-ask-${i}`, askedAt: `2026-10-01T12:00:${String(20 - i).padStart(2, '0')}Z` })) as PendingInteractionWire[]
  const deadLetters: OutboxDeadLetterEntry[] = (['invalid', 'unauthorized', 'conflict', 'confirmation-required', 'max-age'] as const).map((code, i) => ({
    entry: { mutationId: asMutationId(`notice-mutation-${i}`), kind: 'issueUpdate', input: { id: 'invisible-target', patch: { title: `Synthetic authored ${i}` } }, queuedAt: i },
    reason: { code }, parkedFrom: code === 'max-age' ? 'expired' : 'rejected', deadLetteredAt: i + 1, attempts: 1,
  }))
  return { sessions, messages, interactions, deadLetters }
}
