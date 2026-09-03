export interface StatePush {
  receiveMonoMs: number
  receiveWallMs: number
  state: Record<string, unknown>
  phase: string
  since?: string
  stateObservedAt?: string
}

export interface PushAssessment {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED'
  timing: 'PASS' | 'FAIL' | 'PARTIAL'
  firstWorkingReceiveMs: number | null
  sourceDeltaMs: number | null
  flickers: StatePush[]
  finalIdle: boolean
  assistantNonceAtMonoMs: number | null
  reason: string
}

const timestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function scoreA2aPushes(
  pushes: StatePush[],
  acceptedMonoMs: number,
  acceptedWallMs: number,
  assistantNonceAtMonoMs: number | null,
): PushAssessment {
  const firstWorkingIndex = pushes.findIndex((push) => push.phase === 'working')
  const lastWorkingIndex = pushes.map((push) => push.phase).lastIndexOf('working')
  const firstWorking = firstWorkingIndex >= 0 ? pushes[firstWorkingIndex] : undefined
  const receiveDelta = firstWorking ? firstWorking.receiveMonoMs - acceptedMonoMs : null
  const sourceMs = firstWorking
    ? timestamp(firstWorking.stateObservedAt) ?? timestamp(firstWorking.since)
    : null
  const sourceDelta = sourceMs === null ? null : sourceMs - acceptedWallMs
  const timing: PushAssessment['timing'] =
    receiveDelta !== null && receiveDelta <= 2_000
      ? 'PASS'
      : receiveDelta !== null && receiveDelta > 2_000 && sourceDelta !== null && sourceDelta > 2_000
        ? 'FAIL'
        : 'PARTIAL'
  const flickers = pushes.filter(
    (push, index) =>
      index > firstWorkingIndex &&
      index < lastWorkingIndex &&
      (push.phase === 'idle' || push.phase === '(blank)'),
  )
  const finalIdle =
    assistantNonceAtMonoMs !== null &&
    pushes.some(
      (push, index) =>
        index > lastWorkingIndex &&
        push.phase === 'idle' &&
        push.receiveMonoMs >= assistantNonceAtMonoMs,
    )
  const control = assistantNonceAtMonoMs !== null && firstWorking !== undefined
  const verdict: PushAssessment['verdict'] =
    !control ? 'BLOCKED' : flickers.length > 0 || !finalIdle || timing === 'FAIL' ? 'FAIL' : timing
  const reason = !control
    ? 'assistant nonce or working push missing'
    : flickers.length > 0
      ? 'idle/blank flicker occurred strictly between working pushes'
      : !finalIdle
        ? 'no pushed final idle arrived after the assistant nonce'
        : timing === 'FAIL'
          ? 'authoritative working timestamp and receive were both later than 2s'
          : timing === 'PARTIAL'
            ? 'late delivery lacked an authoritative timestamp proving which side of 2s'
            : 'working push arrived within 2s, with no flicker and pushed final idle'
  return {
    verdict,
    timing,
    firstWorkingReceiveMs: receiveDelta,
    sourceDeltaMs: sourceDelta,
    flickers,
    finalIdle,
    assistantNonceAtMonoMs,
    reason,
  }
}

export class A2aPushObserver {
  private ws?: WebSocket
  private acceptedMonoMs = 0
  private acceptedWallMs = 0
  private nonceMonoMs: number | null = null
  readonly pushes: StatePush[] = []

  constructor(
    private readonly base: string,
    private readonly password: string,
    private readonly sessionId: string,
    private readonly nonce: string,
  ) {}

  async open(): Promise<void> {
    const response = await fetch(this.base + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
    })
    if (!response.ok) throw new Error('A2a observer login failed: ' + response.status)
    const cookie = (response.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
    const ws = new WebSocket(this.base.replace('http', 'ws') + '/client', { headers: { cookie } } as never)
    this.ws = ws
    ws.onmessage = (event) => this.onMessage(String(event.data))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('A2a observer websocket open failed'))
    })
    ws.send(JSON.stringify({ type: 'attach', sessionId: this.sessionId }))
    ws.send(JSON.stringify({ type: 'transcriptSubscribe', sessionId: this.sessionId }))
  }

  markAccepted(): void {
    this.acceptedMonoMs = performance.now()
    this.acceptedWallMs = Date.now()
  }

  private onMessage(raw: string): void {
    const receiveMonoMs = performance.now()
    const receiveWallMs = Date.now()
    let frame: Record<string, unknown>
    try { frame = JSON.parse(raw) as Record<string, unknown> } catch { return }
    if (frame.sessionId !== this.sessionId) return
    if (frame.type === 'sessionAgentStateChanged') {
      const state = (frame.state ?? {}) as Record<string, unknown>
      this.pushes.push({
        receiveMonoMs,
        receiveWallMs,
        state,
        phase: typeof state.phase === 'string' ? state.phase : '(blank)',
        since: typeof state.since === 'string' ? state.since : undefined,
        stateObservedAt: typeof state.stateObservedAt === 'string' ? state.stateObservedAt : undefined,
      })
    }
    if (frame.type === 'transcriptDelta') {
      const items = Array.isArray(frame.items) ? frame.items as Record<string, unknown>[] : []
      if (items.some((item) => item.role === 'assistant' && String(item.text ?? '').includes(this.nonce))) {
        this.nonceMonoMs ??= receiveMonoMs
      }
    }
  }

  async waitForSettled(timeoutMs: number): Promise<PushAssessment> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const assessment = this.assess()
      if (assessment.assistantNonceAtMonoMs !== null && assessment.finalIdle) return assessment
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return this.assess()
  }

  assess(): PushAssessment {
    return scoreA2aPushes(this.pushes, this.acceptedMonoMs, this.acceptedWallMs, this.nonceMonoMs)
  }

  close(): void { this.ws?.close() }
}
