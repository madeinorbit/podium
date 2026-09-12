import { CredentialWriteQueue } from './credential-ownership'

export const HOSTED_API_ORIGIN = 'https://api.podium.do'
export const HOSTED_SIGN_IN_URL = 'https://ade.podium.do/account/sign-in'
const proof = /^[a-f0-9]{64}$/
const ended = 'This sign-in attempt has ended. Start sign-in again.'
export interface HostedReturn {
  code: string
  challenge: string
}
export interface HostedSession {
  server: string
  token: string
  workspaceId?: string
}
export class HostedSignInCanceledError extends Error {
  readonly session: HostedSession

  constructor(session: HostedSession) {
    super(ended)
    this.name = 'HostedSignInCanceledError'
    this.session = session
  }
}
interface Attempt {
  server: string
  appOrigin: string
  challenge: string
  verifier: string
  expiresAt: number
  workspaceId?: string
}
export function isHostedReturn(raw: string): boolean {
  return /^podium:\/\/signed-in(?:[/?#]|$)/i.test(raw)
}
export function parseHostedReturn(raw: string): HostedReturn {
  const url = new URL(raw)
  const code = url.searchParams.get('code') ?? ''
  const challenge = url.searchParams.get('challenge') ?? ''
  if (
    raw.length > 1024 ||
    url.protocol !== 'podium:' ||
    url.host !== 'signed-in' ||
    url.username ||
    url.password ||
    url.pathname ||
    url.hash ||
    [...url.searchParams.keys()].length !== 2 ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.getAll('challenge').length !== 1 ||
    !/^hoff_[A-Za-z0-9]{27}$/.test(code) ||
    !proof.test(challenge)
  )
    throw new Error(ended)
  return { code, challenge }
}
function origin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Sign-in requires HTTPS.')
  return url.origin
}
export interface HostedSignInDependencies {
  fetch: typeof fetch
  read(): Promise<string | null>
  write(value: string): Promise<void>
  remove(): Promise<void>
  digest(value: string): Promise<string>
  open(url: string): Promise<unknown>
  now(): number
}
/** One durable receiver attempt. Codes/URLs never enter metadata, logs or router state. */
export function createHostedSignIn(deps: HostedSignInDependencies) {
  const queue = new CredentialWriteQueue()
  let generation = 0
  const post = (
    server: string,
    path: string,
    appOrigin: string,
    body: unknown,
    workspaceId?: string,
  ) =>
    deps.fetch(server + path, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Origin: appOrigin,
        ...(workspaceId ? { 'Podium-Workspace-Id': workspaceId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  return {
    cancel() {
      generation++
      return queue.run(() => deps.remove())
    },
    async begin(server = HOSTED_API_ORIGIN, signInUrl = HOSTED_SIGN_IN_URL, workspaceId?: string) {
      const current = ++generation
      return queue.run(async () => {
        await deps.remove()
        if (origin(server) !== server) throw new Error('Invalid server origin.')
        const page = new URL(signInUrl)
        const appOrigin = origin(signInUrl)
        if (page.pathname !== '/account/sign-in') throw new Error('Invalid account sign-in page.')
        const started = deps.now()
        const response = await post(
          server,
          '/platform/auth/handoff/begin',
          appOrigin,
          {},
          workspaceId,
        )
        if (!response.ok) throw new Error('Could not start sign-in. Try again.')
        const body = await response.json()
        // Native Expo fetch exposes response headers; never depend on a browser cookie jar.
        const cookies = response.headers.get('set-cookie') ?? ''
        const matches = [
          ...cookies.matchAll(/(?:^|,\s*)__Host-podium-handoff=([a-f0-9]{64})(?=;|$)/g),
        ]
        const verifier = matches.length === 1 ? matches[0]![1]! : ''
        if (
          !verifier ||
          !proof.test(body.challenge) ||
          (await deps.digest(verifier)) !== body.challenge
        )
          throw new Error('The server did not return a valid sign-in attempt.')
        if (current !== generation) throw new Error(ended)
        const attempt: Attempt = {
          server,
          workspaceId,
          appOrigin,
          verifier,
          challenge: body.challenge,
          expiresAt: started + 600_000,
        }
        if (attempt.expiresAt <= deps.now()) throw new Error(ended)
        await deps.write(JSON.stringify(attempt))
        if (current !== generation) {
          await deps.remove()
          throw new Error(ended)
        }
        // The account shell's existing intent serves both native clients.
        page.search = new URLSearchParams({
          handoff: 'desktop',
          challenge: attempt.challenge,
          switchAccount: '1',
        }).toString()
        page.hash = ''
        try {
          await deps.open(page.href)
        } catch {
          await deps.remove()
          throw new Error('Could not open the browser. Try signing in again.')
        }
      })
    },
    async redeem(link: HostedReturn) {
      const current = generation
      const attempt = await queue.run(async () => {
        let value: Attempt | null = null
        try {
          value = JSON.parse((await deps.read()) ?? 'null')
        } catch {
          /* invalid durable state */
        }
        if (
          !value ||
          !proof.test(value.verifier) ||
          !proof.test(value.challenge) ||
          !Number.isFinite(value.expiresAt) ||
          value.expiresAt <= deps.now() ||
          value.expiresAt > deps.now() + 600_000 ||
          origin(value.server) !== value.server ||
          (value.workspaceId !== undefined &&
            (typeof value.workspaceId !== 'string' ||
              value.workspaceId.length === 0 ||
              value.workspaceId.length > 256)) ||
          origin(value.appOrigin) !== value.appOrigin ||
          (await deps.digest(value.verifier)) !== value.challenge
        ) {
          await deps.remove()
          throw new Error(ended)
        }
        if (link.challenge !== value.challenge || !/^hoff_[A-Za-z0-9]{27}$/.test(link.code))
          throw new Error(ended)
        // Consume BEFORE network I/O, including on ambiguous network failure.
        await deps.remove()
        return value
      })
      if (current !== generation) throw new Error(ended)
      const response = await post(
        attempt.server,
        '/platform/auth/handoff',
        attempt.appOrigin,
        {
          code: link.code,
          transport: 'bearer',
          verifier: attempt.verifier,
        },
        attempt.workspaceId,
      )
      if (!response.ok) throw new Error(ended)
      const body = await response.json()
      if (
        typeof body.token !== 'string' ||
        !body.token ||
        /\s/.test(body.token) ||
        typeof body.expiresAt !== 'string' ||
        !(Date.parse(body.expiresAt) > deps.now())
      )
        throw new Error('The server did not return a valid phone session.')
      const session: HostedSession = {
        server: attempt.server,
        token: body.token as string,
        ...(attempt.workspaceId ? { workspaceId: attempt.workspaceId } : {}),
      }
      if (current !== generation) throw new HostedSignInCanceledError(session)
      return session
    },
  }
}
