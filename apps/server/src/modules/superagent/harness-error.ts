/**
 * Interpret a raw harness failure (POD-1021) into a concise, user-facing
 * message. Headless turns surface the harness's raw stderr — e.g. a codex
 * `rmcp::transport::worker … Auth(AuthorizationRequired)` dump — which is
 * meaningless to a user and, worse, mislabels a Podium-side transport bug as an
 * "authorization" problem. This classifier separates the cases that look alike
 * but demand different action:
 *
 *  - `usage-limit`   — the model provider's quota/rate limit (429). Wait or switch.
 *  - `provider-auth` — the harness's own login expired. Re-authenticate.
 *  - `mcp-transport` — Podium's tool endpoint connection failed. A Podium bug.
 *  - `timeout` / `not-installed` / `unknown` — the remaining shapes.
 *
 * Ordering matters: the MCP transport crash carries the literal text
 * "AuthorizationRequired"/"unauthorized", so it MUST be matched before the
 * provider-auth rule or every transport blip would read as a login failure.
 */

import type { HarnessAgent } from '@podium/protocol'

export type HarnessErrorKind =
  | 'usage-limit'
  | 'provider-auth'
  | 'mcp-transport'
  | 'timeout'
  | 'not-installed'
  | 'unknown'

export interface ClassifiedHarnessError {
  kind: HarnessErrorKind
  /** Concise, user-facing explanation — no stack traces or transport noise. */
  message: string
}

/** Human-facing harness label (never a raw kind string). */
const PROVIDER_LABEL: Record<HarnessAgent, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'opencode',
  cursor: 'Cursor',
}

/** How the user re-authenticates each harness's provider. */
const REAUTH_HINT: Partial<Record<HarnessAgent, string>> = {
  codex: 'run `codex login` (or refresh your ChatGPT session)',
  'claude-code': 'run `claude login`',
  grok: 're-authenticate the Grok CLI',
}

/** Collapse whitespace and keep a short, readable tail of a raw error. */
function shorten(raw: string, max = 300): string {
  // Strip ANSI escapes and leading ISO timestamps, collapse whitespace.
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > max ? `…${cleaned.slice(-max)}` : cleaned
}

export function classifyHarnessError(raw: string, agent: HarnessAgent): ClassifiedHarnessError {
  const provider = PROVIDER_LABEL[agent] ?? agent
  const text = raw.toLowerCase()

  // 1. Podium's own MCP tool endpoint — checked FIRST (its rmcp text contains
  //    "AuthorizationRequired"/"unauthorized", which the provider-auth rule
  //    would otherwise claim).
  if (/rmcp|transport channel closed|authorizationrequired/.test(text)) {
    return {
      kind: 'mcp-transport',
      message:
        `${provider} couldn't connect to Podium's tool endpoint (an MCP transport error). ` +
        `This is a Podium-side problem, not your ${provider} account — retrying usually clears it. ` +
        `If it keeps happening, the server needs attention.`,
    }
  }

  // 2. Provider usage / rate limit (429).
  if (/usage limit|rate.?limit|too many requests|\b429\b|quota|you'?ve hit your/.test(text)) {
    return {
      kind: 'usage-limit',
      message:
        `You've hit your ${provider} usage limit. ` +
        `Wait for the limit to reset, or switch to a different model or harness.`,
    }
  }

  // 3. Harness login expired / not authenticated (a model-side 401, distinct
  //    from the MCP transport case above).
  if (
    /\b401\b|not logged in|unauthorized|access token (is )?expired|authentication (failed|required)|please (log|sign)[ -]?in/.test(
      text,
    )
  ) {
    const hint = REAUTH_HINT[agent]
    return {
      kind: 'provider-auth',
      message:
        `Your ${provider} login has expired or isn't set up. ` +
        (hint ? `Please ${hint}, then retry.` : `Please re-authenticate ${provider}, then retry.`),
    }
  }

  // 4. Turn timed out.
  if (/timed out|timeout/.test(text)) {
    return {
      kind: 'timeout',
      message: `The ${provider} turn timed out before it finished. Retry, or simplify the request.`,
    }
  }

  // 5. CLI missing / not launchable.
  if (/command not found|\benoent\b|no such file|is not installed/.test(text)) {
    return {
      kind: 'not-installed',
      message: `The ${provider} CLI couldn't be launched — it isn't installed or isn't on PATH.`,
    }
  }

  // 6. Fallback — trimmed, readable tail.
  return { kind: 'unknown', message: `The ${provider} turn failed: ${shorten(raw)}` }
}
