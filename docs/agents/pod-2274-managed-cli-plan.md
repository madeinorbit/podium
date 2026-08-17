# Managed CLI availability plan

Source contract: [spec:SP-d6e8]. This plan follows the reviewed macOS desktop scope: every
interactive harness, headless harness, and Podium shell started by the local desktop backend
receives the exact bundled `podium` command ahead of user PATH entries. It does not install a
command into the user's terminal environment.

## Review decisions incorporated

- Use one daemon environment builder for interactive and headless launches.
- Apply the Podium CLI entry even when the session has no `HOME` override.
- Keep the Podium-owned path above account, harness, recovered-machine, and user PATH entries.
- Protect the exact CLI path from session or harness environment overrides.
- Keep the bundled executable inside the signed macOS app.

The broader reviewer suggestions—Linux/AppImage command aliases, a user-facing CLI installer,
and defending against arbitrary login profiles that replace PATH after a harness starts—are not
part of the reported macOS desktop defect or the agreed implementation. They require separate
distribution or shell-integration decisions.

## Implementation

1. **Desktop supplies the source of truth.**
   - Add a `PODIUM_CLI_PATH` internal environment binding in
     `apps/desktop/src-tauri/src/main.rs`.
   - Set it to the exact `runnable` path for the initial local backend, replacement daemon, and
     every respawn path by putting it in both shared command constructors.
   - Extend the existing Rust command-construction test to prove both constructors carry the
     exact path.

2. **One daemon helper owns the managed environment.**
   - Extend `spawnEnv` in `apps/daemon/src/control/session.ts` so the daemon's own
     `PODIUM_CLI_PATH` wins all collisions.
   - Prepend its directory before the existing user harness directories and inherited PATH.
   - Build PATH when a managed CLI exists even if `HOME` is absent; preserve the current no-op
     behavior when neither input exists.
   - Reference [spec:SP-d6e8] at this implementing boundary.

3. **Headless launches use the same helper.**
   - Replace the inline environment object in `apps/daemon/src/control/headless.ts` with a
     `spawnEnv` call.
   - Preserve the existing relay identity and isolated account-home precedence.
   - Leave harness manifests and adapters unchanged.

4. **Focused proof, then one repository gate.**
   - Extend `session-env.test.ts` to prove the desktop binding works without `HOME`, wins
     collisions, is first in PATH, and is deduplicated.
   - Keep the existing desktop command-construction test as the native-boundary proof.
   - Run the normal `bun run test` gate, followed by the dedicated `bun run test:rust` lane
     because the desktop command constructors and their Rust test changed.
