import { createSocketLogin } from '@podium/client-core/live-connection'

export function configureNativeWebSocketCredential(
  _origin: string | null,
  _bearer: string | null,
): void {}
export function installNativeWebSocketAuthentication(): void {}

export const makePlatformSocketLogin = createSocketLogin
