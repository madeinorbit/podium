# Driving the operator instance headlessly (POD-1761)

A UX claim on this epic is proven by driving the product, not by a green suite. This is the
harness the coordinator used to reproduce POD-2600 (codex dead on its first turn) in about
ninety seconds, after a whole night of green reviews had missed it.

It logs into the running operator instance, starts a real session of a chosen agent family,
sends `hello`, and screenshots the result.

## What it needs

- **Chromium**: `playwright install` REFUSES this OS. Use the cached build directly and
  preload the sound library it dies without:

  ```sh
  apt-get download libasound2t64          # outside the repo
  dpkg-deb -x libasound2t64_*.deb ~/.t<issue>/libs
  export LD_LIBRARY_PATH=~/.t<issue>/libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
  ```

  Launch with an explicit `executablePath`:
  `~/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`

- **The instance**: `http://100.110.195.114:19797`, password `operator`.

## The traps that cost real time

- **`Enter` does not submit the composer.** There is a `Launch` button; the shortcut is
  ⌘↵. Pressing Enter leaves the text sitting there and you screenshot a lie.
- **Scope your assertions to the session pane.** `document.body.innerText` includes the
  SIDEBAR, which carries *other* sessions' error text — it will report a failure that is
  not yours. Read the pane right of x≈340, or `.xterm-rows` for the terminal view.
- **The agent picker is matched by EXACT text.** Sidebar rows contain family names inside
  longer labels, so `:has-text("Codex")` matches a session row; filter on
  `/^(Claude Code|Codex|OpenCode|Grok)$/`.
- **There is no `<main>` element.** Scoping by it silently matches nothing.
- **An update dialog can cover the composer and swallow clicks** (POD-2572) — dismiss it
  via the `Hide` button before interacting.
- **The terminal view crashed headless chromium** in one run. Terminal rendering uses
  canvas/webgl and this box has no GPU, so suspect the harness before the product.

## Counting what a human would see

Frame counts and byte counts cannot tell an empty screen from a full one. POD-2434's
"proof" was 239 bytes of real terminal traffic that decoded to an *empty* alt screen —
accepted, then overturned by a reviewer who stripped the control sequences and counted
**printable characters**. Do that:

```js
const text = await page.evaluate(() => (document.querySelector('.xterm-rows') ?? document.body).innerText)
const printable = text.replace(/\s+/g, '').length
```

## The script

The working copy lives at `~/.t1761/drive3.mjs` with its wrapper `~/.t1761/drive.sh`:

```sh
bash ~/.t1761/drive.sh ~/.t1761/drive3.mjs Codex        # or OpenCode | Grok | "Claude Code"
```

It logs in, dismisses the update dialog, picks the family, types `hello`, clicks `Launch`,
then screenshots at three intervals and reports any error text found in the session pane.
Screenshots land in `~/.t1761/drive-<Family>-0N.png`. Attach the useful ones to your issue
with `podium issue artifact <id> --add <path>` — the artifact path must be inside a
worktree, not a scratch directory.
