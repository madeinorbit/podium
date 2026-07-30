/**
 * THE CLIENT-SECRET AUDIT (POD-419; the fifteenth gate).
 *
 * Run:
 *   bun run audit:client-secrets            # the gate — exit 1 on any finding
 *   bun run audit:client-secrets --json
 *   bun run audit:client-secrets --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS OF DIFFERENT KINDS, AND THIS IS THE TEXTUAL ONE
 * ---------------------------------------------------------------------------
 *
 * `packages/sync/src/adapters/secret-scrub.test.ts` reads the RUNNING STORE: it
 * seeds material into a real IndexedDB and a real SQLite file the way an earlier
 * build left it, opens the adapter, and reads every durable row back through a
 * connection of its own. It is the only instrument that can answer "is there
 * material on the disk", and it is where the two-sided contract (the secret is
 * gone AND the survivors are intact) is proved.
 *
 * This script resolves no app modules and reads source TEXT, so it runs in a
 * fresh checkout before anything is built. It catches what the runtime check
 * structurally cannot:
 *
 *   · the scrub being unwired from an adapter's open path — the store then holds
 *     whatever it held, and every runtime assertion made through a clean fixture
 *     still passes;
 *   · a SECOND key list appearing beside the classification, which is the fork
 *     this programme exists to end;
 *   · a consumer left reading a secret off the settings blob. This one is the
 *     reason the gate exists at all: `PodiumSettings` still DECLARES the legacy
 *     members (POD-418 kept them so the classification stays total over the blob
 *     that exists), so such a read still compiles, still typechecks, and now
 *     silently returns `''` — a credential that stops working with no error
 *     anywhere. There is no compiler for this; only a census.
 *
 * ---------------------------------------------------------------------------
 * THE VOCABULARY IS DERIVED, NOT RESTATED
 * ---------------------------------------------------------------------------
 *
 * The tokens hunted below come from `settingsPathsInTier('server-secret')` — the
 * same shipped classification the scrub and the migration consume. A gate with
 * its own hand-written key list would keep passing the day a sixth secret is
 * added to the model, which is precisely the failure it is meant to prevent.
 * Check 0 fails FIRST if that derivation comes back empty, because an empty
 * vocabulary makes every census below report zero findings perfectly.
 *
 * ---------------------------------------------------------------------------
 * THE REMAINING SITES ARE NAMED, WITH THEIR OWNING ISSUE, AND RATCHET DOWN
 * ---------------------------------------------------------------------------
 *
 * `apps/web`'s settings screens still bind inputs to the blob's secret members.
 * They are POD-421's to replace with the presence/fingerprint surface, and after
 * this issue they render empty strings rather than material. Rather than exempt
 * `apps/web` wholesale — which would make the gate blind to a SIXTH such site —
 * every one is listed BY FILE with the issue that owns it, and the list is
 * checked in BOTH directions: an entry that vanished is a finding too, so
 * POD-421's removal must delete its line here and the census must go DOWN. An
 * absorbed surface reads as progress on every ratchet (POD-386).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settingsPathsInTier } from '../packages/model/src/settings/classification'

// `import.meta.dir` is Bun-only and is `undefined` under vitest's node pool —
// which is the lane this gate's own test runs in. Same resolution every other
// audit script uses.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Finding {
  readonly check: string
  readonly where: string
  readonly detail: string
}

// ---------------------------------------------------------------------------
// The derived vocabulary
// ---------------------------------------------------------------------------

/** The classified secret paths. DERIVED — see the header. */
export const SECRET_PATHS: readonly string[] = settingsPathsInTier('server-secret')

/**
 * The tokens a source scan can actually hunt, derived from those paths.
 *
 * A path is `group.leaf`. Both halves matter and neither is sufficient alone:
 * `apiKeys` catches `settings.apiKeys[provider]` and `['apiKeys']` and a
 * destructure, which naming the three leaves would miss (`openai` is also a
 * provider id, an account kind and a model prefix — hunting it would drown the
 * gate in false positives); the LEAF is what catches `linearApiKey` and
 * `telegramBotToken`, whose groups (`integrations`, `notifications`) hold
 * preferences too and cannot be hunted as groups at all.
 *
 * This is the "enumerate how the CONCEPT can be written" rule rather than
 * matching one syntax form: every spelling of a member access has to pass one of
 * these tokens through, because the token IS the member's name.
 */
