/**
 * The harness command guard (POD-3890): a PreToolUse hook that refuses a shell command
 * reaching the compiler or a test runner directly, and names the sanctioned lane.
 *
 * WHY A HOOK WHEN THE RUNNERS ALREADY REFUSE. `scripts/typecheck-project.ts` refuses
 * outside Turbo and the package test scripts take admission themselves, so the
 * enforcement does not depend on this file. What the hook adds is the message BEFORE
 * the cost: a raw `vitest run` in apps/server collects nothing and exits 0, a raw
 * `tsc --noEmit` in apps/web takes a gigabyte for a minute, and either one happens
 * before any refusal text can be read. The hook answers in the tool result instead,
 * with the command that should have been run.
 *
 * One guard, four harnesses. Claude Code and Grok read it from `.claude/settings.json`
 * (Grok loads Claude-format project hooks), and the same judgement is mirrored as
 * declarative deny rules for Codex (`.codex/rules/default.rules`) and OpenCode
 * (`opencode.json`), which have no process hook worth spawning. The rule files cover
 * the common spellings by prefix; this file understands the shell — pipes, `&&`, a
 * leading `cd`, env assignments, `bunx`/`npx`/`bun x`, and paths into node_modules.
 *
 * Output follows the Claude Code hook protocol, which Grok and Codex accept: a
 * `permissionDecision: deny` on stdout with the reason, exit 0. Anything the guard does
 * not understand is allowed — it is a tripwire for known bypasses, not a sandbox.
 */

const COMPILERS = new Set(['tsc', 'tsgo'])
const RUNNERS = new Set(['vitest', 'playwright', 'turbo', 'jest'])
const EXEC_SHIMS = new Set(['bunx', 'npx', 'pnpx', 'pnpm', 'yarn'])
const TRANSPARENT = new Set(['sudo', 'time', 'nohup', 'exec', 'env', 'nice', 'command'])
const PACKAGE_LANES = /^(test|typecheck)(:|$)/

export const SANCTIONED = `\
Typecheck and tests run only through the repository's wrappers, which take the
host's validation slots, key the shared cache on the install, and force the flags:

  bun run typecheck                          every project, cached (TypeScript 7, incremental)
  bun run typecheck -- --filter <package>    one project and its dependencies
  bun run test                               the lean end-of-task gate
  bun run test:file -- <test files...>       exactly those files, right config, any vitest args
  bun run test:lane -- <lane> [args]         a named lane; \`--list\` shows them
  bun run test:related -- <source file>      unit tests importing a changed source
  bun run test:web | test:mobile | test:affected | test:changed
  bun run test:full -- --full-because="…"    the sweep, with the reason it is needed

docs/agents/testing.md maps every change to its lane.`

export interface Verdict {
  /** what was recognised, for the reason line */
  offender: string
  hint: string
}

