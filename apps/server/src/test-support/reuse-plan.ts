/**
 * Which files in a @podium/server cache shard may share one Vitest runner [POD-527].
 *
 * POD-520 split the lane by *import closure*: `contracts` holds the 70 files that reach
 * neither `src/store` nor `src/composition`/`src/application`. That answers "which source
 * does this test consume", which is the right question for a cache key and the wrong one
 * for runner reuse. A file with a spotless closure can still call `vi.useFakeTimers()` and
 * never restore the clock, and under a shared runner the next file in that process inherits
 * it. Pure closure is not reuse safety, so this module asks the other question.
 *
 * The installed Vitest (5.0.0-beta.6) reuses a completed runner only when `task.isolate`
 * is false, and when it is, the worker loop SKIPS the two resets it otherwise does between
 * files — `moduleRunner.mocker.reset()` and `resetModules(evaluatedModules)`. What it still
 * does per file is `vi.resetConfig()`, `vi.restoreAllMocks()`, and — the one that makes any
 * of this workable — an explicit `invalidateModule` on every setup file before re-importing
 * it, so setup side effects still run once per test file.
 *
 * That asymmetry is the whole rule below. Anything vitest itself undoes between files is
 * allowed; anything it does not undo is disqualifying, because it survives into the next
 * file's world:
 *
 * | construct                        | undone between files? |
 * | -------------------------------- | --------------------- |
 * | `vi.spyOn`                       | yes — `vi.restoreAllMocks()` |
 * | `vi.setConfig`                   | yes — `vi.resetConfig()` |
 * | `vi.mock` / `vi.doMock`          | NO — mocker reset is skipped |
 * | module registry state            | NO — `resetModules` is skipped |
 * | `vi.useFakeTimers`               | NO |
 * | `vi.stubEnv` / `vi.stubGlobal`   | NO |
 * | `process.env` writes             | NO |
 * | `globalThis.x = …`               | NO |
 * | `process.on` / `chdir` / `exit`  | NO |
 *
 * The scan is deliberately syntactic and deliberately over-broad: it disqualifies a file
 * that saves and restores `process.env.FOO` correctly, because "it restores correctly" is a
 * reading of the code and this has to hold without one. A disqualified file is not dropped
 * — it runs in the same shard, in the isolated project, exactly as it does today. The only
 * thing it loses is the shared process.
 *
 * The scan is also not the safety argument on its own. It cannot see a module-scoped cache
 * inside the *source* a test imports, and it never will. `test-hermetic-reuse-guard.ts` is
 * the other half: it observes the real process after every reused file and fails the file
 * that actually leaked. This module narrows the population; that one refuses the rest.
 *
 * Membership is derived, never listed. Add `vi.useFakeTimers()` to a reusable file and it
 * demotes itself to the isolated project on the next run, with no manifest to regenerate —
 * which is the direction that has to be automatic.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Disqualifier {
  /** Stable name, used in failure output and in the guard test. */
  id: string
  pattern: RegExp
  /** Why a shared runner cannot survive it — printed when a file is demoted. */
  reason: string
}

/**
 * Constructs that outlive a test file in a shared runner.
 *
 * Every pattern here is global (`g`) and matched against raw source, so a construct inside
 * a comment or a string counts. That is the intended bias: a false demotion costs one file
 * its share of a process, a false promotion costs the lane its determinism.
 */
