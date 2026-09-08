import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { handoffControl, type HandoffControlDeps } from '../tests/e2e/iso-handoff-control'

const deps = (): HandoffControlDeps => ({
  listMachines: async () => [{ id: 'machine' }],
  listSessions: async () => [{ id: 'session' }],
  listRepos: async () => [{ id: 'repo' }],
  createSession: async () => ({ sessionId: 'created' }),
  sendText: async () => ({ accepted: true }),
  handoffSession: async () => ({ machineId: 'destination' }),
  scanRepos: async () => [],
})
function request(path: string, services = deps()) {
  let status = 0
  let body: string | undefined
  const req = {
    url: path, method: path === '/state' ? 'GET' : 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"sessionId":"session","text":"hello"}') },
  } as IncomingMessage
  const res = {
    writeHead(code: number) { status = code; return this },
    end(value: string) { body = value; return this },
  } as unknown as ServerResponse
  const done = handoffControl(services)(req, res)
  return { done, response: () => ({ status, body: body === undefined ? undefined : JSON.parse(body) }) }
}

describe('isolated handoff control responses', () => {
  it('serializes completed machine, session and repository state', async () => {
    const call = request('/state')
    await call.done
    expect(call.response()).toEqual({ status: 200, body: {
      machines: [{ id: 'machine' }], sessions: [{ id: 'session' }], repos: [{ id: 'repo' }],
    } })
  })
  it.each(['/spawn', '/send'])('waits for %s completion before reporting success', async (path) => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const services = deps()
    if (path === '/spawn') services.createSession = () => pending
    else services.sendText = () => pending
    const call = request(path, services)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call.response()).toEqual({ status: 0, body: undefined })
    finish({ accepted: true, sessionId: 'created' })
    await call.done
    expect(call.response()).toEqual({ status: 200, body: { accepted: true, sessionId: 'created' } })
  })
  it.each(['/spawn', '/send'])('reports %s failure as an error response', async (path) => {
    const services = deps()
    const fail = async () => { throw new Error('operation refused') }
    if (path === '/spawn') services.createSession = fail
    else services.sendText = fail
    const call = request(path, services)
    await call.done
    expect(call.response()).toEqual({ status: 500, body: { error: 'operation refused' } })
  })
})
