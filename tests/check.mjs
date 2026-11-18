import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = path.join(root, "native", "bin", "Release", "net10.0-windows");
const testParent = realpathSync(path.join(root, "native", "bin"));
const temp = mkdtempSync(path.join(testParent, "push-tests-"));
const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const host = "com.push_to_codex.host";

function frame(request) {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function reply(executable, caller, input) {
  const child = spawnSync(executable, [caller], { input, windowsHide: true, timeout: 21000 });
  assert.ifError(child.error);
  const output = child.stdout;
  assert.equal(output.readUInt32LE(), output.length - 4);
  return JSON.parse(output.subarray(4));
}

async function protocolChecks() {
  for (const name of ["PushHost.exe", "PushHost.dll", "PushHost.deps.json", "PushHost.runtimeconfig.json"]) {
    copyFileSync(path.join(build, name), path.join(temp, name));
  }
  const executable = path.join(temp, "PushHost.exe");
  writeFileSync(path.join(temp, host + ".json"), JSON.stringify({ allowed_origins: [origin] }));
  assert.deepEqual(await reply(executable, "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", frame({})),
    { code: "helper_forbidden" });
  assert.deepEqual(await reply(executable, origin, frame({ prompt: " ", mode: "new", submit: false })), { code: "invalid" });
  assert.deepEqual(await reply(executable, origin, frame({ prompt: "Hello", mode: "shell", submit: false })), { code: "invalid" });
  assert.deepEqual(await reply(executable, origin, frame({ prompt: "Hello\0World", mode: "active", submit: true })), { code: "invalid" });
  assert.deepEqual(await reply(executable, origin, frame({ prompt: "Hello", mode: "new", submit: "true" })), { code: "invalid" });
  assert.deepEqual(await reply(executable, origin, frame({ prompt: "Hello", mode: "new", submit: false, command: "no" })), { code: "invalid" });
  assert.deepEqual(await reply(executable, origin, Buffer.from([5, 0, 0, 0, 123])), { code: "invalid" });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32LE(1024 * 1024 + 1);
  assert.deepEqual(await reply(executable, origin, oversizedHeader), { code: "invalid" });
  console.log("PASS 8 native protocol checks");
}

function workerChecks() {
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sender = { id: extensionId, frameId: 0, origin: "https://chatgpt.com" };
  let listener, onMessage, onDisconnect, posted, now = 3000;
  const runtime = {
    id: extensionId,
    onMessage: { addListener(fn) { listener = fn; } },
    connectNative(name) {
      assert.equal(name, host);
      return {
        onMessage: { addListener(fn) { onMessage = fn; } },
        onDisconnect: { addListener(fn) { onDisconnect = fn; } },
        postMessage(request) { posted = request; },
        disconnect() {}
      };
    }
  };
  const replies = [];
  const respond = result => replies.push(result.code);
  runInNewContext(readFileSync(path.join(root, "extension", "background.js"), "utf8"), {
    chrome: { runtime }, Date: { now: () => now }, TextEncoder, setTimeout, clearTimeout
  });
  const prompt = "Please reply with OK. Do not modify files.\n" + "日本語 🌲\n".repeat(14000);
  const message = { type: "push", mode: "new", submit: false, prompt };
  assert.equal(listener(message, { ...sender, origin: "https://example.com" }, respond), false);
  assert.equal(listener(message, { ...sender, frameId: 1 }, respond), false);
  assert.equal(listener(message, sender, respond), true);
  assert.equal(posted.prompt, prompt);
  assert.equal(posted.mode, "new");
  assert.equal(posted.submit, false);
  assert.equal(listener(message, sender, respond), false);
  onMessage({ code: "inserted" });
  assert.equal(listener(message, sender, respond), false);
  now += 2000;
  assert.equal(listener({ ...message, mode: "active", submit: true }, sender, respond), true);
  assert.equal(posted.mode, "active");
  assert.equal(posted.submit, true);
  runtime.lastError = { message: "Specified native messaging host not found." };
  onDisconnect();
  assert.deepEqual(replies, ["in_progress", "inserted", "in_progress", "helper_missing"]);
  console.log("PASS worker scope, payload, modes, submit preference, duplicate guard and missing-host feedback");
}

function chromiumChecks() {
  const chrome = process.env.PUSH_TEST_CHROME ||
    path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
  const fixture = pathToFileURL(path.join(root, "tests", "browser.html")).href;
  const browser = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--user-data-dir=" + path.join(temp, "chrome-profile"),
    "--virtual-time-budget=3000", "--dump-dom", fixture],
  { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.ifError(browser.error);
  const result = browser.stdout.match(/<output id="result">([^<]*)<\/output>/)?.[1];
  assert.ok(result?.startsWith("PASS "), result || browser.stderr || "Chrome fixture produced no result");
  console.log(result);
}

async function desktopCheck(mode) {
  const executable = path.join(temp, "PushHost.exe");
  const lines = [
    "Please reply with PUSH OK. Do not modify files, run commands, or take any other action.",
    "",
    "## Formatting check",
    "",
    "Unicode: café, 日本語, 🌲.",
    "",
    String.fromCharCode(96).repeat(3) + "text",
    "  Indented text",
    String.fromCharCode(96).repeat(3)
  ];
  if (process.argv.includes("--long")) lines.push("\n" + "This is filler. Do not modify files.\n".repeat(1000));
  const result = await reply(executable, origin, frame({ mode, submit: false, prompt: lines.join("\n") }));
  console.log("Desktop result =", result.code);
}

try {
  await protocolChecks();
  workerChecks();
  const desktopMode = process.argv.find(argument => argument.startsWith("--desktop="))?.slice("--desktop=".length);
  if (desktopMode === "active" || desktopMode === "new") await desktopCheck(desktopMode);
  else chromiumChecks();
} finally {
  if (path.dirname(realpathSync(temp)) === testParent) {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
