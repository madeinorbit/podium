/**
 * Redacted Claude auth-state inspector for POD-3028.
 * Prints path, mode, mtime, expiry, and key names only. Never prints token values.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const now = Date.now()
const credPath = join(homedir(), '.claude', '.credentials.json')
const jsonPath = join(homedir(), '.claude.json')

const out: Record<string, unknown> = {
  at: new Date(now).toISOString(),
  home: homedir(),
}

if (!existsSync(credPath)) {
  out.credential = { path: credPath, exists: false }
} else {
  const st = statSync(credPath)
  const raw = JSON.parse(await Bun.file(credPath).text()) as {
    claudeAiOauth?: Record<string, unknown>
  }
  const oauth = raw.claudeAiOauth ?? {}
  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
  const refreshExpires =
    typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : null
  out.credential = {
    path: credPath,
    exists: true,
    mode: st.mode.toString(8),
    mtime: st.mtime.toISOString(),
    sizeBytes: st.size,
    topLevelKeys: Object.keys(raw).sort(),
    oauthKeys: Object.keys(oauth).sort(),
    hasAccessToken: typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0,
    hasRefreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : null,
    expiresAtIso: expiresAt ? new Date(expiresAt).toISOString() : null,
    refreshTokenExpiresAtIso: refreshExpires ? new Date(refreshExpires).toISOString() : null,
    expired: expiresAt === null ? null : expiresAt <= now,
    remainingMinutes: expiresAt === null ? null : Math.round((expiresAt - now) / 60_000),
    insideTenMinuteFloor: expiresAt === null ? null : expiresAt <= now + 600_000,
  }
}

if (!existsSync(jsonPath)) {
  out.claudeJson = { path: jsonPath, exists: false }
} else {
  const st = statSync(jsonPath)
  const raw = JSON.parse(await Bun.file(jsonPath).text()) as {
    hasCompletedOnboarding?: boolean
    lastOnboardingVersion?: string
    oauthAccount?: Record<string, unknown>
  }
  const oauthAccount = raw.oauthAccount
  out.claudeJson = {
    path: jsonPath,
    exists: true,
    mode: st.mode.toString(8),
    mtime: st.mtime.toISOString(),
    sizeBytes: st.size,
    hasCompletedOnboarding: raw.hasCompletedOnboarding === true,
    lastOnboardingVersion:
      typeof raw.lastOnboardingVersion === 'string' ? raw.lastOnboardingVersion : null,
    hasOauthAccount: Boolean(oauthAccount),
    oauthAccountKeys: oauthAccount ? Object.keys(oauthAccount).sort() : [],
    hasEmail:
      typeof oauthAccount?.emailAddress === 'string' &&
      String(oauthAccount.emailAddress).includes('@'),
  }
}

console.log(JSON.stringify(out, null, 2))
