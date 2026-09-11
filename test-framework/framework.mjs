#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QML Inspector Test Framework
//
// Reusable test framework for Qt/QML applications using the Qt Inspector.
// Import { test, run } and define your tests, then call run().
//
// Usage in a test file:
//
//   import { test, run } from "./path/to/framework.mjs";
//
//   test("my app: does something", async (app) => {
//     await app.click("my_button");
//     await app.expectTexts(["Expected Label"]);
//   });
//
//   run();
//
// Environment:
//   QML_INSPECTOR_HOST  (default: localhost)
//   QML_INSPECTOR_PORT  (no default when the framework launches the app: it
//                        takes a free port per app -- see below)
// ---------------------------------------------------------------------------

import net from "node:net";
import { spawn } from "node:child_process";

const HOST = process.env.QML_INSPECTOR_HOST || "localhost";

// The inspector port is a VARIABLE, not a constant. 3768 stays the default for
// a human attaching to an app they started by hand, but a suite that launches
// its OWN app takes a free port instead, because several such suites run at
// once: nix builds independent checks in parallel, and one machine hosts
// several agents.
//
// Two apps on one fixed port do not fail loudly. The loser's listen() fails
// with EADDRINUSE and its runner then connects to -- and drives -- the
// WINNER's app; when that app exits, every remaining case reports "Cannot
// connect to inspector". The symptom is a wall of unrelated failures in a
// suite whose own app was healthy the whole time.
const DEFAULT_PORT = 3768;
// An explicit QML_INSPECTOR_PORT is an instruction, not a default: honour it
// verbatim (that is how the MCP server and a hand-started app find each other)
// and never silently move off it.
const EXPLICIT_PORT = process.env.QML_INSPECTOR_PORT
  ? parseInt(process.env.QML_INSPECTOR_PORT, 10)
  : null;
let PORT = EXPLICIT_PORT ?? DEFAULT_PORT;
const TIMEOUT_MS = 15000;

/** The port `new Inspector()` connects to when given no port of its own. */
export function inspectorPort() { return PORT; }

/** Point the framework's default Inspector at `port`. */
export function setInspectorPort(port) { PORT = port; }

/**
 * A port nothing is listening on, for an app this process is about to launch.
 * Returns QML_INSPECTOR_PORT unchanged when one is set.
 *
 * Reserve-then-release leaves a race window between close() here and bind()
 * in the app; launchAppWithInspector() closes it by retrying on a fresh port.
 */
