#!/bin/sh
# Explicit public-feed opt-out for provisioned test and lab machines.
set -eu
policy_root=${1:-/}
mkdir -p "$policy_root/etc/environment.d"
printf 'PODIUM_UPDATE_FEED_POLLING=off\n' >"$policy_root/etc/environment.d/80-podium-update-feed.conf"
# PAM/SSH login shells read /etc/environment; user managers read environment.d.
touch "$policy_root/etc/environment"
sed '/^PODIUM_UPDATE_FEED_POLLING=/d' "$policy_root/etc/environment" >"$policy_root/etc/environment.podium-new"
printf 'PODIUM_UPDATE_FEED_POLLING=off\n' >>"$policy_root/etc/environment.podium-new"
cat "$policy_root/etc/environment.podium-new" >"$policy_root/etc/environment"
rm "$policy_root/etc/environment.podium-new"
