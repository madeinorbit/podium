/**
 * A SHA AS GIT SHOULD READ IT: PEELED TO ITS COMMIT.
 *
 * The publisher names commits by their 7-character short form, which is also
 * the build's identity in versions and state. Git resolves a bare short SHA
 * against EVERY object, so once another object (a tree, a blob) shares the
 * prefix, `git diff <short>` and `git show <short>:path` fail with "short object
 * ID … is ambiguous". On 2026-11-23 commit eed4495c49 shared its prefix with
 * tree eed44957f2, the proposal read failed, and the Update offer vanished.
 * `<sha>^{commit}` tells git that only a commit is meant, which settles that
 * ambiguity for any SHA length, so every git call that takes a SHA goes
 * through here.
 */
export function commitRev(sha: string): string {
  return `${sha.trim()}^{commit}`
}