export function secretTokens(paths: readonly string[] = SECRET_PATHS): readonly string[] {
  const tokens = new Set<string>()
  for (const path of paths) {
    const [group, leaf] = path.split('.') as [string, string]
    // A group whose members are ALL secret can be hunted as a group; one that
    // also holds preferences cannot, so its leaf is hunted instead.
    const groupIsAllSecret = paths.filter((p) => p.startsWith(`${group}.`)).length > 0 && group === 'apiKeys'
    tokens.add(groupIsAllSecret ? group : leaf)
  }
  return [...tokens].sort()
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/** Strip line and block comments. A gate that counted prose would be a gate
 *  nobody could document around, and every file here explains itself. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Blank the CONTENTS of quoted string literals, keeping the quotes and length.
 *
 * TEMPLATE LITERALS ARE DELIBERATELY LEFT ALONE. `${settings.apiKeys.openai}` is
 * a real member access that happens to sit inside a template, and blanking
 * backticks would hide it — the fails-OPEN direction, which is the one that
 * matters. Scanning a template's static text can only produce a false POSITIVE
 * (a site to name), never a false negative.
 */
export function blankStringLiterals(text: string): string {
  const blank = (m: string): string => `${m[0]}${' '.repeat(Math.max(0, m.length - 2))}${m[0]}`
  return text.replace(/'(?:[^'\\\n]|\\.)*'/g, blank).replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
}

export interface SourceFile {
  readonly rel: string
  readonly text: string
}

const SCAN_EXTENSIONS = ['.ts', '.tsx']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.turbo', '.git', 'coverage'])

export function collectSources(roots: readonly string[]): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue
      // Tests ARRANGE the state the product must handle — a fixture that seeds a
      // secret is the gate's own evidence, not a violation of it.
      if (entry.includes('.test.') || entry.includes('test-support')) continue
      // A generated file is a projection of a source this gate already reads —
      // `drizzle-manifest.generated.ts` bundles the migration SQL that MOVES the
      // material, so flagging it would report the fix as the defect.
      if (entry.includes('.generated.')) continue
      out.push({ rel: relative(REPO, full), text: readFileSync(full, 'utf8') })
    }
  }
  for (const root of roots) walk(join(REPO, root))
  return out
}

/**
 * Files permitted to name a secret token in CODE, each with the reason.
 *
 * Checked in BOTH directions: an entry whose file no longer names a token is a
 * finding, so a removal has to say which site vanished.
 */
export const NAMED_SITES: readonly { readonly file: string; readonly why: string }[] = [
  // ── the split itself: these files ARE the vocabulary ──────────────────────
  {
    file: 'packages/runtime/src/settings.ts',
    why: 'POD-418 — the legacy blob still DECLARES the members so the classification stays total',
  },
  // ── apps/web: POD-421 replaces these with the presence/fingerprint surface ─
  {
    file: 'apps/web/src/features/settings/sections/keys.tsx',
    why: 'POD-421 — renders the three provider-key inputs; serves `` after POD-419',
  },
  {
    file: 'apps/web/src/features/settings/sections/integrations.tsx',
    why: 'POD-421 — renders the Linear key input; serves `` after POD-419',
  },
  {
    file: 'apps/web/src/features/settings/sections/notifications.tsx',
    why: 'POD-421 — renders the bot-token input; serves `` after POD-419',
  },
  {
    file: 'apps/web/src/features/settings/SettingsView.tsx',
    why: 'POD-421 — gates the Telegram pairing button on the token being configured',
  },
]

