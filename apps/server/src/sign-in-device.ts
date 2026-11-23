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

import type { DeviceDescription } from '@podium/identity'

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

/** Only phones have a stable device id; two browsers keep separate sign-ins. */
export function browserSignInDevice(
  userAgent: string | undefined,
  origin: string | undefined,
  desktopHint = false,
): DeviceDescription {
  const agent = userAgent ?? ''
  const platform = platformOf(agent)
  // The shell can also load a remote site directly, with an ordinary HTTPS origin.
  const desktop = desktopHint || isDesktopOrigin(origin)
  const app = desktop ? 'Podium desktop' : (browserOf(agent) ?? 'Web browser')
  return {
    kind: desktop ? 'desktop' : 'browser',
    name: platform === 'unknown' ? app : `${app} on ${OS_NAMES[platform]}`,
    platform,
  }
}
