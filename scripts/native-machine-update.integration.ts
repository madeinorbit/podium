/** Real Linux Tauri shell + zero-role supervisor update recovery. Run under test:heavy. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { requestMachineUpdate } from "../packages/runtime/src/machine-update-control";
import { readMachineUpdateJournal } from "../packages/runtime/src/machine-update";
import { buildVendoredAbduco } from "../packages/pty/src/abduco-bin";
import { buildVendoredHost } from "../packages/pty/src/host-bin";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync("/tmp/podium-native-update-");
const state = join(root, "state");
const runtime = join(state, "runtime");
const tauri = join(repo, "apps/desktop/src-tauri");
const signer = join(repo, "apps/desktop/node_modules/.bin/tauri");
const app = join(root, "Podium");
const target = join(root, "Podium-target");
const output = resolve(
  process.argv[2] ?? ".tmp/native-machine-update-evidence.json"
);
const oldVersion = "0.1.1-dev.1000";
const newVersion = "0.1.1-dev.1001";
const log = join(root, "native.log");
const wrappers: number[] = [];
let uiServer: ReturnType<typeof Bun.serve> | undefined;
const observed: string[] = [];
const cases: unknown[] = [];
let feedMode: "current" | "older" | "empty" | "unavailable" = "current";
let manifestRequests = 0;
let artifactRequests = 0;
let corruptArtifact = false;
let server: ReturnType<typeof Bun.serve> | undefined;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(
  read: () => T | Promise<T>,
  check: (value: T) => boolean,
  label: string,
  budget = 60000
): Promise<T> {
  const end = Date.now() + budget;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      last = value;
      if (check(value)) return value;
    } catch (error) {
      last = String(error);
    }
    await pause(100);
  }
  throw new Error(
    `${label}: ${JSON.stringify(last)}; native log: ${readFileSync(
      log,
      "utf8"
    ).slice(-6000)}`
  );
}
function run(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: { ...process.env, ...extra },
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}
function digest(path: string) {
  return (
    "sha256-" + createHash("sha256").update(readFileSync(path)).digest("base64")
  );
}
function shellPids() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        return readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[0] ===
          app
          ? [Number(name)]
          : [];
      } catch {
        return [];
      }
    });
}
async function stopShell() {
  for (const pid of shellPids()) process.kill(pid, "SIGTERM");
  await until(shellPids, (pids) => pids.length === 0, "old shell stopped");
  await until(
    () => {
      try {
        const endpoint = JSON.parse(
          readFileSync(join(runtime, "machine-update-control.json"), "utf8")
        );
        process.kill(endpoint.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    Boolean,
    "old supervisor stopped"
  );
}
function launch(env: NodeJS.ProcessEnv) {
  const child = spawn(
    "dbus-run-session",
    [
      "--",
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1000x700x24",
      "sh",
      "-c",
      '"$1" & wait "$!"; sleep 180',
      "native-update-display",
      app,
    ],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  wrappers.push(child.pid!);
  for (const stream of [child.stdout, child.stderr])
    stream!.on("data", (bytes) => writeFileSync(log, bytes, { flag: "a" }));
}
try {
  mkdirSync(state, { recursive: true });
  writeFileSync(log, "");
  const key = join(root, "signing.key");
  run(signer, [
    "signer",
    "generate",
    "--ci",
    "--password",
    "",
    "--write-keys",
    key,
  ]);
  const pubkey = readFileSync(key + ".pub", "utf8").trim();
  // The client probe needs no served product UI or role payload. Build its real
  // supervisor locally instead of depending on another lane's retained staging.
  const frontend = join(root, "frontend");
  mkdirSync(frontend);
  writeFileSync(
    join(frontend, "index.html"),
    "<!doctype html><title>Native update probe</title>"
  );
  for (const [version, destination] of [
    [oldVersion, app],
    [newVersion, target],
  ] as const) {
    console.log(`Building isolated native version ${version}`);
    run("cargo", ["build", "--manifest-path", join(tauri, "Cargo.toml")], {
      CARGO_BUILD_JOBS: "2",
      CARGO_PROFILE_DEV_DEBUG: "0",
      TAURI_CONFIG: JSON.stringify({
        version,
        build: { frontendDist: frontend },
        bundle: { resources: [] },
        plugins: { updater: { pubkey } },
      }),
    });
    cpSync(join(tauri, "target/debug/Podium"), destination);
    chmodSync(destination, 0o755);
  }
  run(signer, [
    "signer",
    "sign",
    "--private-key-path",
    key,
    "--password",
    "",
    target,
  ]);
  const signature = readFileSync(target + ".sig", "utf8").trim();
  const targetBytes = readFileSync(target);
  const ca = join(root, "ca.crt"),
    caKey = join(root, "ca.key");
  const cert = join(root, "server.crt"),
    certKey = join(root, "server.key"),
    csr = join(root, "server.csr");
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Podium isolated test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
  run("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    certKey,
    "-out",
    csr,
  ]);
  const extensions = join(root, "server.ext");
  writeFileSync(
    extensions,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n"
  );
  run("openssl", [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensions,
    "-out",
    cert,
  ]);
  uiServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        "<!doctype html><title>Native update probe</title><p>Supervisor update recovery</p>",
        { headers: { "content-type": "text/html" } }
      ),
  });

  server = Bun.serve({
    tls: { cert: readFileSync(cert), key: readFileSync(certKey) },
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/artifact") {
        artifactRequests++;
        if (corruptArtifact) {
          const tampered = Buffer.from(targetBytes);
          tampered[tampered.length - 1] ^= 1;
          return new Response(tampered);
        }
        return new Response(targetBytes);
      }
      if (path === "/manifest") {
        manifestRequests++;
        if (feedMode === "empty") return new Response(null, { status: 204 });
        if (feedMode === "unavailable")
          return new Response(null, { status: 503 });
        return Response.json({
          version: feedMode === "current" ? oldVersion : "0.1.1-dev.999",
          url: `https://127.0.0.1:${server!.port}/artifact`,
          signature,
        });
      }
      return new Response(
        "<!doctype html><title>Isolated native update probe</title><p>Supervisor-owned native update recovery</p>",
        { headers: { "content-type": "text/html" } }
      );
    },
  });
  const origin = `https://127.0.0.1:${server.port}`;
  writeFileSync(
    join(state, "config.json"),
    JSON.stringify({
      configVersion: 2,
      mode: "client",
      serverUrl: `http://127.0.0.1:${uiServer.port}`,
      updateChannel: "dev",
      updateFeedEndpoint: origin + "/manifest",
    })
  );
  const payload = join(root, "payload");
  mkdirSync(payload);
  const buildRoot = join(root, "compiled-cli-build");
  const scriptsDir = join(buildRoot, "scripts");
  const distDir = join(buildRoot, "dist-bun");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(distDir);
  for (const file of [
    "cli-compiled.ts",
    "cli.ts",
    "embedded-abduco.ts",
    "embedded-host.ts",
  ])
    cpSync(join(repo, "scripts", file), join(scriptsDir, file));
  for (const dir of ["apps", "packages"])
    symlinkSync(join(repo, dir), join(buildRoot, dir), "dir");
  buildVendoredAbduco(join(distDir, "abduco.bin"));
  buildVendoredHost(join(distDir, "podium-host.bin"));
  run(process.execPath, [
    "build",
    "--compile",
    "--conditions=@podium/source",
    "--define",
    `process.env.PODIUM_APP_VERSION=${JSON.stringify(oldVersion)}`,
    join(scriptsDir, "cli-compiled.ts"),
    join(repo, "apps/daemon/src/discovery-worker.ts"),
    "--outfile",
    join(payload, "podium-cli"),
  ]);
  writeFileSync(join(payload, "VERSION"), oldVersion + "\n");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      !key.startsWith("PODIUM_") &&
      ![
        "NOTIFY_SOCKET",
        "WATCHDOG_USEC",
        "INVOCATION_ID",
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
      ].includes(key)
    )
      env[key] = value;
  for (const kind of ["DATA", "CONFIG", "CACHE", "RUNTIME"]) {
    const dir = join(root, kind.toLowerCase());
    mkdirSync(dir, { mode: 0o700 });
    env[`XDG_${kind}_HOME`] = dir;
    if (kind === "RUNTIME") env.XDG_RUNTIME_DIR = dir;
  }
  Object.assign(env, {
    SSL_CERT_FILE: ca,
    SSL_CERT_DIR: root,
    PODIUM_STATE_DIR: state,
    PODIUM_INSTANCE: "native-update-proof",
    PODIUM_PAYLOAD_HOME: payload,
    PODIUM_NO_RELAY: "1",
    PODIUM_ADOPT_STATE: "1",
    PODIUM_NO_SCOPE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    LIBGL_ALWAYS_SOFTWARE: "1",
    GDK_BACKEND: "x11",
    NO_AT_BRIDGE: "1",
  });
  const oldBytes = readFileSync(app);
  const oldDigest = digest(app);
  for (const mode of ["current", "older", "empty", "unavailable"] as const) {
    feedMode = mode;
    const feed = await fetch(origin + "/manifest", {
      tls: { ca: readFileSync(ca, "utf8") },
    });
    const feedBody = feed.status === 200 ? await feed.json() : null;
    if (
      feed.status !==
      (mode === "empty" ? 204 : mode === "unavailable" ? 503 : 200)
    )
      throw new Error(`unexpected ${mode} feed status: ${feed.status}`);
    if (
      feedBody &&
      feedBody.version !== (mode === "current" ? oldVersion : "0.1.1-dev.999")
    )
      throw new Error(`unexpected ${mode} feed version`);
    const beforeManifest = manifestRequests;
    const beforeArtifact = artifactRequests;
    const beforeObserved = observed.length;
    launch(env);
    await until(
      () => requestMachineUpdate(runtime, "/status"),
      (value) => value === null,
      "zero-role shell supervisor ready"
    );
    await until(
      () => existsSync(join(state, "update-ownership")),
      Boolean,
      "initial recovery check finished"
    );
    if (
      existsSync(join(state, "run/daemon.pid")) ||
      existsSync(join(state, "run/server.pid"))
    )
      throw new Error("client shell started a server or daemon");
    const grant = (sig: string) => ({
      type: "updateGrant",
      grantId: crypto.randomUUID(),
      issuedAt: Date.now(),
      target: {
        version: newVersion,
        critical: false,
        native: {
          url: origin + "/artifact",
          signature: sig,
          version: newVersion,
          channel: "dev",
        },
        artifacts: {
          desktop: {
            delivery: "feed",
            platforms: {
              native: {
                url: origin + "/artifact",
                signature: sig,
                digest: "native-signature-verified",
              },
            },
          },
        },
      },
    });
    await requestMachineUpdate(runtime, "/grant", grant("invalid-signature"));
    await stopShell();
    launch(env);
    await until(
      () => readMachineUpdateJournal(runtime),
      (journal) => journal?.phase === "rejected",
      "real Tauri signature rejection"
    );
    if (digest(app) !== oldDigest)
      throw new Error(
        "verification failure changed the running shell artifact"
      );
    observed.push("real-minisign-rejection-without-install");
    // Also reject altered artifact bytes with a structurally valid approved signature.
    corruptArtifact = true;
    await requestMachineUpdate(runtime, "/grant", grant(signature));
    await stopShell();
    launch(env);
    await until(
      () => readMachineUpdateJournal(runtime),
      (journal) => journal?.phase === "rejected",
      `real Tauri tampered-byte rejection with ${mode} feed`
    );
    corruptArtifact = false;
    if (digest(app) !== oldDigest)
      throw new Error("tampered signed artifact changed the running shell");
    observed.push("real-minisign-tampered-bytes-rejection-without-install");
    const accepted = grant(signature);
    await requestMachineUpdate(runtime, "/grant", accepted);
    await stopShell();
    launch(env);
    const journal = await until(
      () => readMachineUpdateJournal(runtime),
      (journal) => {
        if (journal && observed.at(-1) !== journal.phase)
          observed.push(journal.phase);
        return journal?.phase === "current";
      },
      "native replacement and successor confirmation",
      120000
    );
    if (readFileSync(join(state, "running-version"), "utf8") !== newVersion)
      throw new Error("actual shell version did not change");
    if (
      digest(app) !== digest(target) ||
      journal?.prepared?.digest !== digest(target)
    )
      throw new Error("native successor artifact identity mismatch");
    if (journal?.grant.grantId !== accepted.grantId)
      throw new Error("recovery replaced exact grant authority");
    if (
      existsSync(join(state, "run/daemon.pid")) ||
      existsSync(join(state, "run/server.pid"))
    )
      throw new Error("native update introduced a server or daemon");
    if (manifestRequests !== beforeManifest)
      throw new Error(`recovery consulted the ${mode} rolling feed`);
    if (artifactRequests - beforeArtifact !== 3)
      throw new Error(`expected three exact artifact downloads for ${mode}`);
    cases.push({
      feedMode: mode,
      feedStatus: feed.status,
      feedVersion: feedBody?.version ?? null,
      recoveryManifestRequests: manifestRequests - beforeManifest,
      artifactRequests: artifactRequests - beforeArtifact,
      runningVersion: readFileSync(join(state, "running-version"), "utf8"),
      runningDigest: digest(app),
      journal,
      observed: observed.slice(beforeObserved),
    });
    console.log(`Native recovery passed with ${mode} rolling feed`);
    await stopShell();
    // Each case starts the actual old shell again with no previous update authority.
    rmSync(runtime, { recursive: true, force: true });
    rmSync(join(state, "update-ownership"), { force: true });
    writeFileSync(app, oldBytes, { mode: 0o755 });
  }
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        result: "passed",
        platform: "Linux Tauri/WebKitGTK",
        topology: "desktop client, zero child roles",
        oldVersion,
        newVersion,
        oldDigest,
        targetDigest: digest(target),
        cases,
        scope:
          "Real native verifier (invalid signature and tampered bytes refused), Linux executable install primitive, app restart and exact-grant recovery with current/older/204/503 rolling feeds and zero recovery manifest requests. Debug ELF builds; does not cover AppImage packaging/FUSE, macOS bundles or Windows installers.",
      },
      null,
      2
    )
  );
  console.log(`Native machine-update evidence: ${output}`);
} finally {
  server?.stop(true);
  uiServer?.stop(true);
  for (const pid of shellPids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (const pid of wrappers) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
  try {
    const endpoint = JSON.parse(
      readFileSync(join(runtime, "machine-update-control.json"), "utf8")
    );
    if (readFileSync(`/proc/${endpoint.pid}/cmdline`, "utf8").includes(root))
      process.kill(endpoint.pid, "SIGTERM");
  } catch {}
  await pause(500);
  // Keep failure logs for diagnosis; success has a durable review artifact.
  if (existsSync(output)) rmSync(root, { recursive: true, force: true });
  else console.error(`Native failure state retained at ${root}`);
}
