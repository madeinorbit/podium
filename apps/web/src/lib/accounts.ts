import { cookieCredentials, createAuthClient } from '@podium/client-core/accounts'
import { workspaceFetch } from './workspace-request'

export const webAuth = createAuthClient({
  credentials: cookieCredentials,
  fetch: workspaceFetch,
  validateProbeEnvelope: false,
  timeoutMs: null,
  loginRefusalMessage: (status) =>
    status === 429
      ? 'too many attempts — wait a moment, then try again'
      : 'incorrect email or password — try again',
})

