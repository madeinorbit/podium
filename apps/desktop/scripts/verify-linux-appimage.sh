#!/usr/bin/env bash
set -euo pipefail

bundle_dir="${1:?usage: verify-linux-appimage.sh <appimage-bundle-dir>}"
mapfile -t appimages < <(find "$bundle_dir" -maxdepth 1 -type f -name '*.AppImage' -print)
if [ "${#appimages[@]}" -ne 1 ]; then
  echo "expected exactly one AppImage in $bundle_dir, found ${#appimages[@]}" >&2
  exit 1
fi
appimage="$(realpath "${appimages[0]}")"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
(
  cd "$scratch"
  "$appimage" --appimage-extract >/dev/null
)

plugins="$scratch/squashfs-root/usr/lib/gstreamer-1.0"
for plugin in libgstapp.so libgstopengl.so; do
  if [ ! -e "$plugins/$plugin" ]; then
    echo "Linux AppImage is missing required GStreamer plugin: $plugin" >&2
    exit 1
  fi
done

echo "Linux AppImage contains the required GStreamer app and OpenGL plugins."
