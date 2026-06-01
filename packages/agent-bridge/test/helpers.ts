import type { AgentSession } from '../src/index'

export interface Collector {
  readonly text: string
  readonly seqs: number[]
  maxPaint(): number
}

export function collect(session: AgentSession): Collector {
  let buffer = ''
  const seqs: number[] = []
  session.onFrame((f) => {
    buffer += Buffer.from(f.data, 'base64').toString('utf8')
    seqs.push(f.seq)
  })
  return {
    get text() {
      return buffer
    },
    get seqs() {
      return seqs
    },
    maxPaint() {
      const re = /paint=(\d+)/g
      let max = 0
      let m: RegExpExecArray | null = re.exec(buffer)
      while (m !== null) {
        max = Math.max(max, Number(m[1]))
        m = re.exec(buffer)
      }
      return max
    },
  }
}

export async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
