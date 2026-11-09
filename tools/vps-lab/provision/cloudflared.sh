#!/bin/sh
# cloudflared, by the OFFICIAL Debian/Ubuntu repository instructions.
# https://pkg.cloudflare.com  →  add the key, add the repo, apt install.
#
# Stock on purpose: see the note at the top of tailscale.sh.
set -eu

if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo"; fi

# Add cloudflare gpg key
$SUDO mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | $SUDO tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

# Add this repo to your apt repositories
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | $SUDO tee /etc/apt/sources.list.d/cloudflared.list

# install cloudflared
$SUDO apt-get update
$SUDO apt-get install -y cloudflared

cat <<'NOTE'

Installed. To run a named tunnel with a token from the Cloudflare dashboard:

  sudo cloudflared service install <TOKEN>

Or to try a quick tunnel against a local port, with no account at all:

  cloudflared tunnel --url http://localhost:5555
NOTE
