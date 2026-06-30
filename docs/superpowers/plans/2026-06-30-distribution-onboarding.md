# Distribution & One-Paste Machine Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make standing up a Podium instance and adding a machine copy-paste operations, distributed via GitHub, reachable over Tailscale, with self-update for both the headless and desktop builds and a setup flow usable from web or CLI.

**Architecture:** A GitHub-hosted `install.sh` downloads a signature-verified binary bundle (plain mode → run `podium`; `--join <token>` mode → configures + starts a daemon). A UI-agnostic setup core drives both a web GUI and a `podium setup` CLI; its networking step captures the instance's public URL (Tailscale-first), which join tokens embed. A Blacksmith GitHub Actions workflow builds + signs + publishes both the headless tarball (Ed25519) and the desktop Tauri bundle (minisign) to `stable`/`edge` release channels; both updaters read static per-channel manifests from those releases.

**Tech Stack:** Bun (runtime/bundler), TypeScript ESM, zod, vitest, Biome, POSIX sh, systemd `--user` units, GitHub Actions on Blacksmith runners, Tauri (desktop).

## Global Constraints

- **Release repo:** `madeinorbit/podium`. All download URLs are under `https://github.com/madeinorbit/podium/releases`.
- **Runtime/tooling:** Bun ≥ 1.3; TypeScript ESM-only; tests with **vitest**; lint/format with **Biome**; shell verified with **shellcheck**.
- **Artifacts: `linux-x64` only** for now (headless *and* desktop). arm64/macOS/Windows slots stay empty in the release matrix.
- **Two signing systems, separate keypairs:** headless = raw **Ed25519** (private `PODIUM_UPDATE_SIGNING_KEY` at build, public in `scripts/podium-update-pubkey.ts`); desktop = **minisign** (private `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, public in `apps/desktop/src-tauri/tauri.conf.json` `updater.pubkey`). Both private keys are CI-only secrets; both public keys are committed.
- **Channels:** `stable` (GitHub "latest" release, tag `vX.Y.Z`) and `edge` (rolling prerelease tagged `edge`, rebuilt on every push to `main`). **Desktop builds on `stable` only.**
- **Version is single-sourced** from root `package.json` `"version"`.
- **User-facing surface:** users only ever copy the `curl … | sh` line (optionally `--join <TOKEN>` / `--channel edge`). Never surface `--server`, `--pair`, or the words `daemon`/`server` in any user-facing string.
- **Podium terminates no TLS**; Tailscale Serve/Funnel / cloudflared / a reverse proxy owns it. Setup is **guide + copy-paste** — never auto-run a tunnel.
- **Config** lives at `$PODIUM_STATE_DIR/config.json` (default `~/.podium/config.json`), via `packages/core/src/config.ts`.
- **Commit after every green step.** TDD: failing test → run (see it fail) → minimal impl → run (see it pass) → commit.

Spec: `docs/superpowers/specs/2026-06-30-distribution-onboarding-design.md` (issue podium-4ny).

---

### Task 1: Join token codec

**Files:**
- Create: `packages/core/src/join.ts`
- Test: `packages/core/src/join.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `JoinPayload` (zod schema) and `type JoinPayload`
  - `encodeJoin(p: JoinPayload): string` — base64url(JSON), no padding
  - `decodeJoin(token: string): JoinPayload` — throws `Error` on malformed/invalid

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/join.test.ts
import { describe, expect, it } from 'vitest'
import { decodeJoin, encodeJoin, type JoinPayload } from './join'

const sample: JoinPayload = {
  v: 1,
  serverUrl: 'wss://box.tail1234.ts.net',
  pairCode: 'AB12-CD34',
  name: 'vps-box',
}

describe('join token codec', () => {
  it('round-trips a payload', () => {
    expect(decodeJoin(encodeJoin(sample))).toEqual(sample)
  })
  it('produces a URL-safe token with no padding', () => {
    const t = encodeJoin(sample)
    expect(t).not.toMatch(/[+/=]/)
  })
  it('round-trips without the optional name', () => {
    const p: JoinPayload = { v: 1, serverUrl: 'ws://h:18787', pairCode: 'X1' }
    expect(decodeJoin(encodeJoin(p))).toEqual(p)
  })
  it('rejects a non-base64url / garbage token', () => {
    expect(() => decodeJoin('!!!not a token!!!')).toThrow()
  })
  it('rejects a token whose JSON fails schema (wrong version)', () => {
    const bad = Buffer.from(JSON.stringify({ v: 2, serverUrl: 'x', pairCode: 'y' }))
      .toString('base64url')
    expect(() => decodeJoin(bad)).toThrow()
  })
  it('rejects a token missing required fields', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, serverUrl: 'x' })).toString('base64url')
    expect(() => decodeJoin(bad)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run packages/core/src/join.test.ts`
Expected: FAIL — `Cannot find module './join'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/join.ts
import { z } from 'zod'

/** One-paste machine-join payload. base64url-encoded into the `--join <TOKEN>` arg. */
export const JoinPayload = z.object({
  v: z.literal(1),
  /** ws:// or wss:// relay URL the daemon dials (the instance's publicUrl, ws-ified). */
  serverUrl: z.string().min(1),
  /** Single-use, server-minted pairing code (~10 min TTL). */
  pairCode: z.string().min(1),
  /** Optional display name for the new machine. */
  name: z.string().optional(),
})
export type JoinPayload = z.infer<typeof JoinPayload>

export function encodeJoin(p: JoinPayload): string {
  return Buffer.from(JSON.stringify(JoinPayload.parse(p))).toString('base64url')
}

/** Decode + validate. Throws on malformed base64url, bad JSON, or schema mismatch. */
export function decodeJoin(token: string): JoinPayload {
  let json: string
  try {
    json = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    throw new Error('invalid join token (not base64url)')
  }
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    throw new Error('invalid join token (not JSON)')
  }
  return JoinPayload.parse(obj)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run packages/core/src/join.test.ts`
Expected: PASS (6 tests).
Note: `Buffer.from('!!!','base64url')` does not throw — but the resulting bytes fail `JSON.parse`, so the garbage-token test still throws via the JSON branch. Keep the test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/join.ts packages/core/src/join.test.ts
git commit -m "feat(core): join token codec (encodeJoin/decodeJoin) [podium-4ny]"
```

---

### Task 2: Config schema extensions

**Files:**
- Modify: `packages/core/src/config.ts` (the `PodiumConfig` object, ~line 12-20)
- Test: `packages/core/src/config.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `PodiumConfig`, `saveConfig`, `loadConfig`.
- Produces: `PodiumConfig` gains optional `updateChannel: 'stable'|'edge'` and `publicUrl: string`.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe`)

```ts
  it('round-trips updateChannel and publicUrl', () => {
    saveConfig({ mode: 'all-in-one', updateChannel: 'edge', publicUrl: 'https://b.ts.net' })
    expect(loadConfig()).toEqual({
      mode: 'all-in-one',
      updateChannel: 'edge',
      publicUrl: 'https://b.ts.net',
    })
  })
  it('loads an old config without the new fields', () => {
    saveConfig({ mode: 'server' })
    expect(loadConfig()).toEqual({ mode: 'server' })
  })
  it('rejects an invalid updateChannel', () => {
    expect(() => saveConfig({ updateChannel: 'nightly' } as never)).toThrow()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run packages/core/src/config.test.ts`
Expected: FAIL — invalid-channel case does not throw / round-trip drops unknown keys (zod strips them).

- [ ] **Step 3: Write minimal implementation** — add two fields to `PodiumConfig`:

```ts
export const PodiumConfig = z.object({
  mode: PodiumMode.optional(),
  serverUrl: z.string().optional(),
  port: z.number().int().positive().optional(),
  pairCode: z.string().optional(),
  updateFeed: z.string().optional(),
  /** Self-update channel for the headless build (desktop is always stable). Default 'stable'. */
  updateChannel: z.enum(['stable', 'edge']).optional(),
  /** Externally-reachable base URL captured at setup; embedded into machine join tokens. */
  publicUrl: z.string().optional(),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run packages/core/src/config.test.ts`
Expected: PASS (all, including the 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(core): config gains updateChannel + publicUrl [podium-4ny]"
```

---

### Task 3: Setup core (UI-agnostic)

**Files:**
- Create: `packages/core/src/setup.ts`
- Test: `packages/core/src/setup.test.ts`

**Interfaces:**
- Consumes: `saveConfig`, `PodiumConfig` from `./config`.
- Produces:
  - `type NetworkOption = 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual'`
  - `NETWORK_OPTIONS: { id: NetworkOption; label: string; note: string }[]`
  - `networkOptionCommand(opt, port): { command: string; hint: string }`
  - `validatePublicUrl(url): { ok: true; normalized: string } | { ok: false; error: string }`
  - `wssFrom(publicUrl): string` — http(s)→ws(s) base for daemon dialing
  - `applySetup(input: { publicUrl: string }): PodiumConfig` — persists `mode:'all-in-one'` + `publicUrl`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/setup.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import { applySetup, networkOptionCommand, validatePublicUrl, wssFrom } from './setup'

describe('setup core', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('funnel command includes the port', () => {
    expect(networkOptionCommand('tailscale-funnel', 18787).command).toBe('tailscale funnel 18787')
  })
  it('cloudflare command targets localhost:port', () => {
    expect(networkOptionCommand('cloudflare-tunnel', 18787).command).toBe(
      'cloudflared tunnel --url http://localhost:18787',
    )
  })
  it('validatePublicUrl accepts https and strips a trailing slash', () => {
    expect(validatePublicUrl('https://box.ts.net/')).toEqual({
      ok: true,
      normalized: 'https://box.ts.net',
    })
  })
  it('validatePublicUrl rejects a non-http(s) url', () => {
    expect(validatePublicUrl('ftp://x').ok).toBe(false)
    expect(validatePublicUrl('not a url').ok).toBe(false)
  })
  it('wssFrom converts https→wss and http→ws', () => {
    expect(wssFrom('https://box.ts.net')).toBe('wss://box.ts.net')
    expect(wssFrom('http://10.0.0.1:18787')).toBe('ws://10.0.0.1:18787')
  })
  it('applySetup persists mode + publicUrl', () => {
    applySetup({ publicUrl: 'https://box.ts.net' })
    expect(loadConfig()).toEqual({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run packages/core/src/setup.test.ts`
Expected: FAIL — `Cannot find module './setup'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/setup.ts
import { loadConfig, type PodiumConfig, saveConfig } from './config'

export type NetworkOption =
  | 'tailscale-funnel'
  | 'tailscale-serve'
  | 'cloudflare-tunnel'
  | 'manual'

export const NETWORK_OPTIONS: { id: NetworkOption; label: string; note: string }[] = [
  {
    id: 'tailscale-funnel',
    label: 'Tailscale Funnel (public, recommended)',
    note: 'Real cert, reachable from anywhere, no domain. Funnel uses ports 443/8443/10000 and must be enabled in your tailnet ACL.',
  },
  {
    id: 'tailscale-serve',
    label: 'Tailscale Serve (private)',
    note: 'Reachable only from devices on your tailnet.',
  },
  {
    id: 'cloudflare-tunnel',
    label: 'Cloudflare quick tunnel (no Tailscale)',
    note: 'Instant public URL, no account. The URL changes on every restart — demo-grade.',
  },
  { id: 'manual', label: 'Manual reverse proxy', note: 'Caddy/nginx/etc. — paste the https URL.' },
]

export function networkOptionCommand(opt: NetworkOption, port: number): { command: string; hint: string } {
  switch (opt) {
    case 'tailscale-funnel':
      return {
        command: `tailscale funnel ${port}`,
        hint: 'Then paste the https://<host>.<tailnet>.ts.net URL it prints.',
      }
    case 'tailscale-serve':
      return {
        command: `tailscale serve ${port}`,
        hint: 'Then paste the https://<host>.<tailnet>.ts.net URL it prints.',
      }
    case 'cloudflare-tunnel':
      return {
        command: `cloudflared tunnel --url http://localhost:${port}`,
        hint: 'Then paste the https://<random>.trycloudflare.com URL it prints.',
      }
    case 'manual':
      return { command: '', hint: 'Paste the https:// URL your reverse proxy serves.' }
  }
}

export function validatePublicUrl(
  url: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return { ok: false, error: 'Not a valid URL.' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'URL must start with http:// or https://.' }
  }
  return { ok: true, normalized: u.toString().replace(/\/$/, '') }
}

export function wssFrom(publicUrl: string): string {
  return publicUrl.replace(/^http(s?):\/\//, (_m, s) => (s ? 'wss://' : 'ws://')).replace(/\/$/, '')
}

export function applySetup(input: { publicUrl: string }): PodiumConfig {
  const cfg: PodiumConfig = { ...loadConfig(), mode: 'all-in-one', publicUrl: input.publicUrl }
  saveConfig(cfg)
  return cfg
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run packages/core/src/setup.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/setup.ts packages/core/src/setup.test.ts
git commit -m "feat(core): UI-agnostic setup core (network options, validation, applySetup) [podium-4ny]"
```

---

### Task 4: `podium join-config <TOKEN>` subcommand

**Files:**
- Modify: `scripts/cli.ts` (add an early `join-config` branch in `main`, after the `update` branch ~line 62)
- Create: `scripts/cli-join.ts` (testable helper)
- Test: `scripts/cli-join.test.ts`

**Interfaces:**
- Consumes: `decodeJoin` (Task 1), `saveConfig` (`packages/core/src/config`).
- Produces: `applyJoinToken(token: string): { name: string }` — writes daemon config, returns resolved name.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/cli-join.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/core/src/config'
import { encodeJoin } from '../packages/core/src/join'
import { applyJoinToken } from './cli-join'

describe('applyJoinToken', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-join-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a daemon config from a valid token', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1', name: 'vps' })
    expect(applyJoinToken(token)).toEqual({ name: 'vps' })
    expect(loadConfig()).toEqual({
      mode: 'daemon',
      serverUrl: 'wss://h',
      pairCode: 'P1',
    })
  })
  it('falls back to "this machine" when the token has no name', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1' })
    expect(applyJoinToken(token).name).toBe('this machine')
  })
  it('throws on a malformed token', () => {
    expect(() => applyJoinToken('garbage!')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run scripts/cli-join.test.ts`
Expected: FAIL — `Cannot find module './cli-join'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/cli-join.ts
import { saveConfig } from '../packages/core/src/config'
import { decodeJoin } from '../packages/core/src/join'

/** Decode a join token and persist a daemon config. Returns the resolved machine name. */
export function applyJoinToken(token: string): { name: string } {
  const p = decodeJoin(token)
  saveConfig({ mode: 'daemon', serverUrl: p.serverUrl, pairCode: p.pairCode })
  return { name: p.name ?? 'this machine' }
}
```

Then wire it into `scripts/cli.ts` `main()`, immediately after the `update` branch:

```ts
  // `podium join-config <TOKEN>`: non-interactive daemon configuration from a join token
  // (used by `install.sh --join`). Writes config + exits; the daemon is started separately.
  if (argv[0] === 'join-config') {
    const token = argv[1]
    if (!token) {
      console.error('usage: podium join-config <TOKEN>')
      process.exit(2)
    }
    const { applyJoinToken } = await import('./cli-join')
    try {
      const { name } = applyJoinToken(token)
      console.log(`podium configured to join as "${name}"`)
    } catch (e) {
      console.error(`invalid join token: ${(e as Error).message}`)
      process.exit(2)
    }
    return
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run scripts/cli-join.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Smoke the CLI branch**

Run: `PODIUM_STATE_DIR=$(mktemp -d) bun --conditions=@podium/source scripts/cli.ts join-config "$(bun -e 'import("./packages/core/src/join").then(m=>console.log(m.encodeJoin({v:1,serverUrl:"wss://h",pairCode:"P1",name:"vps"})))')"`
Expected: prints `podium configured to join as "vps"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/cli-join.ts scripts/cli-join.test.ts scripts/cli.ts
git commit -m "feat(cli): podium join-config <TOKEN> writes daemon config from a join token [podium-4ny]"
```

---

### Task 5: `install.sh`

**Files:**
- Create: `install.sh` (repo root)
- Create: `scripts/install-sh.test.sh` (fixture harness, bash)

**Interfaces:**
- Consumes: a release layout — `podium-headless-linux-x64.tar.gz` (+ `.sig`) extracting to a `headless/` dir containing a `podium` launcher; the Ed25519 pubkey constant.
- Produces: an installed bundle at `~/.local/share/podium/` + `~/.local/bin/podium` symlink; in `--join` mode also `~/.podium/config.json` + an enabled `podium-daemon` user unit.

- [ ] **Step 1: Write the failing test (fixture harness)**

```bash
#!/usr/bin/env bash
# scripts/install-sh.test.sh — runs install.sh against a local fixture "release".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export PODIUM_STATE_DIR="$HOME/.podium"

# --- build a fake signed release into $WORK/release ---
REL="$WORK/release"; mkdir -p "$REL/headless"
printf '#!/bin/sh\necho podium-stub "$@"\n' > "$REL/headless/podium"; chmod +x "$REL/headless/podium"
echo "9.9.9" > "$REL/headless/VERSION"
( cd "$REL" && tar -czf podium-headless-linux-x64.tar.gz headless )
# sign with a throwaway ed25519 key; write its pubkey where install.sh expects an override
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null
openssl pkey -in "$WORK/priv.pem" -pubout -outform DER 2>/dev/null | base64 -w0 > "$WORK/pub.b64"
openssl pkeyutl -sign -inkey "$WORK/priv.pem" -rawin \
  -in "$REL/podium-headless-linux-x64.tar.gz" -out "$REL/podium-headless-linux-x64.tar.gz.sig.raw"
base64 -w0 "$REL/podium-headless-linux-x64.tar.gz.sig.raw" > "$REL/podium-headless-linux-x64.tar.gz.sig"

# install.sh reads PODIUM_INSTALL_BASE (file:// or http) + PODIUM_INSTALL_PUBKEY (override) for tests.
export PODIUM_INSTALL_BASE="file://$REL"
export PODIUM_INSTALL_PUBKEY="$(cat "$WORK/pub.b64")"

echo "== plain install =="
sh "$ROOT/install.sh"
test -x "$HOME/.local/bin/podium"            || { echo FAIL: no launcher symlink; exit 1; }
test -f "$HOME/.local/share/podium/VERSION"  || { echo FAIL: bundle not installed; exit 1; }

echo "== tamper rejection =="
printf 'x' >> "$REL/podium-headless-linux-x64.tar.gz"   # corrupt after signing
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium"
if sh "$ROOT/install.sh" 2>/dev/null; then echo "FAIL: tampered install succeeded"; exit 1; fi
test ! -e "$HOME/.local/share/podium" || { echo FAIL: wrote bundle despite bad sig; exit 1; }

echo "ALL OK"
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `chmod +x scripts/install-sh.test.sh && scripts/install-sh.test.sh`
Expected: FAIL — `install.sh` does not exist yet.

- [ ] **Step 3: Write `install.sh`**

```sh
#!/bin/sh
# Podium installer. Usage:
#   curl -fsSL .../install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --join <TOKEN> [--channel edge]
set -eu

REPO="madeinorbit/podium"
CHANNEL="stable"
JOIN=""
# Ed25519 pubkey (SPKI/DER, base64). Commit the SAME value as PODIUM_UPDATE_PUBKEY in
# scripts/podium-update-pubkey.ts — the lockstep test in Step 5 enforces they match. (A test
# override is allowed via PODIUM_INSTALL_PUBKEY.) The key is public; committing it is safe.
PUBKEY="${PODIUM_INSTALL_PUBKEY:-PASTE_SAME_BASE64_AS_PODIUM_UPDATE_PUBKEY}"

while [ $# -gt 0 ]; do
  case "$1" in
    --join) JOIN="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    *) echo "podium install: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- platform detection (linux-x64 only for now) ---
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Linux" ] || { [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; }; then
  echo "podium: unsupported platform $OS/$ARCH (linux-x64 only for now; build from source)" >&2
  exit 1
fi
ASSET="podium-headless-linux-x64.tar.gz"

# --- resolve download base ---
if [ -n "${PODIUM_INSTALL_BASE:-}" ]; then
  BASE="$PODIUM_INSTALL_BASE"                                   # tests / mirrors
elif [ "$CHANNEL" = "edge" ]; then
  BASE="https://github.com/$REPO/releases/download/edge"
else
  BASE="https://github.com/$REPO/releases/latest/download"
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fetch() { # fetch <url> <out>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "podium: need curl or wget" >&2; exit 1; fi
}
echo "Downloading $ASSET ($CHANNEL)…"
fetch "$BASE/$ASSET" "$TMP/$ASSET"
fetch "$BASE/$ASSET.sig" "$TMP/$ASSET.sig"

# --- verify Ed25519 signature (fail closed) ---
echo "$PUBKEY" | base64 -d > "$TMP/pub.der"
base64 -d "$TMP/$ASSET.sig" > "$TMP/$ASSET.sig.raw"
if ! openssl pkeyutl -verify -pubin -inkey "$TMP/pub.der" -keyform DER -rawin \
       -in "$TMP/$ASSET" -sigfile "$TMP/$ASSET.sig.raw" >/dev/null 2>&1; then
  echo "podium: signature verification FAILED — refusing to install. Nothing was written." >&2
  exit 1
fi

# --- install: extract to a temp dir on the target filesystem, then atomic rename ---
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/podium"
BIN="$HOME/.local/bin"; mkdir -p "$BIN" "$(dirname "$DEST")"
STAGE="$(dirname "$DEST")/.podium-install.$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TMP/$ASSET" -C "$STAGE"
[ -d "$STAGE/headless" ] || { echo "podium: tarball missing headless/ dir" >&2; exit 1; }
rm -rf "$DEST"; mv "$STAGE/headless" "$DEST"; rm -rf "$STAGE"
ln -sf "$DEST/podium" "$BIN/podium"
echo "Installed to $DEST"

# --- PATH hint ---
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "Note: add $BIN to your PATH." ;; esac

if [ -z "$JOIN" ]; then
  echo "Done. Run: podium"
  exit 0
fi

# --- join mode: configure + enable the daemon ---
"$BIN/podium" join-config "$JOIN"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/podium-daemon.service" <<EOF
[Unit]
Description=Podium agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
ExecStart=%h/.local/bin/podium daemon
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  systemctl --user enable --now podium-daemon || \
    echo "Could not start the user service automatically; run: systemctl --user enable --now podium-daemon"
else
  echo "No systemd here. Start the daemon with: podium daemon"
fi
echo "Joined."
```

Note: the verification uses `openssl pkeyutl -verify -pubin -keyform DER -rawin`, matching how the real build (`build-bun.ts`, Node `crypto.sign(null, …)`) and the test harness produce raw Ed25519 signatures over the raw tarball bytes — the same scheme `verifyTarball` uses.

- [ ] **Step 4: Run shellcheck**

Run: `shellcheck install.sh`
Expected: no `error`-level findings (info/style warnings about the `$PATH` `case` are acceptable).

- [ ] **Step 5: Add the pubkey lockstep test**

The installer and the self-updater must trust the SAME key. Add a TS guard:

```ts
// scripts/install-pubkey.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PODIUM_UPDATE_PUBKEY } from './podium-update-pubkey'

it('install.sh PUBKEY matches PODIUM_UPDATE_PUBKEY', () => {
  const sh = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8')
  const m = sh.match(/PUBKEY="\$\{PODIUM_INSTALL_PUBKEY:-([^}"]+)\}"/)
  expect(m?.[1]).toBe(PODIUM_UPDATE_PUBKEY)
})
```

Paste the committed `PODIUM_UPDATE_PUBKEY` value into `install.sh`'s `PUBKEY` default, then:
Run: `bun run vitest run scripts/install-pubkey.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the fixture harness to verify it passes**

Run: `scripts/install-sh.test.sh`
Expected: prints `ALL OK` (plain install lays down the symlink; tampered tarball is rejected and nothing is written).

- [ ] **Step 7: Commit**

```bash
git add install.sh scripts/install-sh.test.sh scripts/install-pubkey.test.ts
git commit -m "feat(install): install.sh — signed download + verify + plain/--join modes [podium-4ny]"
```

---

### Task 6: `--system` daemon unit doc variant + `--join` already covers `--user`

**Files:**
- Create: `scripts/systemd/podium-daemon-system.service` (root/system variant, documented alternative)

**Interfaces:**
- Consumes: the installed `podium` binary at a system path.
- Produces: a reference `--system` unit (the `--user` unit is emitted inline by `install.sh`).

- [ ] **Step 1: Write the unit**

```ini
# /etc/systemd/system/podium-daemon.service  (system-wide alternative to the --user unit)
# Install: sudo cp scripts/systemd/podium-daemon-system.service /etc/systemd/system/podium-daemon.service
#          sudo systemctl enable --now podium-daemon
# Requires: a `podium` binary on PATH and a $PODIUM_STATE_DIR the User can write.
[Unit]
Description=Podium agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
User=podium
Environment=PODIUM_STATE_DIR=/var/lib/podium
ExecStart=/usr/local/bin/podium daemon
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Sanity-check the unit parses**

Run: `systemd-analyze verify scripts/systemd/podium-daemon-system.service || true`
Expected: no fatal parse errors (it may warn that `/usr/local/bin/podium` or user `podium` is absent on this host — acceptable for a template).

- [ ] **Step 3: Commit**

```bash
git add scripts/systemd/podium-daemon-system.service
git commit -m "docs(systemd): system-wide podium-daemon unit variant [podium-4ny]"
```

---

### Task 7: Headless self-update repointed to GitHub, channel-aware

**Files:**
- Modify: `scripts/podium-update.ts` (add `manifestUrlFor`; rework `runUpdate` arg)
- Modify: `scripts/cli.ts` (the `update` branch ~line 58-62)
- Test: `scripts/podium-update.test.ts` (append `manifestUrlFor` cases; keep existing)

**Interfaces:**
- Consumes: existing `parseManifest`, `verifyTarball`, `isNewer`.
- Produces:
  - `manifestUrlFor(channel: 'stable'|'edge', ctx: { target: string; cur: string; feedOverride?: string }): string`
  - `runUpdate(arg: string | { channel: 'stable'|'edge'; feedOverride?: string }): Promise<void>` (string = feedOverride, back-compat)

- [ ] **Step 1: Write the failing test** (append to `scripts/podium-update.test.ts`)

```ts
import { manifestUrlFor } from './podium-update'

describe('manifestUrlFor', () => {
  it('stable → latest/download static manifest on GitHub', () => {
    expect(manifestUrlFor('stable', { target: 'linux-x86_64', cur: '0.1.0' })).toBe(
      'https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json',
    )
  })
  it('edge → the rolling edge prerelease manifest', () => {
    expect(manifestUrlFor('edge', { target: 'linux-x86_64', cur: '0.1.0' })).toBe(
      'https://github.com/madeinorbit/podium/releases/download/edge/podium-update.json',
    )
  })
  it('a feedOverride preserves the legacy templated path (for the fixture feed)', () => {
    expect(
      manifestUrlFor('stable', { target: 'linux-x86_64', cur: '0.1.0', feedOverride: 'http://127.0.0.1:8789' }),
    ).toBe('http://127.0.0.1:8789/update/linux-x86_64/x86_64/0.1.0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run scripts/podium-update.test.ts`
Expected: FAIL — `manifestUrlFor` is not exported.

- [ ] **Step 3: Write minimal implementation** — add `manifestUrlFor` and rework `runUpdate`:

```ts
const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

export function manifestUrlFor(
  channel: 'stable' | 'edge',
  ctx: { target: string; cur: string; feedOverride?: string },
): string {
  if (ctx.feedOverride) {
    return `${ctx.feedOverride.replace(/\/$/, '')}/update/${ctx.target}/x86_64/${ctx.cur}`
  }
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
}
```

Then change the head of `runUpdate` from `export async function runUpdate(feedBase: string)`:

```ts
export async function runUpdate(
  arg: string | { channel: 'stable' | 'edge'; feedOverride?: string },
): Promise<void> {
  const { channel, feedOverride } =
    typeof arg === 'string' ? { channel: 'stable' as const, feedOverride: arg } : arg
  const dir = installDir()
  const cur = currentVersion(dir)
  const target = process.env.PODIUM_UPDATE_TARGET ?? 'linux-x86_64'
  const manifestUrl = manifestUrlFor(channel, { target, cur, feedOverride })
  // …unchanged from here down (fetch manifestUrl, parseManifest, verify, swap)…
```

(Delete the old `const manifestUrl = \`${feedBase…}\`` line — `manifestUrlFor` replaces it.)

Then update the `cli.ts` `update` branch:

```ts
  if (argv[0] === 'update') {
    const { runUpdate } = await import('./podium-update')
    const channel = (process.env.PODIUM_UPDATE_CHANNEL ?? config.updateChannel ?? 'stable') as
      | 'stable'
      | 'edge'
    const feedOverride = process.env.PODIUM_UPDATE_FEED ?? config.updateFeed
    await runUpdate(feedOverride ? { channel, feedOverride } : { channel })
    return
  }
```

- [ ] **Step 4: Run the full updater suite**

Run: `bun run vitest run scripts/podium-update.test.ts`
Expected: PASS — the 3 new `manifestUrlFor` cases plus all pre-existing tests (the back-compat string overload keeps them green).

- [ ] **Step 5: Confirm the existing E2E updater script still passes**

Run: `bash scripts/verify-headless-update.sh`
Expected: PASS (it uses a local feed override → legacy templated path, preserved by `manifestUrlFor`).

- [ ] **Step 6: Commit**

```bash
git add scripts/podium-update.ts scripts/podium-update.test.ts scripts/cli.ts
git commit -m "feat(update): headless self-update reads channel-aware GitHub manifests [podium-4ny]"
```

---

### Task 8: Desktop updater repointed to GitHub

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.endpoints`; `updater.pubkey` swapped at release time)
- Test: `apps/desktop/src-tauri/tauri-conf.test.ts`

**Interfaces:**
- Consumes: a `latest.json` Tauri manifest published by Task 9 at `…/releases/latest/download/latest.json`.
- Produces: a desktop updater that points at GitHub Releases (stable channel).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src-tauri/tauri-conf.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const conf = JSON.parse(readFileSync(join(__dirname, 'tauri.conf.json'), 'utf8'))

describe('tauri updater config', () => {
  it('points updater endpoints at the GitHub latest.json', () => {
    expect(conf.plugins.updater.endpoints).toEqual([
      'https://github.com/madeinorbit/podium/releases/latest/download/latest.json',
    ])
  })
  it('has a non-placeholder minisign pubkey', () => {
    expect(conf.plugins.updater.pubkey).not.toMatch(/RWS|placeholder/i)
    expect(String(conf.plugins.updater.pubkey).length).toBeGreaterThan(40)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/desktop/src-tauri/tauri-conf.test.ts`
Expected: FAIL — endpoints still the `releases.podium.app` placeholder; pubkey still the dev key.

- [ ] **Step 3: Edit `tauri.conf.json`**

Set `plugins.updater.endpoints` to:
```json
["https://github.com/madeinorbit/podium/releases/latest/download/latest.json"]
```
Replace `plugins.updater.pubkey` with the **production minisign public key** (`tauri signer generate` → keep the private half as the `TAURI_SIGNING_PRIVATE_KEY` CI secret). The endpoints test passes immediately; the pubkey test passes once the real key is in (in CI/dev, generate one and paste its `pub` value here).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/desktop/src-tauri/tauri-conf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/tauri-conf.test.ts
git commit -m "feat(desktop): point Tauri updater at GitHub latest.json + production minisign key [podium-4ny]"
```

---

### Task 9: Release pipeline — `scripts/release.ts` + `.github/workflows/release.yml`

**Files:**
- Create: `scripts/release.ts` (build/sign/manifest/publish; locally callable)
- Create: `.github/workflows/release.yml`
- Test: `scripts/release.test.ts` (manifest generation, pure)

**Interfaces:**
- Consumes: `scripts/build-bun.ts` output (`dist-bun/headless/…tar.gz` + `.sig` + `VERSION`); env signing keys.
- Produces: `buildHeadlessManifest({ version, url, signature }): string` (the `podium-update.json` / Tauri-shaped JSON), and a workflow that publishes both channels.

- [ ] **Step 1: Write the failing test (manifest generator is pure → unit-test it)**

```ts
// scripts/release.test.ts
import { describe, expect, it } from 'vitest'
import { buildHeadlessManifest } from './release'

describe('buildHeadlessManifest', () => {
  it('produces the Tauri-shaped headless manifest', () => {
    const json = buildHeadlessManifest({
      version: '0.2.0',
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/podium-headless-linux-x64.tar.gz',
      signature: 'BASE64SIG',
    })
    const m = JSON.parse(json)
    expect(m.version).toBe('0.2.0')
    expect(m.platforms['linux-x86_64'].url).toMatch(/podium-headless-linux-x64\.tar\.gz$/)
    expect(m.platforms['linux-x86_64'].signature).toBe('BASE64SIG')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run scripts/release.test.ts`
Expected: FAIL — `Cannot find module './release'`.

- [ ] **Step 3: Write `scripts/release.ts`**

```ts
/**
 * Release helper: build the signed headless bundle, emit the channel manifest, and (when
 * GH_TOKEN + a target are set) publish to a GitHub release via `gh`. Callable locally:
 *   bun scripts/release.ts --channel edge        # build + upload to the rolling edge prerelease
 *   bun scripts/release.ts --channel stable --tag v0.2.0
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function buildHeadlessManifest(p: { version: string; url: string; signature: string }): string {
  return JSON.stringify(
    { version: p.version, platforms: { 'linux-x86_64': { url: p.url, signature: p.signature } } },
    null,
    2,
  )
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const channel = (arg('--channel') ?? 'edge') as 'stable' | 'edge'
  const tag = channel === 'stable' ? (arg('--tag') ?? '') : 'edge'
  if (channel === 'stable' && !tag) throw new Error('stable release needs --tag vX.Y.Z')

  // 1) build + sign the headless bundle (writes dist-bun/headless/* + the tarball + .sig)
  execFileSync('bun', ['run', 'package:headless'], { stdio: 'inherit' })
  const version = readFileSync('dist-bun/headless/VERSION', 'utf8').trim()
  const tarball = `podium-headless-linux-x64.tar.gz` // build-bun emits a versioned name; rename for a stable URL
  execFileSync('bash', ['-c', `cp dist-bun/podium-headless-*.tar.gz dist-bun/${tarball}`])
  execFileSync('bash', ['-c', `cp dist-bun/podium-headless-*.tar.gz.sig dist-bun/${tarball}.sig`])
  const sig = readFileSync(`dist-bun/${tarball}.sig`, 'utf8').trim()

  const url =
    channel === 'stable'
      ? `https://github.com/madeinorbit/podium/releases/download/${tag}/${tarball}`
      : `https://github.com/madeinorbit/podium/releases/download/edge/${tarball}`
  writeFileSync('dist-bun/podium-update.json', buildHeadlessManifest({ version, url, signature: sig }))
  writeFileSync('dist-bun/VERSION', version)

  if (!process.env.GH_TOKEN) {
    console.log(`[release] built ${version} for ${channel}; set GH_TOKEN to publish.`)
    return
  }
  // 2) publish via gh: (re)create the channel release and upload assets (--clobber overwrites edge)
  const assets = [
    `dist-bun/${tarball}`,
    `dist-bun/${tarball}.sig`,
    'dist-bun/podium-update.json',
    'dist-bun/VERSION',
    'install.sh',
  ]
  if (channel === 'edge') {
    execFileSync('bash', ['-c', `gh release delete edge --yes --cleanup-tag 2>/dev/null || true`])
    execFileSync('gh', ['release', 'create', 'edge', '--prerelease', '--title', `edge (${version})`, '--notes', `Rolling edge build ${version}`, ...assets])
  } else {
    execFileSync('gh', ['release', 'create', tag, '--latest', '--generate-notes', ...assets])
    // desktop (stable only) — built + uploaded by the workflow's tauri step (see release.yml)
  }
  console.log(`[release] published ${version} → ${channel}`)
}

if (import.meta.main) void main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run scripts/release.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `.github/workflows/release.yml`**

```yaml
name: release
on:
  push:
    branches: [main]          # → edge (headless only)
    tags: ['v*']              # → stable (headless + desktop)
permissions:
  contents: write
jobs:
  release:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4
      - uses: useblacksmith/setup-bun@v1   # or oven-sh/setup-bun if unavailable
        with: { bun-version: '1.3' }
      - uses: useblacksmith/cache@v5
        with:
          path: |
            ~/.bun/install/cache
            packages/agent-bridge/src/abduco.bin
          key: build-${{ hashFiles('bun.lock') }}
      - run: bun install --frozen-lockfile
      - name: Headless build + publish
        env:
          PODIUM_UPDATE_SIGNING_KEY: ${{ secrets.PODIUM_UPDATE_SIGNING_KEY }}
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ "${{ github.ref_type }}" = "tag" ]; then
            bun scripts/release.ts --channel stable --tag "${{ github.ref_name }}"
          else
            bun scripts/release.ts --channel edge
          fi
      - name: Desktop build + publish (stable tags only)
        if: github.ref_type == 'tag'
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          GH_TOKEN: ${{ github.token }}
        run: |
          bun run --cwd apps/desktop build
          # Tauri emits the bundle, its .sig, and latest.json under apps/desktop/src-tauri/target/release/bundle
          gh release upload "${{ github.ref_name }}" \
            apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage* \
            apps/desktop/src-tauri/target/release/bundle/latest.json --clobber
```

- [ ] **Step 6: Lint the workflow YAML**

Run: `bun -e "import('node:fs').then(fs=>import('yaml').then(y=>y.parse(fs.readFileSync('.github/workflows/release.yml','utf8'))&&console.log('yaml ok')))"`
Expected: prints `yaml ok` (or use any available YAML validator). Confirm the file parses.

- [ ] **Step 7: Commit**

```bash
git add scripts/release.ts scripts/release.test.ts .github/workflows/release.yml
git commit -m "feat(release): scripts/release.ts + Blacksmith release.yml (stable/edge channels) [podium-4ny]"
```

Note: confirm `package.json` has a `package:headless` script (it does, per the spec). If `build-bun.ts` emits only a versioned tarball name, the `cp` to the stable `podium-headless-linux-x64.tar.gz` name (Step 3) gives `install.sh` a fixed URL. Verify the glob matches exactly one file during the first manual `bun scripts/release.ts --channel edge` dry-run (without `GH_TOKEN`).

---

### Task 10: Setup tRPC router + web GUI wizard

**Files:**
- Create: `apps/server/src/routers/setup.ts` (tRPC `setup` router)
- Modify: `apps/server/src/router.ts` (mount `setup`)
- Create: `apps/web/src/setup/SetupWizard.tsx`
- Modify: the web entry that gates on `needsSetup` (follow the existing setup-hint code path; e.g. `apps/web/src/App.tsx` or the existing SetupGate)
- Test: `apps/server/src/routers/setup.test.ts`

**Interfaces:**
- Consumes: `NETWORK_OPTIONS`, `networkOptionCommand`, `validatePublicUrl`, `applySetup`, `wssFrom` (Task 3).
- Produces: tRPC procedures `setup.options` (query), `setup.commandFor` (query), `setup.complete` (mutation → persists publicUrl). UI renders the steps.

- [ ] **Step 1: Write the failing test (server router)**

```ts
// apps/server/src/routers/setup.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../../../packages/core/src/config'
import { setupRouter } from './setup'

describe('setup router', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setuprtr-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })
  const caller = () => setupRouter.createCaller({} as never)

  it('lists network options', async () => {
    const opts = await caller().options()
    expect(opts.map((o) => o.id)).toContain('tailscale-funnel')
  })
  it('rejects a bad URL on complete', async () => {
    await expect(caller().complete({ publicUrl: 'nope' })).rejects.toThrow()
  })
  it('persists a normalized publicUrl on complete', async () => {
    await caller().complete({ publicUrl: 'https://box.ts.net/' })
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    expect(loadConfig().mode).toBe('all-in-one')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/server/src/routers/setup.test.ts`
Expected: FAIL — `./setup` not found.

- [ ] **Step 3: Write the router** (mirror the existing router/procedure style in `apps/server/src/router.ts`; if procedures use a shared `publicProcedure`/`router` builder, import those instead of re-creating)

```ts
// apps/server/src/routers/setup.ts
import { z } from 'zod'
import { applySetup, NETWORK_OPTIONS, networkOptionCommand, validatePublicUrl } from '../../../../packages/core/src/setup'
import { publicProcedure, router } from '../trpc' // adjust import to the project's trpc helpers

export const setupRouter = router({
  options: publicProcedure.query(() => NETWORK_OPTIONS),
  commandFor: publicProcedure
    .input(z.object({ option: z.enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual']), port: z.number() }))
    .query(({ input }) => networkOptionCommand(input.option, input.port)),
  complete: publicProcedure
    .input(z.object({ publicUrl: z.string() }))
    .mutation(({ input }) => {
      const v = validatePublicUrl(input.publicUrl)
      if (!v.ok) throw new Error(v.error)
      return applySetup({ publicUrl: v.normalized })
    }),
})
```

Mount it in `apps/server/src/router.ts` (add `setup: setupRouter` to the root router).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/server/src/routers/setup.test.ts`
Expected: PASS (3 tests). (If `createCaller` needs a real context shape, pass the project's minimal test context instead of `{} as never`.)

- [ ] **Step 5: Build the web wizard** (`apps/web/src/setup/SetupWizard.tsx`) — follow the existing panel/dialog styling (mirror `MachinesPanel.tsx` / the settings panels):

```tsx
// Minimal three-step wizard. Uses the project's trpc client hooks (adjust import to match).
import { useState } from 'react'
import { trpc } from '../trpc'

export function SetupWizard({ port, onDone }: { port: number; onDone: () => void }) {
  const options = trpc.setup.options.useQuery()
  const [option, setOption] = useState<'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual'>('tailscale-funnel')
  const cmd = trpc.setup.commandFor.useQuery({ option, port })
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const complete = trpc.setup.complete.useMutation({
    onSuccess: onDone,
    onError: (e) => setErr(e.message),
  })
  return (
    <div className="setup-wizard">
      <h2>Make this instance reachable</h2>
      <ul>
        {options.data?.map((o) => (
          <li key={o.id}>
            <label>
              <input type="radio" checked={option === o.id} onChange={() => setOption(o.id as typeof option)} />
              <strong>{o.label}</strong> — {o.note}
            </label>
          </li>
        ))}
      </ul>
      {cmd.data?.command ? (
        <pre onClick={() => navigator.clipboard.writeText(cmd.data!.command)}>{cmd.data.command}</pre>
      ) : null}
      <p>{cmd.data?.hint}</p>
      <input placeholder="Paste the resulting https:// URL" value={url} onChange={(e) => setUrl(e.target.value)} />
      {err ? <p className="error">{err}</p> : null}
      <button onClick={() => complete.mutate({ publicUrl: url })}>Finish</button>
    </div>
  )
}
```

Render `<SetupWizard>` from the existing setup gate when `needsSetup` is true (replace/augment the current "pick a folder"/setup-hint entry; keep the existing repo-scan step after setup completes).

- [ ] **Step 6: Verify build + typecheck**

Run: `bun run typecheck && bun run --filter @podium/web build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routers/setup.ts apps/server/src/router.ts apps/server/src/routers/setup.test.ts apps/web/src/setup/SetupWizard.tsx apps/web/src/App.tsx
git commit -m "feat(setup): web GUI setup wizard + setup tRPC router [podium-4ny]"
```

---

### Task 11: `podium setup` interactive CLI flow

**Files:**
- Create: `scripts/cli-setup.ts` (interactive flow over the setup core)
- Modify: `scripts/cli.ts` (handle `setup`/`--reconfigure` via the CLI flow when on a TTY; keep serving the web setup URL)
- Test: `scripts/cli-setup.test.ts`

**Interfaces:**
- Consumes: `NETWORK_OPTIONS`, `networkOptionCommand`, `validatePublicUrl`, `applySetup` (Task 3).
- Produces: `runCliSetup(io: { prompt(q: string): Promise<string>; print(s: string): void }, port: number): Promise<void>` — pure-ish, injectable IO for testing.

- [ ] **Step 1: Write the failing test (drive it with a scripted IO)**

```ts
// scripts/cli-setup.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/core/src/config'
import { runCliSetup } from './cli-setup'

describe('runCliSetup', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-clisetup-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks option choice → paste URL → persists publicUrl', async () => {
    const answers = ['1', 'https://box.ts.net'] // choose option 1 (funnel), then paste URL
    const out: string[] = []
    let i = 0
    await runCliSetup({ prompt: async () => answers[i++], print: (s) => out.push(s) }, 18787)
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    expect(out.join('\n')).toContain('tailscale funnel 18787')
  })

  it('re-prompts on an invalid URL', async () => {
    const answers = ['1', 'nope', 'https://box.ts.net']
    let i = 0
    await runCliSetup({ prompt: async () => answers[i++], print: () => {} }, 18787)
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run scripts/cli-setup.test.ts`
Expected: FAIL — `./cli-setup` not found.

- [ ] **Step 3: Write `scripts/cli-setup.ts`**

```ts
import { applySetup, NETWORK_OPTIONS, networkOptionCommand, validatePublicUrl } from '../packages/core/src/setup'

export interface SetupIO {
  prompt(q: string): Promise<string>
  print(s: string): void
}

export async function runCliSetup(io: SetupIO, port: number): Promise<void> {
  io.print('Make this instance reachable (encrypted, no domain needed):')
  NETWORK_OPTIONS.forEach((o, i) => io.print(`  ${i + 1}) ${o.label} — ${o.note}`))
  const choice = Number((await io.prompt('Choose 1-4: ')).trim()) || 1
  const opt = NETWORK_OPTIONS[Math.min(Math.max(choice, 1), NETWORK_OPTIONS.length) - 1]
  const { command, hint } = networkOptionCommand(opt.id, port)
  if (command) io.print(`\nRun this, then come back:\n\n    ${command}\n`)
  io.print(hint)
  // loop until a valid URL is pasted
  for (;;) {
    const pasted = await io.prompt('\nPaste the resulting URL: ')
    const v = validatePublicUrl(pasted)
    if (v.ok) {
      applySetup({ publicUrl: v.normalized })
      io.print(`\nSaved. This instance is reachable at ${v.normalized}. Restart podium to apply.`)
      return
    }
    io.print(`  ${v.error}`)
  }
}
```

Wire it into `scripts/cli.ts`: when `forceSetup` (the existing `setup`/`--reconfigure` path) **and** `process.stdin.isTTY`, run the CLI flow instead of only printing the web URL:

```ts
  if (forceSetup && process.stdin.isTTY) {
    const { runCliSetup } = await import('./cli-setup')
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await runCliSetup({ prompt: (q) => rl.question(q), print: (s) => console.log(s) }, port)
    rl.close()
    return
  }
```

Also extend the no-config hint (where `plan.showSetupHint` prints the URL) to add:
`console.log('  → …or run: podium setup   (configure here in the terminal)')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run scripts/cli-setup.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cli-setup.ts scripts/cli-setup.test.ts scripts/cli.ts
git commit -m "feat(cli): interactive 'podium setup' over the shared setup core [podium-4ny]"
```

---

### Task 12: Machines "Add machine" → ready-to-paste join command

**Files:**
- Modify: the Machines tRPC procedure that mints a pairing code (per spec, `apps/server/src/router.ts` machines `pairingCode`) to also return a full join command
- Modify: `apps/web/src/.../MachinesPanel.tsx` to show + copy the whole line
- Test: `apps/server/src/routers/machines-join.test.ts`

**Interfaces:**
- Consumes: `encodeJoin` (Task 1), `wssFrom` (Task 3), `loadConfig().publicUrl` (Task 2), the existing pairing-code minting.
- Produces: the pairing procedure returns `{ code, joinCommand }` where `joinCommand` is the `curl … | sh -s -- --join <token>` line.

- [ ] **Step 1: Write the failing test (the command-builder is pure → extract + test it)**

```ts
// apps/server/src/routers/machines-join.test.ts
import { describe, expect, it } from 'vitest'
import { decodeJoin } from '../../../../packages/core/src/join'
import { buildJoinCommand } from './machines-join'

describe('buildJoinCommand', () => {
  it('embeds a wss serverUrl + pair code in a decodable token', () => {
    const line = buildJoinCommand({ publicUrl: 'https://box.ts.net', pairCode: 'AB12', name: 'vps' })
    expect(line).toContain('curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh -s -- --join ')
    const token = line.split('--join ')[1].trim()
    expect(decodeJoin(token)).toEqual({ v: 1, serverUrl: 'wss://box.ts.net', pairCode: 'AB12', name: 'vps' })
  })
  it('throws when no publicUrl is configured yet', () => {
    expect(() => buildJoinCommand({ publicUrl: undefined, pairCode: 'AB12' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/server/src/routers/machines-join.test.ts`
Expected: FAIL — `./machines-join` not found.

- [ ] **Step 3: Write `apps/server/src/routers/machines-join.ts`**

```ts
import { encodeJoin } from '../../../../packages/core/src/join'
import { wssFrom } from '../../../../packages/core/src/setup'

const INSTALL = 'https://github.com/madeinorbit/podium/releases/latest/download/install.sh'

export function buildJoinCommand(p: { publicUrl?: string; pairCode: string; name?: string }): string {
  if (!p.publicUrl) {
    throw new Error('No public URL configured yet — finish setup (networking step) first.')
  }
  const token = encodeJoin({
    v: 1,
    serverUrl: wssFrom(p.publicUrl),
    pairCode: p.pairCode,
    ...(p.name ? { name: p.name } : {}),
  })
  return `curl -fsSL ${INSTALL} | sh -s -- --join ${token}`
}
```

In the machines `pairingCode` procedure, after minting `code`, read `loadConfig().publicUrl` and return `{ code, joinCommand: buildJoinCommand({ publicUrl, pairCode: code, name }) }`. If `publicUrl` is unset, return `{ code, joinCommand: null }` and let the UI show "finish setup first."

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/server/src/routers/machines-join.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Update `MachinesPanel.tsx`** — when `joinCommand` is present, show it in a `<pre>` with a copy button (mirror the existing pairing-code display); when null, show "Finish setup to get a one-line join command." Then:

Run: `bun run typecheck && bun run --filter @podium/web build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routers/machines-join.ts apps/server/src/routers/machines-join.test.ts apps/server/src/router.ts apps/web/src
git commit -m "feat(machines): Add-machine returns a ready-to-paste join command [podium-4ny]"
```

---

### Task 13: `docs/adding-a-machine.md`

**Files:**
- Create: `docs/adding-a-machine.md`
- Modify: `README.md` (add an "Install" section linking the one-liner + the doc)

- [ ] **Step 1: Write the docs**

Write `docs/adding-a-machine.md` covering, with real commands:
- **Install a new instance:** the `curl … install.sh | sh` one-liner, then `podium`, then `podium setup` (or the web URL).
- **Networking (no domain):** the private-vs-public table (Tailscale Serve / Funnel / Cloudflare quick tunnel / manual), the exact `tailscale funnel <port>` enable steps + ACL note (ports 443/8443/10000), and that **daemon↔server rides the tailnet** so a VPS only needs to reach the server, not be public.
- **Add a machine:** Settings → Machines → Add machine → copy the one line → paste on the VPS. Note repos must exist on each host.
- **Channels:** `podium update`; switch with `updateChannel` in `~/.podium/config.json` or `--channel edge` at install.
- **Desktop auto-update:** the app updates itself from GitHub `latest.json` (stable).
- **`--system` daemon:** point to `scripts/systemd/podium-daemon-system.service`.
- **Troubleshooting:** `~/.local/bin` not on PATH; `openssl` missing (install `openssl`); no systemd (`podium daemon` directly); server port not reachable on the tailnet interface (bind `0.0.0.0`/tailnet, or proxy `/daemon`).

Add a short **Install** section to `README.md` linking the one-liner and this doc.

- [ ] **Step 2: Verify links + render**

Run: `bun run lint || true` and visually confirm the markdown renders (no broken relative links to `scripts/systemd/podium-daemon-system.service`).

- [ ] **Step 3: Commit**

```bash
git add docs/adding-a-machine.md README.md
git commit -m "docs: adding-a-machine guide + README install section [podium-4ny]"
```

---

## Final verification (after all tasks)

- [ ] `bun run typecheck` — clean.
- [ ] `bun run vitest run` — all green (new: join, config, setup, cli-join, cli-setup, podium-update, release, setup router, machines-join, tauri-conf).
- [ ] `shellcheck install.sh` — clean; `scripts/install-sh.test.sh` prints `ALL OK`.
- [ ] `bash scripts/verify-headless-update.sh` — still passes (back-compat).
- [ ] `bun run --filter @podium/web build` — succeeds.
- [ ] Dry-run `GH_TOKEN= bun scripts/release.ts --channel edge` — builds the bundle + writes `dist-bun/podium-update.json`, prints "set GH_TOKEN to publish".
- [ ] `bd close podium-4ny` once merged; push the branch.

## Self-review notes (coverage map)

| Spec component | Task |
|---|---|
| C1 join codec | 1 |
| C2 config (`updateChannel`, `publicUrl`) | 2 |
| C8a setup core | 3 |
| C4 `join-config` | 4 |
| C3 `install.sh` | 5 |
| C5 daemon unit (`--user` inline + `--system` template) | 5 (inline `--user`), 6 (`--system`) |
| C6 headless self-update repoint | 7 |
| C6b desktop updater repoint | 8 |
| C7 release workflow + `release.ts` | 9 |
| C8b web GUI + setup tRPC | 10 |
| C8c CLI setup | 11 |
| Machines join-command | 12 |
| C9 docs | 13 |

Open item carried from the spec: channel naming `stable`/`edge` (proceeding unless changed).
