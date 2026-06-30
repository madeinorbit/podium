#!/usr/bin/env bash
# Stage the embedded Postgres into the Tauri bundle resources so `tauri build`
# ships it inside the desktop image. Reproduces the experiment's PG-bundled build.
#
# Run from the worktree root after `bun add embedded-postgres`:
#   bash scripts/exp/stage-postgres-resource.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

PKGDIR=$(dirname "$(find node_modules/.bun -path '*@embedded-postgres+linux-x64*/native' -type d | head -1)")
[ -n "$PKGDIR" ] || { echo "embedded-postgres linux-x64 not found — run 'bun add embedded-postgres'"; exit 1; }
NATIVE="$PKGDIR/native"
DEST="apps/desktop/src-tauri/resources/postgres"

# 1. Materialize the soname symlinks (Bun skips the package postinstall that creates them).
bun -e '
const fs=require("fs"),path=require("path");
const pkg=process.argv[1];
for(const {source,target} of JSON.parse(fs.readFileSync(path.join(pkg,"native","pg-symlinks.json"),"utf8"))){
  const t=path.join(pkg,target);
  try{fs.rmSync(t,{force:true});fs.symlinkSync(path.relative(path.dirname(t),path.join(pkg,source)),t)}catch(e){console.error("symlink",target,e.message)}
}
console.log("soname symlinks materialized");
' "$PKGDIR"

# 2. Copy bin/lib/share into resources, PRESERVING symlinks (-a) so it stays ~60M (not 123M).
rm -rf "$DEST"; mkdir -p "$DEST"
cp -a "$NATIVE/bin" "$NATIVE/lib" "$NATIVE/share" "$DEST/"

# 3. Drop PL/Perl, PL/Python, PL/Tcl contrib extensions: we need none of them, and their
#    libperl/libpython/libtcl deps make linuxdeploy fail the AppImage. (pgoutput is built-in.)
rm -f "$DEST"/lib/postgresql/*plperl* "$DEST"/lib/postgresql/*plpython* "$DEST"/lib/postgresql/*pltcl* \
      "$DEST"/lib/postgresql/plperl.so "$DEST"/lib/postgresql/plpython3.so "$DEST"/lib/postgresql/pltcl.so

echo "staged Postgres -> $DEST ($(du -sh "$DEST" | cut -f1))"
echo "now: add \"resources/postgres\" to bundle.resources in tauri.conf.json, then 'bun run desktop:build'"