/**
 * THE FORMS A BLOB READ CAN TAKE, and why a bare token census is wrong.
 *
 * The first draft hunted the token anywhere and its own probe failed on a CLEAN
 * fixture: `store.secrets.get('apiKeys.anthropic')` — the CORRECT keyed-store
 * call — contains the token, and so does every dependency named for the secret
 * it carries (`telegramBotToken(): string`). A gate that flags the fix as
 * loudly as the defect is a gate someone silences.
 *
 * What is actually being hunted is a MEMBER ACCESS on a settings-shaped value,
 * so the forms are enumerated (the "cover the CONCEPT, not one syntax" rule) and
 * each has its own probe:
 *
 *   F1  `.apiKeys`, `.telegramBotToken`      dot access, NOT a call — a call is a
 *                                            dependency (`deps.telegramBotToken()`),
 *                                            which is how the material is supposed
 *                                            to arrive.
 *   F2  `['apiKeys']`                        computed access, the spelling F1 misses.
 *   F3  `const { apiKeys } = settings`       destructure.
 *
 * A quoted classified PATH (`'apiKeys.openai'`) is the keyed store's own address
 * vocabulary and is deliberately NOT a finding — it is what a correct consumer
 * writes.
 */
export interface BlobReadForm {
  readonly pattern: RegExp
  /**
   * Evaluate against text whose string-literal CONTENTS have been blanked.
   *
   * This is the distinction between the fix and the defect.
   * `store.secrets.get('notifications.telegramBotToken')` is the CORRECT keyed
   * store call and it contains the character sequence `.telegramBotToken` — the
   * first draft of this gate flagged all six rewired consumers and the SQL of
   * the migration that moved the material. A string is not a member access.
   *
   * F2 is the exception: its token sits INSIDE the quotes by construction, so
   * blanking would erase the very thing it looks for.
   */
  readonly onLiteralBlanked: boolean
}

export function blobReadPatterns(tokens: readonly string[]): readonly BlobReadForm[] {
  return tokens.flatMap((token) => [
    // F1 — a dot access that is not a call.
    { pattern: new RegExp(`\\.${token}(?![\\w$(])`), onLiteralBlanked: true },
    // F2 — computed access.
    { pattern: new RegExp(`\\[\\s*['"\`]${token}['"\`]\\s*\\]`), onLiteralBlanked: false },
    // F3 — destructure out of some object.
    {
      pattern: new RegExp(`\\{[^}]*(?<![\\w$])${token}(?![\\w$])[^}]*\\}\\s*=`),
      onLiteralBlanked: true,
    },
  ])
}

/** The first blob-read form this source carries, with its line — or `undefined`. */
export function findBlobRead(
  text: string,
  tokens: readonly string[],
): { readonly source: string; readonly line: number } | undefined {
  const code = stripComments(text)
  const blanked = blankStringLiterals(code)
  for (const { pattern, onLiteralBlanked } of blobReadPatterns(tokens)) {
    const subject = onLiteralBlanked ? blanked : code
    if (!pattern.test(subject)) continue
    return {
      source: pattern.source,
      line: subject.split('\n').findIndex((l) => pattern.test(l)) + 1,
    }
  }
  return undefined
}

/** A read of a secret member off a settings-shaped value, outside
 *  {@link NAMED_SITES}. */
export function auditBlobReads(files: readonly SourceFile[], tokens: readonly string[]): Finding[] {
  const findings: Finding[] = []
  const allowed = new Set(NAMED_SITES.map((s) => s.file))
  for (const file of files) {
    if (allowed.has(file.rel)) continue
    const hit = findBlobRead(file.text, tokens)
    if (hit === undefined) continue
    findings.push({
      check: 'blob-secret-read',
      where: `${file.rel}:${hit.line}`,
      detail:
        `reads a secret member off a settings-shaped value (${hit.source}). The material ` +
        "lives in the server-only keyed store — `store.secrets.get('<path>')` — and a read off " +
        'the blob compiles, typechecks and silently returns an empty string. Add the file to ' +
        'NAMED_SITES with its owning issue if it is deliberate.',
    })
  }
  return findings
}