export const DISQUALIFIERS: readonly Disqualifier[] = [
  {
    id: 'env-write',
    pattern: /process\.env\.[A-Za-z_$][\w$]*\s*=(?!=)|process\.env\[[^\]]*\]\s*=(?!=)/g,
    reason: 'writes process.env, which the next file in the runner inherits',
  },
  {
    id: 'env-delete',
    pattern: /delete\s+process\.env/g,
    reason: 'deletes a process.env key, which the next file in the runner inherits',
  },
  {
    id: 'env-replace',
    pattern: /process\.env\s*=(?!=)/g,
    reason: 'replaces process.env wholesale',
  },
  {
    id: 'stub-env',
    pattern: /vi\.stubEnv\b/g,
    reason: 'vi.stubEnv is undone by vi.unstubAllEnvs, which vitest does not call per file',
  },
  {
    id: 'stub-global',
    pattern: /vi\.stubGlobal\b/g,
    reason: 'vi.stubGlobal is undone by vi.unstubAllGlobals, which vitest does not call per file',
  },
  {
    id: 'fake-timers',
    pattern: /vi\.useFakeTimers\b|vi\.setSystemTime\b|vi\.advanceTimers/g,
    reason: 'a faked clock is never restored between files',
  },
  {
    id: 'module-mock',
    pattern: /\bvi\.(?:mock|doMock|unmock|doUnmock|mocked)\s*\(/g,
    reason: 'the module mocker is not reset between files when isolation is off',
  },
  {
    id: 'reset-modules',
    pattern: /vi\.resetModules\b/g,
    reason: 'resets a module registry that is shared with every other file in the runner',
  },
  {
    id: 'global-write',
    pattern: /(?:globalThis|(?<![.\w])global)\.[A-Za-z_$][\w$]*\s*=(?!=)/g,
    reason: 'assigns a global that the next file in the runner sees',
  },
  {
    id: 'process-listener',
    pattern: /process\.(?:on|once|off|removeAllListeners|setMaxListeners)\s*\(/g,
    reason: 'process listeners accumulate across files in one runner',
  },
  {
    id: 'process-chdir',
    pattern: /process\.chdir\s*\(/g,
    reason: 'the working directory is process-wide and is not restored between files',
  },
  {
    id: 'process-exit',
    pattern: /process\.exit\s*\(/g,
    reason: 'ends the runner, taking every file queued behind it with it',
  },
  {
    id: 'process-argv',
    pattern: /process\.(?:argv|execArgv)\s*(?:=(?!=)|\.(?:push|splice|pop|shift|unshift)\s*\()/g,
    reason: 'mutates process argv, which is process-wide',
  },
  {
    id: 'require-cache',
    pattern: /require\.cache/g,
    reason: 'edits a module cache shared with every other file in the runner',
  },
]

export interface ReuseVerdict {
  file: string
  reusable: boolean
  /** Disqualifier ids that matched, sorted. Empty when the file is reusable. */
  disqualifiers: string[]
}

/** The disqualifier ids present in one test file's source, sorted. */
export function disqualifiersIn(source: string): string[] {
  return DISQUALIFIERS.filter((rule) => {
    // Global regexes carry lastIndex across calls; `test` would then skip matches on the
    // next file. Reset rather than allocate a new RegExp per file per rule.
    rule.pattern.lastIndex = 0
    return rule.pattern.test(source)
  })
    .map((rule) => rule.id)
    .sort()
}

/** Why a file was demoted, in the words of the rules that demoted it. */
export function reasonsFor(disqualifiers: readonly string[]): string[] {
  return DISQUALIFIERS.filter((rule) => disqualifiers.includes(rule.id)).map(
    (rule) => `${rule.id}: ${rule.reason}`,
  )
}

/** Classify one shard's test files. `files` are repo-relative, as the manifest stores them. */
export function classifyForReuse(files: readonly string[], root: string): ReuseVerdict[] {
  return files.map((file) => {
    const disqualifiers = disqualifiersIn(readFileSync(join(root, file), 'utf8'))
    return { file, reusable: disqualifiers.length === 0, disqualifiers }
  })
}

export interface ReuseSplit {
  /** Files that may share a runner, sorted as the manifest sorts them. */
  reusable: string[]
  /** Files that keep a fork of their own, sorted. */
  isolated: string[]
}

export function splitForReuse(files: readonly string[], root: string): ReuseSplit {
  const verdicts = classifyForReuse(files, root)
  return {
    reusable: verdicts.filter((v) => v.reusable).map((v) => v.file),
    isolated: verdicts.filter((v) => !v.reusable).map((v) => v.file),
  }
}

/**
 * The shards allowed to run part of their files in a shared runner.
 *
 * One entry, and it is the narrow start POD-515 asked for. `store`, `services` and
 * `boundary` compose the application, hold singletons and open SQLite; `normalized-wire`
 * measures operation counts under load and is serialized on purpose. None of them may reuse
 * a runner until a mutation run and an order-randomized run say otherwise, so the gate is a
 * list of shard ids rather than a property of the file scan — a new shard does not opt
 * itself in by being clean.
 */
export const REUSE_ENABLED_SHARDS: readonly string[] = ['contracts']

export const shardMayReuse = (shardId: string): boolean => REUSE_ENABLED_SHARDS.includes(shardId)