export function reserveInspectorPort() {
  if (EXPLICIT_PORT !== null) return Promise.resolve(EXPLICIT_PORT);
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Qt Inspector TCP bridge (newline-delimited JSON)
// ---------------------------------------------------------------------------
export class Inspector {
  // `port` pins this instance to one app. Omit it only when a single app is in
  // play (setInspectorPort() has named it); two concurrent apps need two
  // Inspectors with two explicit ports.
  constructor(port = null) {
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.port = port;
  }

  /** The port this instance talks to. */
  get inspectorPort() { return this.port ?? PORT; }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    const port = this.inspectorPort;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: HOST, port });
      sock.once("connect", () => { this.socket = sock; resolve(); });
      sock.once("error", (err) => reject(new Error(`Cannot connect to inspector on port ${port}: ${err.message}`)));
      sock.on("data", (chunk) => { this.buffer += chunk.toString("utf-8"); this._drain(); });
      sock.on("close", () => {
        this.socket = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("Connection closed")); }
        this.pending.clear();
      });
      sock.on("error", () => {});
    });
  }

  _drain() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = this.pending.get(String(msg.id));
        if (p) { clearTimeout(p.timer); this.pending.delete(String(msg.id)); p.resolve(msg); }
      } catch {
        console.error("Error processing reply message:", line);
      }
    }
  }

  async send(command, params = {}) {
    await this.connect();
    const id = ++this.requestId;
    const payload = JSON.stringify({ id, command, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`Timeout: ${command}`)); }, TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
      this.socket.write(payload);
    });
  }

  disconnect() {
    if (this.socket) this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Test helpers — high-level API for writing tests
// ---------------------------------------------------------------------------
export class App {
  constructor(inspector) {
    this.inspector = inspector;
  }

  /** Click an element by its text label. */
  async click(text, opts = {}) {
    const res = await this.inspector.send("findAndClick", { text, ...opts });
    if (res.error) throw new Error(`click("${text}"): ${res.error}`);
    return res;
  }

  /** Take a screenshot. Returns { image (base64), width, height }. */
  async screenshot() {
    return this.inspector.send("screenshot", {});
  }

  /** Get the object tree. */
  async getTree(opts = {}) {
    return this.inspector.send("getTree", opts);
  }

  /** List all interactive elements. */
  async listInteractive() {
    return this.inspector.send("listInteractive", {});
  }

  /** List all file dialogs. */
  async listFileDialogs() {
    return this.inspector.send("listFileDialogs", {});
  }

  /** Interact with an existing dialog. */
  async fileDialogAction(objectId, action, path = undefined) {
    var params = { objectId, action };
    if (path !== undefined) {
      params.path = path;
    }
    return this.inspector.send("fileDialogAction", params);
  }

  /** Find elements by property value. */
  async findByProperty(property, value) {
    const params = { property };
    if (value !== undefined) params.value = value;
    return this.inspector.send("findByProperty", params);
  }

  /** Get properties of an object. */
  async getProperties(objectId) {
    return this.inspector.send("getProperties", { objectId });
  }

  /** Assert that elements with the given texts exist in the UI. */
  async expectTexts(texts) {
    const missing = [];
    for (const expected of texts) {
      const res = await this.inspector.send("findByProperty", { property: "text", value: expected });
      if (res.error || !res.matches || res.matches.length === 0) {
        missing.push(expected);
      }
    }

    if (missing.length > 0) {
      throw new Error(`Expected texts not found: ${JSON.stringify(missing)}`);
    }
  }

  /** Assert the status label contains the given text. */
  async expectStatus(expected) {
    const res = await this.findByProperty("text", expected);
    if (!res.matches || res.matches.length === 0) {
      throw new Error(`Expected status "${expected}" not found in UI`);
    }
  }

  /** Find an object by type and return a specific property value. */
  async getPropertyByType(typeName, propName) {
    const res = await this.inspector.send("findByType", { typeName });
    if (res.error || !res.matches || res.matches.length === 0) {
      throw new Error(`No object found with type "${typeName}"`);
    }
    const objId = res.matches[0].id;
    const props = await this.inspector.send("getProperties", { objectId: objId });
    if (props.error) throw new Error(`getProperties failed: ${props.error}`);
    const prop = props.properties.find((p) => p.name === propName);
    if (!prop) throw new Error(`Property "${propName}" not found on ${typeName}`);
    return prop.value;
  }

  /** Assert a property value on an object found by type. */
  async expectProperty(typeName, propName, expected) {
    const actual = await this.getPropertyByType(typeName, propName);
    if (actual !== expected) {
      throw new Error(
        `Expected ${typeName}.${propName} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }

  /** Wait for a condition (polls). */
  async waitFor(fn, { timeout = 5000, interval = 300, description = "condition" } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        await fn();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    // One last try — let it throw
    await fn();
  }
}

// ---------------------------------------------------------------------------
// CI helpers
// ---------------------------------------------------------------------------
// The message InspectorServer::start() prints when its bind() lost the race.
// Watched for, rather than waited out, so a taken port costs milliseconds
// instead of the full waitForInspector timeout.
const BIND_FAILURE_MARKER = "[QmlInspector] Failed to listen on port";

async function waitForInspector(port = PORT, { maxRetries = 30, intervalMs = 500, bindFailed = null } = {}) {
  for (let i = 0; i < maxRetries; i++) {
    if (bindFailed?.value) {
      throw new Error(`Inspector could not bind ${HOST}:${port} (port already in use)`);
    }
    try {
      const sock = net.createConnection({ host: HOST, port });
      await new Promise((resolve, reject) => {
        sock.once("connect", () => { sock.destroy(); resolve(); });
        sock.once("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Inspector not available at ${HOST}:${port} after ${maxRetries * intervalMs}ms`);
}

// The app reads QML_INSPECTOR_PORT itself (InspectorServer::attach), so the
// port travels to it as an environment variable and nothing else has to agree.
function launchOffscreen(appBin, verbose = false, port = PORT) {
  if (verbose) console.log(`Launching: ${appBin} -platform offscreen (inspector port ${port})`);
  const child = spawn(appBin, ["-platform", "offscreen"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      QT_QPA_PLATFORM: "offscreen",
      QT_FORCE_STDERR_LOGGING: "1",
      QML_INSPECTOR_PORT: String(port),
    },
  });

  return child;
}

function launchXvfb(appBin, verbose = false, port = PORT) {
  if (verbose) console.log(`Launching: ${appBin} with Xvfb (inspector port ${port})`);

  const child = spawn(
    "xvfb-run",
    ["-a", appBin],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QT_QPA_PLATFORM: "xcb",
        QT_FORCE_STDERR_LOGGING: "1",
        QML_INSPECTOR_PORT: String(port),
      },
    }
  );

  return child;
}

