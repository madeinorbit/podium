import { asSessionId } from '@podium/model/browser'
import type { SessionView } from '@podium/client-core/session-values'

export const SESSION_PANE_NOW = Date.parse('2026-10-02T00:00:00Z')
/** Covers process, urgency, queue, capabilities, recovery and model provenance. */
export function sessionPaneFixture(): SessionView[] {
  const variants = [
    {},
    { agentState: { phase: 'working' }, resumable: true },
    { agentState: { phase: 'compacting' }, resumable: true },
    { agentState: { phase: 'needs_user', since: '2026-10-01T23:30:00Z' }, offer: { message: 'Review ready', actions: [{ label: 'Continue', prompt: 'continue' }], createdAt: '2026-10-01T23:40:00Z' } },
    { agentState: { phase: 'errored', error: 'synthetic failure' } },
    { status: 'hibernated', resumable: true },
    { status: 'hibernated', agentState: { phase: 'idle', queuedCount: 2 }, resumable: true },
    { status: 'exited', exitCode: 2, resumable: true },
    { status: 'exited', agentKind: 'shell', exitCode: 0 },
    { status: 'exited', neverBound: true, spawnFailure: 'synthetic spawn refusal' },
    { status: 'exited', resumable: false },
    { status: 'starting' },
    { status: 'reconnecting' },
    { condition: 'logged-out', machineName: 'Offline host' },
    { driverFamily: 'server', headless: true, configureFields: ['permissionMode'] },
    { requestedModel: 'gpt-6', requestedEffort: 'high', configureFields: ['model', 'effort'] },
    { observedModel: 'claude-opus-4-8', observedEffort: 'medium', requestedModel: 'gpt-6' },
    { snoozedUntil: '2026-10-03T00:00:00Z' },
    { handoffTarget: 'Another host', machineName: 'Host' },
    { agentKind: 'shell', status: 'hibernated' },
    { archived: true, status: 'exited', lastActiveAt: '2020-01-01T00:00:00Z' },
  ]
  return variants.map((patch, i) => ({ sessionId: asSessionId(`pane-${i}`), agentKind: 'claude-code',
    title: `Synthetic pane ${i}`, name: i % 2 ? `Named pane ${i}` : undefined, cwd: `/synthetic/w${i}`, status: 'live',
    machineId: 'machine-a', machineName: 'Host', displayRef: `POD-${i}.a`, controllerId: 'controller',
    geometry: { cols: 80, rows: 24 }, epoch: 0, clientCount: 1, createdAt: '2026-10-01T00:00:00Z',
    lastActiveAt: '2026-10-01T23:50:00Z', origin: { kind: 'spawn' }, archived: false, readAt: null, unread: true,
    agentState: { phase: 'idle' }, model: 'auto', effort: 'auto', ...patch } as SessionView))
}
