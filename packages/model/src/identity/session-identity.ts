/**
 * Pure session-identity predicates: what counts as a "real" (generic-surface)
 * session vs. a headless shadow, and how duplicate rows for the same underlying
 * agent conversation collapse. Structural types (not @podium/protocol's
 * SessionMeta) — domain is a zero-dependency leaf.
 */

export interface HeadlessFields {
  headless?: boolean
}

/**
 * A HEADLESS session (concierge unification): a superagent thread's harness
 * session with no PTY. It renders ONLY inside the superagent panel's embedded
 * ChatView (which is handed its sessionId explicitly) — every generic session
 * surface (tabs, sidebar, home board, work items, issue counts) must skip it.
 */
export function isHeadlessSession(s: HeadlessFields): boolean {
  return s.headless === true
}

/** Drop headless sessions from a generic session enumeration. */
export function withoutHeadless<S extends HeadlessFields>(sessions: S[]): S[] {
  return sessions.some(isHeadlessSession) ? sessions.filter((s) => !isHeadlessSession(s)) : sessions
}

export interface ResumableSession extends HeadlessFields {
  sessionId: string
  status: string
  lastActiveAt: string
  resume?: { kind: string; value: string }
}

/**
 * Collapse duplicate session rows that point at the SAME underlying agent
 * conversation (same resume ref) — e.g. a Codex thread that surfaced twice on
 * resume. Keeps the most useful row per ref (live > starting/reconnecting >
 * hibernated > exited; ties break to the most-recently-active) and preserves
 * order. Sessions with no resume ref are distinct and never merged. Any resume
 * group containing an active row is preserved in full because native identity
 * metadata must never hide or redirect a live Podium session identity.
 */
export function dedupeSessionsByResume<S extends ResumableSession>(sessions: S[]): S[] {
  const rank = (s: S): number => {
    switch (s.status) {
      case 'live':
        return 3
      case 'starting':
      case 'reconnecting':
        return 2
      case 'hibernated':
        return 1
      default:
        return 0 // exited
    }
  }
  const better = (a: S, b: S): S => {
    if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b
    return a.lastActiveAt >= b.lastActiveAt ? a : b
  }
  // [spec:SP-fccf] A live row is identified only by its Podium session id. If
  // ANY active row shares a native ref with another row, keep the whole group
  // visible: using resume metadata to hide even the parked sibling would make
  // the active row participate in native-id identity/deduplication.
  const activeRefs = new Set<string>()
  for (const session of sessions) {
    if (!session.resume || isHeadlessSession(session)) continue
    if (!['live', 'starting', 'reconnecting'].includes(session.status)) continue
    activeRefs.add(`${session.resume.kind}:${session.resume.value}`)
  }
  const indexByRef = new Map<string, number>()
  const out: S[] = []
  for (const s of sessions) {
    const key = s.resume && !isHeadlessSession(s) ? `${s.resume.kind}:${s.resume.value}` : undefined
    // A headless session shares its resume ref with its terminal twin by design.
    // Any group touching a live row stays fail-visible so every stable Podium
    // id remains independently usable. Only all-parked legacy twins collapse.
    if (!key || activeRefs.has(key)) {
      out.push(s)
      continue
    }
    const at = indexByRef.get(key)
    const existing = at === undefined ? undefined : out[at]
    if (at === undefined || existing === undefined) {
      indexByRef.set(key, out.length)
      out.push(s)
    } else {
      out[at] = better(existing, s)
    }
  }
  return out
}
