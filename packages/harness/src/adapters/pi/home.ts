/**
 * PI IN A PODIUM-MADE HOME (managed installs §4.3 to §4.7, POD-7372).
 *
 * `PI_CODING_AGENT_DIR` moves Pi's whole agent folder: `auth.json`,
 * `settings.json`, the model store and the sessions (POD-7267). What Pi 1.5
 * reads from that folder as the person's own setup (its resource loader):
 * `settings.json`, `models.json` (custom providers and models), `mcp.json`
 * (MCP servers), `keybindings.json`, the global rules (`AGENTS.md`,
 * `SYSTEM.md`, `APPEND_SYSTEM.md`), the `skills/`, `prompts/`, `extensions/`
 * and `themes/` folders, and the packages `pi install` put under `npm/` and
 * `git/` for the `packages` that `settings.json` lists.
 *
 * The folder's own, never shared or copied: `auth.json` (the login),
 * `trust.json` (folder trust decisions), `mcp-auth.json` (MCP server
 * sign-ins), `models-store.json` (model state), `sessions/`, and the `bin/`
 * tools Pi downloads.
 *
 * Pi also accepts `AGENTS.override.md`, `AGENTS.MD` and `CLAUDE.md` as the
 * global rules file. Only `AGENTS.md` is shared and copied: on a
 * case-insensitive disk `AGENTS.MD` and `AGENTS.md` are one file, and a link
 * for each would be replaced at every launch.
 *
 * Pi also reads `~/.agents/skills` from `HOME`, with no switch. A Pi in a
 * Podium home still reads it. It does not write there.
 */

/**
 * What a Pi sign-in folder would share with its source folder. Pi has no
 * sign-in folders yet (no login credential type; see the adapter's
 * `accepts`), so only the Podium home exists; the list is declared because
 * every home harness declares one. Pi 1.5 writes `settings.json`,
 * `trust.json` and `auth.json` in place (`writeFileSync` on the path, under a
 * lock file beside it), so a write follows a link and leaves it a link.
 */
export const piHomeSharing = [
  'pi',
  [
    'settings.json',
    'models.json',
    'mcp.json',
    'keybindings.json',
    'AGENTS.md',
    'SYSTEM.md',
    'APPEND_SYSTEM.md',
    'skills',
    'prompts',
    'extensions',
    'themes',
    'npm',
    'git',
  ],
] as const

/**
 * What filling the Podium home copies from the person's Pi folder (managed
 * installs §4.5): the global rules, skills, prompt templates, extensions and
 * themes, and of `mcp.json` only its `mcpServers`, merged into the home's.
 * Never the login, folder trust, MCP sign-ins, model state or sessions. Never
 * `settings.json`: it holds the folder-trust default (`defaultProjectTrust`),
 * update and telemetry settings and Pi's device id, and its package paths
 * name the person's folder. Never `models.json`: a custom provider there can
 * hold an API key. Posture supplies trust (`--approve`) at launch.
 */
export const piPodiumHomeFill = [
  'pi',
  {
    entries: [
      'AGENTS.md',
      'SYSTEM.md',
      'APPEND_SYSTEM.md',
      'skills',
      'prompts',
      'extensions',
      'themes',
    ],
    serversFile: 'mcp.json',
  },
] as const