function launchApp(launchFn, appBin, verbose = false, port = PORT) {
  const child = launchFn(appBin, verbose, port);
  const bindFailed = { value: false };

  // Every chunk passes through here even when quiet: the bind-failure marker
  // has to be seen, and child.stdout.resume() would throw it away.
  const tap = (stream, label) => {
    stream.on("data", (d) => {
      const text = d.toString();
      if (text.includes(BIND_FAILURE_MARKER)) bindFailed.value = true;
      if (verbose) process.stderr.write(`[app:${label}] ${text}`);
    });
  };
  tap(child.stdout, "out");
  tap(child.stderr, "err");

  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`App exited with code ${code}`);
    }
  });

  child.bindFailed = bindFailed;
  return child;
}

/**
 * Launch `appBin` on an inspector port of its own and wait until that
 * inspector answers. Returns { child, port }.
 *
 * Retries on a fresh port when the app loses the reserve/bind race with
 * another process, which is the whole point: the caller gets an app it is
 * certain is the one it launched, never a neighbour's.
 *
 * With QML_INSPECTOR_PORT set there is nothing to retry onto, so a failure
 * there is reported as-is.
 */
export async function launchAppWithInspector({
  appBin, useXvfb = false, verbose = false, attempts = 3, waitOpts = {},
} = {}) {
  const launchFn = useXvfb ? launchXvfb : launchOffscreen;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await reserveInspectorPort();
    const child = launchApp(launchFn, appBin, verbose, port);
    try {
      await waitForInspector(port, { ...waitOpts, bindFailed: child.bindFailed });
      setInspectorPort(port);
      return { child, port };
    } catch (err) {
      lastErr = err;
      const portWasTaken = child.bindFailed.value;
      child.kill();
      // Only a LOST RACE is retryable. An app that bound its port and still
      // never answered is broken, and retrying it just burns the caller's
      // timeout budget three times over before saying so.
      if (!portWasTaken || EXPLICIT_PORT !== null || attempt === attempts) throw err;
      console.error(`${err.message} — retrying on a fresh port (attempt ${attempt + 1}/${attempts})`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
const tests = [];

export function test(name, fn, opts = {}) {
  tests.push({ name, fn, skip: opts.skip || [] });
}

async function runTests(filter, appProcess, { mode = "normal" } = {}) {
  const inspector = new Inspector();
  const app = new App(inspector);

  try {
    await inspector.connect();
  } catch (err) {
    console.error(`\x1b[31m✗ Could not connect to Qt Inspector at ${HOST}:${PORT}\x1b[0m`);
    console.error(`  Make sure the app is running with the inspector enabled.`);
    if (appProcess) appProcess.kill();
    process.exit(1);
  }

  let toRun = filter
    ? tests.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tests;

  // Skip tests that opt out of the current mode (e.g. skip: ["ci"])
  const skipped = toRun.filter((t) => t.skip.includes(mode));
  toRun = toRun.filter((t) => !t.skip.includes(mode));

  if (skipped.length > 0) {
    for (const t of skipped) {
      console.log(`  \x1b[33m○\x1b[0m ${t.name} (skipped in ${mode} mode)`);
    }
  }

  console.log(`\nRunning ${toRun.length} test(s)...\n`);

  let passed = 0;
  let failed = 0;

  for (const t of toRun) {
    try {
      await t.fn(app);
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  inspector.disconnect();

  if (appProcess) {
    appProcess.kill();
    await new Promise((r) => setTimeout(r, 500));
  }

  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// run() — call this after registering tests
// ---------------------------------------------------------------------------
export async function run() {
  const rawArgs = process.argv.slice(2);
  const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v");

  // Strip flags to get positional args
  const args = rawArgs.filter(a => a !== "--verbose" && a !== "-v" && a !== "--ci" && a !== "--xvfb");
  const isCI = rawArgs.includes("--ci");

  if (isCI) {
    // CI mode: --ci <app-binary> [filter]
    const appBin = args[0];
    if (!appBin) {
      console.error("Usage: node <test-file> --ci <app-binary> [filter] [--verbose] [--xvfb]");
      process.exit(1);
    }
    const filter = args[1] || "";
    const useXvfb = rawArgs.includes("--xvfb");

    if (verbose) console.log("Launching the app and waiting for its inspector...");
    let appProcess;
    try {
      ({ child: appProcess } = await launchAppWithInspector({ appBin, useXvfb, verbose }));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (verbose) console.log(`Inspector connected on port ${PORT}.`);

    // Give the app a moment to fully initialize plugins
    await new Promise((r) => setTimeout(r, 2000));

    const mode = useXvfb ? "xcb" : "offscreen";
    await runTests(filter, appProcess, { mode });
  } else {
    // Normal mode: app must already be running
    const filter = args[0] || "";
    const mode = process.env.QT_QPA_PLATFORM || "normal";
    await runTests(filter, null, { mode });
  }
}
