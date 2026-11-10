/**
 * WHAT A PASSWORD LOGIN RUNS ON (POD-6701).
 *
 * A browser or desktop sign-in is listed to its owner and to admins by a name
 * and an OS, so a person can tell "Firefox on Linux" from "Podium desktop on
 * macOS" before signing one of them out. Both come from the login request: the
 * OS and browser from its User-Agent, desktop from the desktop shell's webview
 * origin. Nothing here authenticates anything; a request may say what it
 * likes, and the worst a false answer does is mislabel its own row.
 */

import type { ClientSessionMetadata } from './auth-route'

type SignInPlatform = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown'

const OS_NAMES: Record<Exclude<SignInPlatform, 'unknown'>, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
}

function platformOf(userAgent: string): SignInPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  if (/Android/.test(userAgent)) return 'android'
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux|X11|CrOS/.test(userAgent)) return 'linux'
  return 'unknown'
}

function browserOf(userAgent: string): string | undefined {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return 'Edge'
  if (/OPR\//.test(userAgent)) return 'Opera'
  if (/Firefox\/|FxiOS\//.test(userAgent)) return 'Firefox'
  if (/Chrome\/|CriOS\/|Chromium\//.test(userAgent)) return 'Chrome'
  if (/Safari\//.test(userAgent)) return 'Safari'
  return undefined
}

/** The desktop shell loads its bundled UI from `tauri://localhost` (Windows: `http(s)://tauri.localhost`). */
function isDesktopOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'tauri:' || url.hostname === 'tauri.localhost'
  } catch {
    return false
  }
}

/** The stored description of a password login in a browser or the desktop app. */
export function browserSignInMetadata(
  userAgent: string | undefined,
  origin: string | undefined,
  lastSeenAt: string,
): ClientSessionMetadata {
  const agent = userAgent ?? ''
  const platform = platformOf(agent)
  const desktop = isDesktopOrigin(origin)
  const app = desktop ? 'Podium desktop' : (browserOf(agent) ?? 'Web browser')
  const deviceName = platform === 'unknown' ? app : `${app} on ${OS_NAMES[platform]}`
  return { deviceId: desktop ? 'desktop' : 'browser', deviceName, platform, lastSeenAt }
}