function basename(token: string): string {
  return (
    token
      .replace(/^['"]|['"]$/g, '')
      .split('/')
      .pop() ?? token
  )
}

/** Shell words of one simple command, env assignments and transparent prefixes stripped. */
function words(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  while (tokens.length > 0) {
    const head = tokens[0] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || TRANSPARENT.has(head)) tokens.shift()
    else break
  }
  return tokens
}

function judgeWords(tokens: string[], inPackageDir: boolean): Verdict | null {
  if (tokens.length === 0) return null
  const program = basename(tokens[0] as string)
  const rest = tokens.slice(1)

  if (COMPILERS.has(program)) {
    return { offender: tokens[0] as string, hint: 'bun run typecheck [-- --filter <package>]' }
  }
  if (RUNNERS.has(program) || program === 'vitest.mjs') {
    return { offender: tokens[0] as string, hint: 'bun run test:file / test:lane' }
  }
  if (EXEC_SHIMS.has(program)) {
    // bunx tsc, npx vitest, pnpm exec tsc, bun x ... (handled below), yarn tsc
    const target = rest.find((t) => !t.startsWith('-') && t !== 'exec' && t !== 'dlx')
    if (target) {
      const name = basename(target).replace(/@.*$/, '')
      if (COMPILERS.has(name) || RUNNERS.has(name)) {
        return {
          offender: `${program} ${target}`,
          hint: COMPILERS.has(name) ? 'bun run typecheck' : 'bun run test:file / test:lane',
        }
      }
    }
    return null
  }
  if (program === 'bun' || program === 'node') {
    const flags: string[] = []
    let index = 0
    while (index < rest.length && (rest[index] as string).startsWith('-')) {
      flags.push(rest[index] as string)
      // flags that take a value
      if (['--cwd', '--filter', '-F', '--conditions', '-c'].includes(rest[index] as string)) {
        flags.push(rest[++index] as string)
      }
      index++
    }
    const verb = rest[index]
    if (!verb) return null
    const after = rest.slice(index + 1)
    if (program === 'bun' && verb === 'x') return judgeWords(['bunx', ...after], inPackageDir)
    if (program === 'bun' && verb === 'test') {
      return {
        offender: 'bun test',
        hint: 'bun run test:file -- <file.bun.test.ts> (or test:bun:unit)',
      }
    }
    if (program === 'bun' && verb === 'run') {
      // `bun run [flags] <script>`: the flags sit AFTER the verb.
      let scoped = flags.some((f) => f === '--cwd' || f === '--filter' || f === '-F')
      let script: string | undefined
      for (let at = 0; at < after.length; at++) {
        const token = after[at] as string
        if (token === '--cwd' || token === '--filter' || token === '-F') {
          scoped = true
          at++
        } else if (token.startsWith('--cwd=') || token.startsWith('--filter=')) {
          scoped = true
        } else if (!token.startsWith('-')) {
          script = token
          break
        }
      }
      if (script && PACKAGE_LANES.test(script) && (scoped || inPackageDir)) {
        return {
          offender: `bun run ${script} in a package directory`,
          hint: script.startsWith('typecheck')
            ? 'bun run typecheck -- --filter <package>'
            : 'bun run test:lane -- <lane> (from the root)',
        }
      }
      if (script === 'typecheck:tsc') return { offender: script, hint: 'bun run typecheck' }
      return null
    }
    const name = basename(verb)
    if (COMPILERS.has(name)) return { offender: `${program} ${verb}`, hint: 'bun run typecheck' }
    if (RUNNERS.has(name) || name === 'vitest.mjs') {
      return { offender: `${program} ${verb}`, hint: 'bun run test:file / test:lane' }
    }
    return null
  }
  return null
}

/** Pure: null means "not ours to judge". */
export function judgeCommand(command: string): Verdict | null {
  const segments = command.split(/\n|&&|\|\||;|\|/)
  let inPackageDir = false
  for (const segment of segments) {
    const tokens = words(segment)
    if (tokens[0] === 'cd') {
      const target = tokens[1]
      inPackageDir =
        Boolean(target) &&
        !/^(\.|\/|\$|~|-)?$/.test(target as string) &&
        /^(apps|packages|services|tests|scripts|tooling)\b/.test(target as string)
      continue
    }
    const verdict = judgeWords(tokens, inPackageDir)
    if (verdict) return verdict
  }
  return null
}

export function reason(verdict: Verdict): string {
  return `Refused: \`${verdict.offender}\` bypasses the sanctioned lanes. Use: ${verdict.hint}\n\n${SANCTIONED}`
}

function extractCommand(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const input = (payload as { tool_input?: unknown }).tool_input
  if (typeof input !== 'object' || input === null) return null
  const command =
    (input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd
  if (typeof command === 'string') return command
  if (Array.isArray(command)) return command.map(String).join(' ')
  return null
}

async function main() {
  const raw = await new Response(Bun.stdin.stream()).text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  const command = extractCommand(payload)
  if (!command) return
  const verdict = judgeCommand(command)
  if (!verdict) return
  const text = reason(verdict)
  console.error(text)
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: text,
      },
    }),
  )
}

if (import.meta.main) await main()
