import type { HarnessLogin } from './manifest.js'

/** Codex replaces auth.json in place while refreshing a login. */
export const CODEX_CREDENTIAL_ABSENCE_GRACE_MS = 5_000

/**
 * Keep the last settled login while auth.json is briefly absent. A missing
 * parent directory is structural, not a rotation, so it never receives grace.
 */
export class CodexCredentialAbsenceGrace {
  private readonly missingSince = new Map<string, number>()
  private readonly lastSettled = new Map<string, HarnessLogin>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly graceMs = CODEX_CREDENTIAL_ABSENCE_GRACE_MS,
  ) {}

  present(path: string, login: HarnessLogin): HarnessLogin {
    this.missingSince.delete(path)
    if (login.state === 'in') this.lastSettled.set(path, login)
    else this.lastSettled.delete(path)
    return login
  }

  missing(path: string, parentExists: boolean): HarnessLogin {
    if (!parentExists) {
      this.missingSince.delete(path)
      this.lastSettled.delete(path)
      return { state: 'out' }
    }

    const started = this.missingSince.get(path) ?? this.now()
    this.missingSince.set(path, started)
    if (this.now() - started < this.graceMs) {
      return this.lastSettled.get(path) ?? { state: 'unknown' }
    }

    this.missingSince.delete(path)
    this.lastSettled.delete(path)
    return { state: 'out' }
  }
}