/** A named site that no longer names anything — the ratchet's other direction. */
export function auditVanishedSites(
  files: readonly SourceFile[],
  tokens: readonly string[],
): Finding[] {
  const byRel = new Map(files.map((f) => [f.rel, f]))
  const findings: Finding[] = []
  for (const site of NAMED_SITES) {
    const file = byRel.get(site.file)
    if (file === undefined) {
      findings.push({
        check: 'named-site-vanished',
        where: site.file,
        detail: `is listed in NAMED_SITES (${site.why}) but does not exist. Remove the entry.`,
      })
      continue
    }
    const names = findBlobRead(file.text, tokens) !== undefined
    if (!names) {
      findings.push({
        check: 'named-site-vanished',
        where: site.file,
        detail:
          `is listed in NAMED_SITES (${site.why}) but names no secret member any more. ` +
          'Delete the entry so the census goes DOWN — an absorbed surface must not read as ' +
          'progress on a ratchet nobody edited.',
      })
    }
  }
  return findings
}

/** Each client replica adapter must invoke the scrub in its open path. */
export const SCRUB_CALLERS: readonly string[] = [
  'packages/sync/src/adapters/indexeddb/store.ts',
  'packages/sync/src/adapters/mobile-sqlite/store.ts',
]

export function auditScrubWired(files: readonly SourceFile[]): Finding[] {
  const byRel = new Map(files.map((f) => [f.rel, f]))
  const findings: Finding[] = []
  for (const rel of SCRUB_CALLERS) {
    const file = byRel.get(rel)
    if (file === undefined) {
      findings.push({
        check: 'scrub-wired',
        where: rel,
        detail: 'adapter not found — SCRUB_CALLERS is stale, which is a finding, not a pass.',
      })
      continue
    }
    const code = stripComments(file.text)
    // A PRESENCE claim, deliberately: every other check in this gate is an
    // absence, and an absence is exactly what an unwired scrub produces.
    const declares = /private\s+(async\s+)?scrubSecrets\s*\(/.test(code)
    // ANY receiver: `store.scrubSecrets()`, `this.scrubSecrets()`, or whatever a
    // local is called. Anchoring on the variable name would fail a rename that
    // changed nothing, and a gate that cries on a refactor is a gate that gets
    // deleted. The DECLARATION check above is what keeps this honest.
    const calls = /\.scrubSecrets\s*\(\s*\)/.test(code)
    if (!declares || !calls) {
      findings.push({
        check: 'scrub-wired',
        where: rel,
        detail:
          `${declares ? 'declares' : 'does NOT declare'} scrubSecrets and ` +
          `${calls ? 'calls' : 'does NOT call'} it. A replica adapter that does not run the ` +
          'scrub at open keeps whatever an earlier build left on disk, and every runtime ' +
          'assertion made against a clean fixture still passes.',
      })
    }
  }
  return findings
}

/** The scrub must DERIVE its paths, never restate them. */
export const SCRUB_MODULE = 'packages/model/src/settings/scrub.ts'

export function auditScrubDerives(files: readonly SourceFile[]): Finding[] {
  const file = files.find((f) => f.rel === SCRUB_MODULE)
  if (file === undefined) {
    return [
      {
        check: 'scrub-derived',
        where: SCRUB_MODULE,
        detail: 'the scrub module is missing — nothing derives the secret paths.',
      },
    ]
  }
  const code = stripComments(file.text)
  const findings: Finding[] = []
  if (!code.includes("settingsPathsInTier('server-secret')")) {
    findings.push({
      check: 'scrub-derived',
      where: SCRUB_MODULE,
      detail:
        'does not derive its paths from the shipped classification. A hand-written list goes ' +
        'stale the first time a secret is added to the model, and a scrub that misses one key ' +
        'fails OPEN.',
    })
  }
  for (const path of SECRET_PATHS) {
    if (code.includes(`'${path}'`) || code.includes(`"${path}"`)) {
      findings.push({
        check: 'scrub-derived',
        where: SCRUB_MODULE,
        detail: `restates the classified path '${path}' as a literal — a second list beside the derivation.`,
      })
    }
  }
  return findings
}

export function auditClientSecrets(files: readonly SourceFile[]): Finding[] {
  const tokens = secretTokens()
  return [
    ...auditScrubWired(files),
    ...auditScrubDerives(files),
    ...auditBlobReads(files, tokens),
    ...auditVanishedSites(files, tokens),
  ]
}

// ---------------------------------------------------------------------------
// --probe: every check must find a planted defect, and pass a clean fixture
// ---------------------------------------------------------------------------

const CLEAN_ADAPTER = `
  export class Store {
    static async open(o: Options) {
      const store = new Store(o)
      await store.hydrate()
      await store.scrubSecrets()
      return store
    }
    private async scrubSecrets(): Promise<void> { /* … */ }
  }
`
const UNWIRED_ADAPTER = `
  export class Store {
    static async open(o: Options) {
      const store = new Store(o)
      await store.hydrate()
      return store
    }
    private async scrubSecrets(): Promise<void> { /* … */ }
  }
`
const CLEAN_SCRUB = `
  import { settingsPathsInTier } from './classification'
  export const SETTINGS_SECRET_PATHS = settingsPathsInTier('server-secret')
`
const RESTATED_SCRUB = `
  export const SETTINGS_SECRET_PATHS = ['apiKeys.openai', 'integrations.linearApiKey']
`
const CLEAN_CONSUMER = `
  const key = store.secrets.get('apiKeys.anthropic')
`
const BLOB_CONSUMER = `
  const key = store.settings.getSettings().apiKeys.anthropic
`
/** The syntax forms a member access can take. A detector that covered only the
 *  dotted one would pass the other three — the POD-1180 shape at token level. */
const BLOB_CONSUMER_FORMS: readonly string[] = [
  'const k = settings.apiKeys.openai',
  "const k = settings['apiKeys']['openai']",
  'const { apiKeys } = settings',
  'const k = settings.integrations.linearApiKey',
  'const k = s.notifications.telegramBotToken',
]
/** A comment must NOT trip the gate — every file in this family documents the
 *  vocabulary it is removing. */
const COMMENTED_CONSUMER = `
  // the material used to live at settings.apiKeys.openai and telegramBotToken
  /* and integrations.linearApiKey, historically */
  const key = store.secrets.get('apiKeys.anthropic')
`

function probe(): Finding[] {
  const failures: Finding[] = []
  const yes = (check: string, found: readonly Finding[], what: string): void => {
    if (found.length === 0)
      failures.push({ check, where: '<probe>', detail: `did not find the planted ${what}` })
  }
  const no = (found: readonly Finding[], what: string): void => {
    if (found.length > 0)
      failures.push({
        check: found[0]?.check ?? '?',
        where: '<probe>',
        detail: `fired on a clean fixture (${what}): ${found[0]?.detail ?? ''}`,
      })
  }

  // CHECK 0, and it runs first: an empty vocabulary makes every census below
  // report zero findings perfectly.
  if (SECRET_PATHS.length === 0) {
    failures.push({
      check: 'vocabulary',
      where: SCRUB_MODULE,
      detail:
        "settingsPathsInTier('server-secret') is EMPTY — every check in this gate would pass " +
        'vacuously against a codebase full of secrets.',
    })
    return failures
  }
  const tokens = secretTokens()
  if (!tokens.includes('apiKeys') || !tokens.includes('telegramBotToken')) {
    failures.push({
      check: 'vocabulary',
      where: '<derived>',
      detail: `token derivation produced ${JSON.stringify(tokens)} — expected the group for the provider keys and the leaf for the bot token`,
    })
  }

  const asFiles = (rel: string, text: string): SourceFile[] => [{ rel, text }]

  const everyAdapter = (text: string): SourceFile[] =>
    SCRUB_CALLERS.map((rel) => ({ rel, text }))
  no(auditScrubWired(everyAdapter(CLEAN_ADAPTER)), 'wired adapter')
  yes('scrub-wired', auditScrubWired(everyAdapter(UNWIRED_ADAPTER)), 'unwired adapter')
  // …and PER ADAPTER: one wired and one not must still be a finding, or the
  // check is satisfied by whichever adapter it happens to read first.
  yes(
    'scrub-wired',
    auditScrubWired([
      { rel: SCRUB_CALLERS[0] as string, text: CLEAN_ADAPTER },
      { rel: SCRUB_CALLERS[1] as string, text: UNWIRED_ADAPTER },
    ]),
    'one adapter unwired',
  )
  yes('scrub-wired', auditScrubWired([]), 'missing adapter')

  no(auditScrubDerives(asFiles(SCRUB_MODULE, CLEAN_SCRUB)), 'derived scrub')
  yes('scrub-derived', auditScrubDerives(asFiles(SCRUB_MODULE, RESTATED_SCRUB)), 'restated list')
  yes('scrub-derived', auditScrubDerives([]), 'missing scrub module')

  no(auditBlobReads(asFiles('apps/server/src/x.ts', CLEAN_CONSUMER), tokens), 'keyed-store read')
  no(auditBlobReads(asFiles('apps/server/src/x.ts', COMMENTED_CONSUMER), tokens), 'comment only')
  yes(
    'blob-secret-read',
    auditBlobReads(asFiles('apps/server/src/x.ts', BLOB_CONSUMER), tokens),
    'blob read',
  )
  // EVERY SYNTAX FORM, one probe each — a detector that covers one spelling of
  // the concept is a detector that passes the others.
  for (const [i, form] of BLOB_CONSUMER_FORMS.entries()) {
    yes(
      'blob-secret-read',
      auditBlobReads(asFiles('apps/server/src/x.ts', form), tokens),
      `blob read form ${i}: ${form}`,
    )
  }
  // …and a NAMED site with the same text must NOT fire, or the allowlist is
  // decorative.
  no(
    auditBlobReads(asFiles(NAMED_SITES[3]?.file as string, BLOB_CONSUMER), tokens),
    'named site',
  )

  // The ratchet's other direction.
  yes(
    'named-site-vanished',
    auditVanishedSites(asFiles(NAMED_SITES[3]?.file as string, 'const x = 1'), tokens),
    'emptied named site',
  )
  yes('named-site-vanished', auditVanishedSites([], tokens), 'deleted named site')
  no(
    auditVanishedSites(
      NAMED_SITES.map((s) => ({ rel: s.file, text: BLOB_CONSUMER })),
      tokens,
    ),
    'all sites still naming',
  )
  return failures
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const wants = (flag: string): boolean => process.argv.includes(flag)

function main(): void {
  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error(
      `client-secret audit: the INSTRUMENT is broken — ${probeFailures.length} check(s) cannot say YES.\n`,
    )
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  if (wants('--probe')) {
    console.log(
      `client secrets: all checks found their planted fixtures ` +
        `(${SECRET_PATHS.length} classified secret paths, tokens ${secretTokens().join(', ')})`,
    )
    return
  }

  const files = collectSources(['apps', 'packages'])
  const findings = auditClientSecrets(files)
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Client secrets: ${findings.length} finding(s). POD-419's claims are:\n` +
        '  · both replica adapters run the scrub in their open path\n' +
        '  · the scrub DERIVES its paths from the shipped classification, with no second list\n' +
        '  · no source outside NAMED_SITES names a secret member of the settings blob\n' +
        '  · …and every NAMED_SITE still names one, so a removal ratchets the census DOWN\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    `client secrets OK — ${SECRET_PATHS.length} classified paths, scrub wired into ` +
      `${SCRUB_CALLERS.length} adapters, ${NAMED_SITES.length} named sites remaining ` +
      `(${NAMED_SITES.filter((s) => s.why.startsWith('POD-421')).length} owned by POD-421)`,
  )
}

if (import.meta.main) main()
