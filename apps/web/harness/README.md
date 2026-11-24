# Isolated browser fixtures

Run browser checks on an assigned agent VM with that lane's runner, using a committed
checkout. No installed Podium server or daemon is needed for these fixtures.

```sh
bun run test:harness-startup
```

This focused check starts the Settings and flight deck Vite configs in turn, uses the
Chromium revision installed for the checkout's Playwright version, and closes both the
browser and servers. Each config gets a fresh dependency cache. The Settings check opens
Appearance, selects Machines through the settings navigation, and verifies the populated
machine list. The deck check waits for the real mission header. Screenshots and request,
console, and page-error diagnostics go to `.artifacts/harness-startup/`; pass an output
directory after `--` to change it.

For an interactive fixture, start Vite from `apps/web` with the matching config:

| Screen | Config | URL |
| --- | --- | --- |
| Settings → Machines | `vite.settings-frame-harness.config.ts` | `http://127.0.0.1:55652/harness/settings-frame.html?page=machines&populated` |
| Flight deck | `vite.deck-harness.config.ts` | `http://127.0.0.1:55601/harness/deck.html` |

The settings URL accepts `theme=light` and `as=member`. The deck exposes
`window.deck.setMission(name)`, `setWidth(px)`, and `setTheme('light' | 'dark')`;
`deck-entry.tsx` names its missions. With its Vite server running, `bun
harness/deck-shots.ts <output-directory>` captures the `filters` and `asking` missions.

Each specialized config scans only its own HTML entry. The general
`vite.harness.config.ts` discovers dependencies from the page being opened. Scanning all
HTML under `apps/web` also visits unrelated mobile fixtures, which pull React Native Flow
sources into Vite's web dependency optimizer and can leave the page waiting for imports
without a browser exception. Keep a new fixture's dependency scan scoped to its entry.
