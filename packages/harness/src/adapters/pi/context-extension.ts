/** Launch-scoped extension source. Builtins only: no SDK host or RPC writer. */
import { PI_CONTEXT_SCHEMA } from './context-native.js'

export function piContextExtensionSource(endpoint: string, version: string): string {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('Pi observations require the existing loopback callback')
  return `import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
export default function(pi) {
  const runId = randomUUID()
  let sequence = 0
  let closed = false
  const disposers = []
  // Bounded HTTP, no keepalive agent, retry loop, worker, poll or stdout.
  function post(payload) {
    return new Promise(resolve => {
      let timer
      const finish = () => { clearTimeout(timer); resolve() }
      const req = request(${JSON.stringify(endpoint)}, {
        method: 'POST', agent: false, headers: { 'content-type': 'application/json' }
      }, res => { res.resume(); res.once('end', finish); res.once('error', finish) })
      timer = setTimeout(() => req.destroy(), 500)
      req.once('error', finish)
      req.once('close', finish)
      req.end(JSON.stringify(payload))
    })
  }
  const witness = message => message && ({
    role: message.role, timestamp: message.timestamp, provider: message.provider,
    model: message.model, stopReason: message.stopReason, responseId: message.responseId,
    usage: message.usage && {
      input: message.usage.input, output: message.usage.output,
      cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite,
      reasoning: message.usage.reasoning
    }
  })
  async function sample(event, ctx) {
    if (closed) return
    try {
      const branch = ctx.sessionManager.getBranch()
      let anchor, compactionId
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]
        if (entry.type === 'compaction') { compactionId = entry.id; break }
        if (!anchor && entry.type === 'message' && entry.message.role === 'assistant' &&
            !['aborted', 'error'].includes(entry.message.stopReason)) {
          anchor = { id: entry.id, ...witness(entry.message) }
        }
      }
      await post({
        schema: ${JSON.stringify(PI_CONTEXT_SCHEMA)}, piVersion: ${JSON.stringify(version)},
        runId, sequence: ++sequence, at: new Date().toISOString(),
        event: event.type, reason: event.reason,
        sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
        compactionId, anchor, message: witness(event.message),
        model: ctx.model && { id: ctx.model.id, provider: ctx.model.provider },
        contextUsage: ctx.getContextUsage() ?? null
      })
    } catch { /* Telemetry must not change native behavior or stdout. */ }
    finally {
      if (event.type === 'session_shutdown') {
        closed = true
        for (const dispose of disposers.splice(0)) dispose()
      }
    }
  }
  for (const event of [
    'session_start', 'session_shutdown', 'model_select', 'message_start', 'message_end',
    'turn_end', 'agent_end', 'agent_settled', 'session_before_compact', 'session_compact',
    'session_compact_failed', 'session_before_switch', 'session_before_fork',
    'session_before_tree', 'session_tree'
  ]) disposers.push(pi.on(event, sample))
}
`
}
