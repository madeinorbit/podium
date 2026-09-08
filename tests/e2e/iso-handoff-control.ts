import type { IncomingMessage, ServerResponse } from 'node:http'

type Body = Record<string, unknown>
export interface HandoffControlDeps {
  listMachines(): Promise<unknown>
  listSessions(): Promise<unknown>
  listRepos(): Promise<unknown>
  createSession(body: Body): Promise<unknown>
  sendText(body: Body): Promise<unknown>
  handoffSession(body: Body): Promise<unknown>
  scanRepos(): Promise<unknown>
}

/** The isolated host's real control handler, importable without starting agents. */
export function handoffControl(deps: HandoffControlDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let result: unknown
      if (req.method === 'GET' && url.pathname === '/state') {
        result = {
          machines: await deps.listMachines(),
          sessions: await deps.listSessions(),
          repos: await deps.listRepos(),
        }
      } else if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw ? JSON.parse(raw) as Body : {}
        if (url.pathname === '/spawn') result = await deps.createSession(body)
        else if (url.pathname === '/send') result = await deps.sendText(body)
        else if (url.pathname === '/handoff') result = await deps.handoffSession(body)
        else if (url.pathname === '/scan') result = await deps.scanRepos()
        else { res.writeHead(404).end('not found'); return }
      } else { res.writeHead(404).end('not found'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }
}
