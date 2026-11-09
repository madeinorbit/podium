# Playbook: servers that move, round 4 (POD-5921)

> Historical scenario notes from September–October 2026. Builds, UI wording and box
> assignments below describe that run, not the current fleet. Start with [README.md](README.md),
> claim your slots and use the release issue's selected build and test credentials.

Build under test: dev channel, dev/mw `fa6740303f` (round 3 plus "clients follow a moved
server"). Connect in production has the stable link `/to/<id>` and CORS on its read.

```
cd tools/vps-lab  # from the repository root
```

| Box  | State                                                                  |
|------|------------------------------------------------------------------------|
| vps1 | server on a Cloudflare quick tunnel, updated to this build, `<lab-ui-password>` |
| vps2 | joined to vps1, updated to this build                                  |
| vps3 | fresh (clean snapshot)                                                 |
| vps4 | fresh                                                                  |
| vps5 | fresh                                                                  |

What changed: a joined machine now moves to a new address only once that address proves it
holds the server's installation key (`POST /.well-known/podium/locate`). Until a joined
machine has seen its own server prove itself once, it still accepts an older server on
`/version`; after that, only the proof counts (`connect.locateProofVerified` in its config).

---

## 1. The server proves itself (vps1)

```
./lab ssh 1
```
```
podium status
```
Expect a `Stable link: https://connect.podium.do/to/pdm_…` line under `URL:`. Then ask the
server for a proof yourself (any 32-byte nonce):
```
U=$(grep -o '"publicUrl": *"[^"]*"' ~/.podium/config.json | cut -d'"' -f4)
curl -s -X POST -H 'content-type: text/plain' --data '{"nonce":"WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo"}' "$U/.well-known/podium/locate"; echo
```
Expect `{"installationId":"pdm_…","publicUrl":"https://…trycloudflare.com","signature":"…"}`,
with `publicUrl` exactly the tunnel address. A malformed nonce gives 400.

## 2. The joined machine trusts the proof from now on (vps2)

```
./lab ssh 2
```
```
grep -A4 '"connect"' ~/.podium/config.json
journalctl --user -u podium -o cat | grep -E "proved its installation key|no locate proof yet" | tail -3
```
Expect `"locateProofVerified": true` and `server proved its installation key; Connect
candidates must now prove it too`.

## 3. The joined machine follows the tunnel, with proof (vps1/vps2)

Terminal A (vps2):
```
watch -n2 'grep -o "\"serverUrl\": *\"[^\"]*\"" ~/.podium/config.json'
```
Terminal B (vps1):
```
systemctl --user restart podium-tunnel; journalctl --user -u podium-tunnel -f -o cat | grep -E "resolves at|recorded|not reachable"
```
Expect A to switch within ~10 s of `recorded`, exactly as in round 3. On vps2, nothing in the
log should say `locator candidate rejected`:
```
journalctl --user -u podium -o cat | grep -E "locator|adopted the resolved" | tail -5
```
Then `docker restart vps1` from the host: A follows again once vps1 is back.

## 4. The stable link (browser) — KNOWN BROKEN for quick tunnels, skip

Today `/to/<id>` shows the waiting page (503) even while vps1 answers: Connect proves the
endpoint from a Cloudflare Worker, and a Worker cannot connect to `*.trycloudflare.com`
(the same limit POD-3274 measured for the reachability probe on 2026-10-06). Fix pending.
What it should do once fixed:

Take the `Stable link` from `podium status` on vps1 and open it.

- Expect it to land on vps1's current tunnel address (the login page).
- Restart the tunnel on vps1 (block 3, terminal B); once `recorded` shows, open the stable
  link again: it lands on the NEW address.
- Stop the tunnel: `systemctl --user stop podium-tunnel`. The link now shows "Your Podium
  server is not reachable right now. This page checks again every 10 seconds." Start it again
  (`systemctl --user start podium-tunnel`): within ~10 s of `recorded` the page lands on the
  new address by itself.
- `https://connect.podium.do/to/pdm_nope` shows the same waiting page (404), naming nothing.

## 5. A browser tab follows the server (browser)

Open vps1's tunnel address, log in (`<lab-ui-password>`), keep the tab open. Restart the tunnel on
vps1. Expect, within ~15 s of `recorded`: a toast "Podium moved to <new host>. You will need to
log in there." and then the login page at the new address (same path). The cookie does not
move; logging in again is expected.

Settings → Network on vps1 shows the same link as "Stable link (bookmark this)".

## 6. Connect unreachable from the joined machine (vps2)

```
HOST$ docker exec vps2 sh -c 'iptables -A OUTPUT -p tcp -d 104.21.89.185 -j REJECT; iptables -A OUTPUT -p tcp -d 172.67.191.3 -j REJECT; ip6tables -A OUTPUT -p tcp -d 2606:4700:3030::6815:59b9 -j REJECT; ip6tables -A OUTPUT -p tcp -d 2606:4700:3035::ac43:bf03 -j REJECT'
```
Restart the tunnel on vps1. vps2 keeps the old address and logs `locator gave no record`.
Undo, and expect it to follow at its next ask (≤ ~15 s in the first ten minutes):
```
HOST$ docker exec vps2 sh -c 'iptables -F OUTPUT; ip6tables -F OUTPUT'
```

## 7. Fresh server and join, new wording (vps3 → vps4)

```
./lab ssh 3
```
```
curl -fsSL https://github.com/madeinorbit/podium/releases/download/dev/install.sh | sh -s -- --channel dev
```
→ server mode → **Cloudflare quick tunnel**. The "About this address" note now reads:
- The address changes whenever the tunnel restarts, for example after a reboot or a dropped connection.
- Joined machines and the desktop and mobile apps follow it on their own.
- In a browser, bookmark this link instead: https://connect.podium.do/to/pdm_…

Join vps4 to it with the "add machine" command, then repeat block 3 on vps3/vps4.

## Undo everything

```
./lab reset 3 clean; ./lab reset 4 clean; ./lab reset 5 clean
```
