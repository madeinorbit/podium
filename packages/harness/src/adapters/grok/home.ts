/**
 * GROK IN A PODIUM-MADE HOME (managed installs §4.3 to §4.7, POD-7370).
 *
 * `GROK_HOME` moves Grok's whole user folder: `auth.json`, `config.toml`,
 * logs, hooks and the session store (POD-7267). The user layer Grok reads
 * from it (Grok's own file-locations table, 1.0.89): `config.toml`, the
 * global rules file, and the `skills/`, `agents/` and `plugins/` folders.
 *
 * Grok also accepts `AGENT.md`, `Agents.md` and `Claude.md` as the global
 * rules file. Only `AGENTS.md` is shared and copied: on a case-insensitive
 * disk `Agents.md` and `AGENTS.md` are one file, and a link for each would be
 * replaced at every launch.
 *
 * Grok also reads Claude Code's user folder from `HOME` (`~/.claude/skills`,
 * `agents`, `plugins`, `~/.claude.json` servers) with no documented switch.
 * `GROK_HOME` does not move those, so a Grok in a Podium home still reads
 * them. It does not write there.
 */

/**
 * What a second Grok login shares with its source folder. Measured on 1.0.89
 * (POD-7370): Grok writes its first-start keys into a linked `config.toml`
 * through the link and leaves the link in place.
 */
export const grokHomeSharing = [
  'grok',
  ['config.toml', 'AGENTS.md', 'skills', 'agents', 'plugins'],
] as const

/**
 * What filling the Podium home copies from the person's Grok folder
 * (managed installs §4.5): the global rules, skills, agents and plugins, and
 * of `config.toml` only its `[mcp_servers.*]` tables. Never the login,
 * permissions, hooks, folder trust, update settings, memory or sessions.
 */
export const grokPodiumHomeFill = [
  'grok',
  { entries: ['AGENTS.md', 'skills', 'agents', 'plugins'], configTables: ['mcp_servers'] },
] as const
