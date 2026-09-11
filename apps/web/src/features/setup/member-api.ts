import { workspaceFetch } from '@/lib/workspace-request'
export async function memberRequest<T>(origin: string, action: string, body?: unknown): Promise<T> {
  const response = await workspaceFetch(`${origin}/auth/members/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to reach the server')
  return data as T
}
