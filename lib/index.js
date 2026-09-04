/**
 * dsh-browser-use — host half.
 *
 * Gives the dsh AI a controllable built-in browser (local Edge/Chrome driven
 * over the Chrome DevTools Protocol). The host:
 *   1. registers HTTP routes under /browser-use/* on the shared dsh webserver,
 *   2. injects a system-prompt section teaching the AI how to call them,
 *   3. persists user settings to ~/.dsh/browser-use/config.json.
 *
 * Zero external npm dependencies: CDP talks over Node's built-in
 * fetch + WebSocket (Node >= 22), the browser binary is auto-detected.
 */

import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin id; must match the cordis.patch.yml insert id. */
const name = "browser-use";

/** Services required before this plugin can mount its route. */
const inject = ["webServer", "systemPrompt"];

/** Plugin root (package.json dir). */
const PLUGIN_ROOT = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return process.cwd();
  }
})();

/** All plugin state lives under ~/.dsh/browser-use/. */
const STATE_DIR = resolve(homedir(), ".dsh", "browser-use");
const CONFIG_PATH = resolve(STATE_DIR, "config.json");
const PROFILE_DIR = resolve(STATE_DIR, "profile");
const SHOT_DIR = resolve(STATE_DIR, "screenshots");

/** Default settings. */
const DEFAULT_CONFIG = {
  enabled: true,          // master switch; off stops the AI prompt injection
  ignoreCertErrors: false, // launch with --ignore-certificate-errors
  headless: true,          // run windowless: the embedded pane IS the browser
  browserPath: ""          // optional explicit Edge/Chrome executable
};

/** Read the persisted config, merging over defaults. */
async function readConfig() {
  try {
    const data = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...(data && typeof data === "object" ? data : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Persist the config. */
async function writeConfig(cfg) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/* ------------------------------------------------------------------ *
 * Browser binary detection
 * ------------------------------------------------------------------ */

/** Candidate executables, in priority order (Edge first: ships with Windows). */
function browserCandidates() {
  const list = [];
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LocalAppData"] || "";
  const push = (p) => p && list.push(p);
  // Edge
  push(join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
  push(join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
  push(join(local, "Microsoft", "Edge", "Application", "msedge.exe"));
  // Chrome
  push(join(pf, "Google", "Chrome", "Application", "chrome.exe"));
  push(join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
  push(join(local, "Google", "Chrome", "Application", "chrome.exe"));
  // POSIX fallbacks (non-Windows hosts)
  list.push("/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  return list;
}

/** Find the browser executable: explicit config -> env -> known paths. */
function detectBrowser(cfg) {
  const tried = [];
  const consider = (p) => {
    if (!p) return null;
    tried.push(p);
    try {
      if (existsSync(p)) return p;
    } catch { /* ignore */ }
    return null;
  };
  let hit = consider((cfg.browserPath || "").trim());
  if (!hit) hit = consider(process.env.DSH_BROWSER_PATH || "");
  if (!hit) {
    for (const cand of browserCandidates()) {
      hit = consider(cand);
      if (hit) break;
    }
  }
  return { path: hit, tried };
}

/** Short display name for a browser executable path. */
function browserLabel(exePath) {
  if (!exePath) return null;
  const base = exePath.replace(/\\/g, "/").split("/").pop() || "";
  if (/msedge/i.test(base)) return "Microsoft Edge";
  if (/chrome/i.test(base)) return "Google Chrome";
  return base;
}

/* ------------------------------------------------------------------ *
 * Browser process + CDP session management
 * ------------------------------------------------------------------ */

let browserProc = null;   // child process handle
let debugPort = 0;        // CDP port parsed from DevToolsActivePort
let activeTab = null;     // { id, ws, send, waitEvent, on }
let viewportOverride = null; // { width, height } locked by the embedded panel
let agentActivityAt = 0;  // last AI-driven navigate/new_tab (drives panel auto-expand)
let lastShot = null;      // { name, ts } latest plugin-managed screenshot
let shotMarkdown = "";    // ready-to-paste markdown image line for the latest shot
let chatPort = Number(process.env.DSH_PORT) || 3080; // dsh webserver port for chat-embed URLs

/** Apply the locked viewport (1:1 with the panel screenshot) to a tab. */
async function applyViewport(tab) {
  if (!viewportOverride) return;
  try {
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: viewportOverride.width,
      height: viewportOverride.height,
      deviceScaleFactor: 1,
      mobile: false
    });
  } catch { /* ignore */ }
}

/** Launch Edge/Chrome with a dedicated profile and a CDP debugging port. */
async function launchBrowser(cfg) {
  const { path: exe, tried } = detectBrowser(cfg);
  if (!exe) {
    const e = new Error(`未找到可用的浏览器，请确认已安装 Microsoft Edge 或 Google Chrome。尝试过：${tried.join(" ; ")}`);
    e.code = "NO_BROWSER";
    throw e;
  }
  await mkdir(PROFILE_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Guest identity: no sign-in, no history persisted, nothing synced back to
    // the daily browser profile. --disable-sync blocks account sync outright;
    // the ms*WebToBrowserSignIn features are what silently sign a fresh Edge
    // profile in with the Windows Microsoft account — turn them off.
    "--guest",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,msSeamlessWebToBrowserSignIn,msWebToBrowserSignIn",
    "--window-size=1366,900",
    "about:blank"
  ];
  if (cfg.ignoreCertErrors) args.unshift("--ignore-certificate-errors");
  if (cfg.headless) args.unshift("--headless=new");

  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  proc.on("exit", () => {
    if (browserProc === proc) {
      browserProc = null;
      debugPort = 0;
      activeTab = null;
      screencastOn = false;
      if (screencastOff) { try { screencastOff(); } catch { /* ignore */ } screencastOff = null; }
      broadcastLine({ running: false });
    }
  });

  // --remote-debugging-port=0 asks Chrome to pick a free port and write it
  // into <profile>/DevToolsActivePort (line 1 = port, line 2 = browser ws path).
  // Only accept a port file written AFTER this launch started — a leftover
  // file from a previous session points at a dead port and poisons everything.
  const portFile = join(PROFILE_DIR, "DevToolsActivePort");
  const startedAt = Date.now();
  const deadline = startedAt + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const st = await stat(portFile);
      if (st.mtimeMs < startedAt - 1000) throw new Error("stale port file");
      const text = await readFile(portFile, "utf8");
      const port = Number.parseInt(text.split(/\r?\n/)[0], 10);
      if (Number.isFinite(port) && port > 0) {
        // Health-check the endpoint before trusting it.
        const ping = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok).catch(() => false);
        if (!ping) throw new Error("port not answering");
        debugPort = port;
        browserProc = proc;
        return { port, exe };
      }
    } catch { /* file not written yet / stale / endpoint dead */ }
    if (proc.exitCode !== null) break;
  }
  try { proc.kill(); } catch { /* ignore */ }
  throw new Error("浏览器启动超时（未能读取 DevToolsActivePort）");
}

/** Reap leftover managed-browser instances from a previous dsh session. A
 * hard-killed dsh never runs dispose, so its Edge/Chrome keeps the profile
 * locked and every relaunch silently exits. The profile dir is plugin-private,
 * so ANY process pointing into it is ours to kill. */
async function killOrphanBrowsers() {
  if (process.platform !== "win32") return false;
  try {
    await new Promise((res, rej) => {
      execFile("powershell.exe", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*browser-use*profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
        { windowsHide: true, timeout: 15000 },
        (err) => (err ? rej(err) : res()));
    });
    return true;
  } catch { return false; }
}

/** Ensure a browser process is running; relaunch after the user closed it. */
async function ensureBrowser() {
  if (browserProc && browserProc.exitCode === null && debugPort > 0) return debugPort;
  const cfg = await readConfig();
  try {
    const { port } = await launchBrowser(cfg);
    return port;
  } catch (error) {
    // First failure: a leftover instance likely owns the profile — reap and
    // retry exactly once before giving up.
    const reaped = await killOrphanBrowsers();
    if (!reaped) throw error;
    await new Promise((r) => setTimeout(r, 800));
    const { port } = await launchBrowser(cfg);
    return port;
  }
}

/** Kill the managed browser (settings change / plugin dispose). */
function killBrowser() {
  try { activeTab && activeTab.ws && activeTab.ws.close(); } catch { /* ignore */ }
  activeTab = null;
  if (browserProc && browserProc.exitCode === null) {
    try { browserProc.kill(); } catch { /* ignore */ }
  }
  browserProc = null;
  debugPort = 0;
}

/** Raw CDP HTTP helper against the browser endpoint (/json/*). */
async function devtoolsHttp(pathname, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${debugPort}${pathname}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `bad json (HTTP ${res.status})` };
  }
}

/** Attach a persistent CDP session to a page target. */
async function attachTab(targetId) {
  if (activeTab && activeTab.id === targetId && activeTab.ws.readyState === 1) return activeTab;
  if (activeTab) {
    try { activeTab.ws.close(); } catch { /* ignore */ }
    activeTab = null;
  }
  const info = await devtoolsHttp(`/json/list`);
  const target = Array.isArray(info) ? info.find((t) => t.id === targetId) : null;
  if (!target || !target.webSocketDebuggerUrl) throw new Error("无法连接页面目标");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
  });

  let msgId = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    let data = null;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve: res, reject: rej } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) rej(new Error(data.error.message || "CDP error"));
      else res(data.result);
      return;
    }
    if (data.method) for (const fn of listeners) fn(data);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitEvent = (method, timeoutMs = 20000) => new Promise((res) => {
    const fn = (data) => {
      if (data.method === method) {
        cleanup();
        res(data.params);
      }
    };
    const timer = setTimeout(() => { cleanup(); res(null); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
    listeners.push(fn);
  });
  /** Subscribe to a CDP event for as long as the tab lives. Returns unsubscribe. */
  const on = (method, handler) => {
    const wrapper = (data) => { if (data.method === method) handler(data.params); };
    listeners.push(wrapper);
    return () => {
      const idx = listeners.indexOf(wrapper);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  };

  const tab = { id: targetId, ws, send, waitEvent, on };
  await send("Page.enable");
  await send("Runtime.enable");
  await applyViewport(tab);
  activeTab = tab;
  await syncScreencast(); // keep live viewers on the newly active tab
  return tab;
}

/** Pick (or lazily create) the active tab. */
async function ensureTab() {
  if (activeTab && activeTab.ws.readyState === 1) return activeTab;
  await ensureBrowser();
  const list = await devtoolsHttp(`/json/list`);
  const pages = Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
  const target = pages[pages.length - 1] || pages[0];
  if (target) return attachTab(target.id);
  const created = await devtoolsHttp(`/json/new?about:blank`, "PUT")
    .catch(() => devtoolsHttp(`/json/new?about:blank`));
  if (!created || !created.id) throw new Error("无法新建标签页");
  return attachTab(created.id);
}

/* ------------------------------------------------------------------ *
 * Embedded-panel live stream (CDP screencast fan-out over chunked HTTP)
 * ------------------------------------------------------------------ */

let streamClients = new Set(); // active HTTP stream responses
let screencastOn = false;      // Page.startScreencast currently active
let screencastOff = null;      // unsubscribe from Page.screencastFrame

/** Write one JSON line to every connected stream client. */
function broadcastLine(obj) {
  const line = JSON.stringify(obj) + "\n";
  for (const res of streamClients) {
    try { res.write(line); } catch { streamClients.delete(res); }
  }
}

/** Handle a screencast frame: ack it (CDP requires this) and fan it out. */
function onScreencastFrame(params) {
  const tab = activeTab;
  if (tab) tab.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => { /* ignore */ });
  const md = params.metadata || {};
  broadcastLine({ image: params.data, w: md.deviceWidth || 0, h: md.deviceHeight || 0 });
}

/** (Re)start the screencast on the active tab when someone is watching. */
async function syncScreencast() {
  screencastOn = false;
  if (screencastOff) { try { screencastOff(); } catch { /* ignore */ } screencastOff = null; }
  if (streamClients.size === 0) return;
  const tab = activeTab;
  if (!tab) return;
  screencastOff = tab.on("Page.screencastFrame", onScreencastFrame);
  try {
    await tab.send("Page.startScreencast", {
      format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1
    });
    screencastOn = true;
  } catch {
    screencastOn = false;
  }
}

/** Push page meta (title/url/viewport) to viewers; doubles as a heartbeat. */
async function pushStreamMeta() {
  if (streamClients.size === 0) return;
  const running = browserProc && browserProc.exitCode === null && debugPort > 0;
  if (!running || !activeTab) {
    broadcastLine({ running: false });
    return;
  }
  try {
    const meta = await evalInPage(activeTab, "JSON.stringify({title:document.title,url:location.href,w:window.innerWidth,h:window.innerHeight})");
    let info = {};
    if (meta.ok && typeof meta.value === "string") {
      try { info = JSON.parse(meta.value); } catch { /* ignore */ }
    }
    broadcastLine({ running: true, title: info.title || "", url: info.url || "", w: info.w || 0, h: info.h || 0 });
  } catch {
    broadcastLine({ running: false });
  }
}

/* ------------------------------------------------------------------ *
 * In-page helpers (run as Runtime.evaluate expressions)
 * ------------------------------------------------------------------ */

/** Collect visible interactive elements + page text. Result stored for click/type. */
const READ_JS = `(function(){
  var sels = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick]';
  var nodes = Array.prototype.slice.call(document.querySelectorAll(sels));
  var els = [], arr = [];
  for (var i = 0; i < nodes.length && els.length < 150; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    var label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    els.push({ i: els.length, tag: el.tagName.toLowerCase(), label: label, href: (el.tagName === 'A' && el.href) ? el.href : (el.getAttribute('href') || ''), value: (el.tagName === 'INPUT') ? String(el.value || '').slice(0, 60) : '' });
    arr.push(el);
  }
  window.__dshbuEls = arr;
  var text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  return JSON.stringify({ title: document.title, url: location.href, text: text, elements: els });
})()`;

/** Click the element recorded at `index` by a previous read. */
function clickJs(index) {
  return `(function(){
  var el = (window.__dshbuEls || [])[${index}];
  if (!el) return JSON.stringify({ ok: false, error: '元素不存在（页面可能已跳转，请先重新 read）' });
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  el.click();
  return JSON.stringify({ ok: true });
})()`;
}

/** Type text into the element at `index` (native value setter + input events). */
function typeJs(index, text, submit) {
  const lit = JSON.stringify(text);
  return `(function(){
  var el = (window.__dshbuEls || [])[${index}];
  if (!el) return JSON.stringify({ ok: false, error: '元素不存在（页面可能已跳转，请先重新 read）' });
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  el.focus();
  var t = ${lit};
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    var proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return JSON.stringify({ ok: false, error: '该元素不是输入框' });
  }
  if (${submit ? "true" : "false"}) {
    try { if (el.form && el.form.requestSubmit) el.form.requestSubmit(); } catch (e) {}
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  return JSON.stringify({ ok: true });
})()`;
}

/** Build a CSS selector path + summary for the element under (x, y). */
function pickJs(x, y) {
  return `(function(){
  var el = document.elementFromPoint(${x}, ${y});
  if (!el) return JSON.stringify({ ok: false, error: '该坐标没有元素' });
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && parts.length < 4) {
    var seg = node.tagName.toLowerCase();
    if (node.id) { seg += '#' + node.id; parts.unshift(seg); break; }
    var cls = (typeof node.className === 'string' && node.className.trim()) ? node.className.trim().split(/\\s+/).slice(0, 2) : [];
    if (cls.length) seg += '.' + cls.join('.');
    var parent = node.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(seg);
    node = parent;
  }
  var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  var html = el.outerHTML || '';
  if (html.length > 400) html = html.slice(0, 400) + '…';
  return JSON.stringify({ selector: parts.join(' > '), tag: el.tagName.toLowerCase(), text: text, html: html, title: document.title, url: location.href });
})()`;
}

/** Evaluate a JS expression and return its value (JSON-safe). */
async function evalInPage(tab, expression) {
  const result = await tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed";
    return { ok: false, error: desc.slice(0, 500) };
  }
  return { ok: true, value: result.result ? result.result.value : undefined };
}

/** Navigate the active tab and wait for the load event (best effort). */
async function navigateTab(tab, url) {
  const loaded = tab.waitEvent("Page.loadEventFired", 25000);
  await tab.send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 400)); // let late rendering settle
}

/* ------------------------------------------------------------------ *
 * Command dispatch (the AI-facing surface)
 * ------------------------------------------------------------------ */

/** Run one browser command. Returns the JSON payload for the HTTP response. */
async function runCommand(action, params = {}) {
  switch (action) {
    case "navigate": {
      const url = String(params.url || "").trim();
      if (!url) return { ok: false, error: "缺少 url" };
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const tab = await ensureTab();
      await navigateTab(tab, full);
      const meta = await evalInPage(tab, "JSON.stringify({title:document.title,url:location.href})");
      return { ok: true, ...(meta.ok && typeof meta.value === "string" ? JSON.parse(meta.value) : {}), hint: "用 read 获取页面内容与可点击元素" };
    }
    case "read": {
      const tab = await ensureTab();
      const result = await evalInPage(tab, READ_JS);
      if (!result.ok) return result;
      try {
        return { ok: true, ...JSON.parse(result.value) };
      } catch {
        return { ok: false, error: "页面数据解析失败" };
      }
    }
    case "click": {
      const index = Number(params.index);
      if (!Number.isInteger(index) || index < 0) return { ok: false, error: "缺少有效的 index（来自 read 的元素列表）" };
      const tab = await ensureTab();
      const result = await evalInPage(tab, clickJs(index));
      if (!result.ok) return result;
      let inner = { ok: false };
      try { inner = JSON.parse(result.value); } catch { /* ignore */ }
      if (!inner.ok) return inner;
      await new Promise((r) => setTimeout(r, 900)); // give SPA routing a moment
      const meta = await evalInPage(tab, "JSON.stringify({title:document.title,url:location.href})");
      return { ok: true, ...(meta.ok && typeof meta.value === "string" ? JSON.parse(meta.value) : {}), hint: "页面可能已变化，用 read 刷新元素列表" };
    }
    case "type": {
      const index = Number(params.index);
      const text = String(params.text ?? "");
      if (!Number.isInteger(index) || index < 0) return { ok: false, error: "缺少有效的 index（来自 read 的元素列表）" };
      const tab = await ensureTab();
      const result = await evalInPage(tab, typeJs(index, text, Boolean(params.submit)));
      if (!result.ok) return result;
      let inner = { ok: false };
      try { inner = JSON.parse(result.value); } catch { /* ignore */ }
      return inner;
    }
    case "scroll": {
      const dir = params.direction === "up" ? -1 : 1;
      const amount = Number.isFinite(Number(params.amount)) ? Number(params.amount) : 800;
      const tab = await ensureTab();
      const result = await evalInPage(tab, `window.scrollBy(0, ${dir * amount}); JSON.stringify({ok:true, y: window.scrollY})`);
      return { ...result, value: undefined };
    }
    case "screenshot": {
      const tab = await ensureTab();
      const shot = await tab.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: Boolean(params.fullPage)
      });
      if (!shot || !shot.data) return { ok: false, error: "截图失败" };
      await mkdir(SHOT_DIR, { recursive: true });
      // savePath is honored ONLY when it resolves inside the plugin screenshots
      // dir. The command endpoint is unauthenticated localhost HTTP, so an
      // arbitrary-path write would let any local caller plant files anywhere
      // the dsh process can write. Outside paths fall back to the default name.
      const reqPath = (typeof params.savePath === "string" && params.savePath.trim())
        ? resolve(params.savePath.trim())
        : "";
      const savePath = (reqPath && reqPath.startsWith(SHOT_DIR + sep))
        ? reqPath
        : join(SHOT_DIR, `shot-${Date.now()}.png`);
      const buffer = Buffer.from(shot.data, "base64");
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, buffer);
      // Track plugin-managed shots so the panel can auto-display them for the
      // user (dsh chat does not inline tool-result images). Explicit savePath
      // files outside SHOT_DIR are still returned to the AI, just not tracked.
      const resolved = resolve(savePath);
      if (resolved.startsWith(SHOT_DIR + sep)) {
        const ts = Date.now();
        // Half-size capture for the chat embed: dsh renders the image at its
        // intrinsic pixel size, so serving the full-res PNG makes a huge card.
        let chatName = null;
        try {
          const small = await tab.send("Page.captureScreenshot", {
            format: "png",
            scale: 0.5,
            captureBeyondViewport: Boolean(params.fullPage)
          });
          if (small && small.data) {
            chatName = basename(resolved).replace(/\.png$/i, ".chat.png");
            await writeFile(join(SHOT_DIR, chatName), Buffer.from(small.data, "base64"));
          }
        } catch { /* fall back to the full-res file */ }
        lastShot = { name: basename(resolved), chatName, ts };
        // Linked markdown image: displays small, clicks open the full-res in a
        // new tab (dsh chat has no built-in image zoom).
        const url = (full) => `http://127.0.0.1:${chatPort}/browser-use/shot?ts=${ts}${full ? "&full=1" : ""}`;
        shotMarkdown = `[![内置浏览器截图](${url(false)})](${url(true)})`;
      }
      return {
        ok: true,
        path: savePath,
        bytes: buffer.length,
        markdown: shotMarkdown,
        hint: `【必须执行】把你回复中的这一段替换为 markdown 字段的原文（一字不改）：${shotMarkdown} —— 这样截图才会内嵌显示在用户的对话框里。不要只描述截图内容，不要说"已显示在对话框"却不含这行图片。你自己要看画面时，才用 read_image 读取 path`
      };
    }
    case "eval": {
      const expression = String(params.expression || params.js || "");
      if (!expression) return { ok: false, error: "缺少 expression" };
      const tab = await ensureTab();
      return evalInPage(tab, `JSON.stringify((function(){ try { return { ok: true, value: (${expression}) }; } catch (e) { return { ok: false, error: String(e) }; } })())`)
        .then((r) => {
          if (!r.ok) return r;
          try { return JSON.parse(r.value); } catch { return { ok: true, value: r.value }; }
        });
    }
    case "tabs": {
      await ensureBrowser();
      const list = await devtoolsHttp(`/json/list`);
      const pages = Array.isArray(list) ? list.filter((t) => t.type === "page").map((t) => ({ id: t.id, title: t.title, url: t.url })) : [];
      return { ok: true, tabs: pages, activeId: activeTab ? activeTab.id : null };
    }
    case "new_tab": {
      const url = String(params.url || "about:blank");
      await ensureBrowser();
      let created = await devtoolsHttp(`/json/new?${encodeURIComponent(url)}`, "PUT").catch(() => null);
      if (!created || !created.id) created = await devtoolsHttp(`/json/new?${encodeURIComponent(url)}`).catch(() => null);
      if (!created || !created.id) return { ok: false, error: "无法新建标签页" };
      const tab = await attachTab(created.id);
      if (!/^about:blank/.test(url)) await navigateTab(tab, url);
      return { ok: true, tabId: created.id, url };
    }
    case "close_tab": {
      const tabId = String(params.tabId || (activeTab ? activeTab.id : ""));
      if (!tabId) return { ok: false, error: "缺少 tabId" };
      await ensureBrowser();
      await devtoolsHttp(`/json/close/${tabId}`);
      if (activeTab && activeTab.id === tabId) {
        try { activeTab.ws.close(); } catch { /* ignore */ }
        activeTab = null;
      }
      return { ok: true, closed: tabId };
    }
    case "switch_tab": {
      // Panel tab switching: attach to the requested target (shared active tab).
      const tabId = String(params.tabId || "");
      if (!tabId) return { ok: false, error: "缺少 tabId" };
      await ensureBrowser();
      await attachTab(tabId);
      return { ok: true, activeId: tabId };
    }
    case "pick": {
      // Element picker: element under viewport point -> selector + summary.
      const tab = await ensureTab();
      const x = Math.round(Number(params.x) || 0);
      const y = Math.round(Number(params.y) || 0);
      const result = await evalInPage(tab, pickJs(x, y));
      if (!result.ok) return result;
      try {
        return { ok: true, ...JSON.parse(result.value) };
      } catch {
        return { ok: false, error: "元素信息解析失败" };
      }
    }
    case "devtools_url": {
      // DevTools frontend URL served by the browser's own debug endpoint.
      const tab = await ensureTab();
      const list = await devtoolsHttp(`/json/list`);
      const target = Array.isArray(list) ? list.find((t) => t.id === tab.id) : null;
      if (!target || !target.devtoolsFrontendUrl) return { ok: false, error: "无法获取 DevTools 地址" };
      return { ok: true, url: `http://127.0.0.1:${debugPort}${target.devtoolsFrontendUrl}` };
    }
    case "back":
    case "forward": {
      const tab = await ensureTab();
      const history = await tab.send("Page.getNavigationHistory");
      const idx = history.index + (action === "back" ? -1 : 1);
      const entry = (history.entries || [])[idx];
      if (!entry) return { ok: false, error: action === "back" ? "没有上一页" : "没有下一页" };
      await tab.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await new Promise((r) => setTimeout(r, 800));
      return { ok: true, entryId: entry.id };
    }
    case "reload": {
      const tab = await ensureTab();
      const loaded = tab.waitEvent("Page.loadEventFired", 25000);
      await tab.send("Page.reload", { ignoreCache: Boolean(params.ignoreCache) });
      await loaded;
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    }
    case "viewport": {
      const tab = await ensureTab();
      const w = Math.round(Number(params.width));
      const h = Math.round(Number(params.height));
      if (!(w > 0 && h > 0) || w > 4000 || h > 4000) {
        viewportOverride = null;
        try { await tab.send("Emulation.clearDeviceMetricsOverride"); } catch { /* ignore */ }
        return { ok: true, cleared: true };
      }
      viewportOverride = { width: w, height: h };
      await applyViewport(tab);
      return { ok: true, width: w, height: h };
    }
    case "view": {
      // Embedded-panel live view: JPEG of the active tab + page meta.
      const running = browserProc && browserProc.exitCode === null && debugPort > 0;
      if (!running) return { ok: true, running: false };
      const tab = await ensureTab();
      const shot = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
      if (!shot || !shot.data) return { ok: false, error: "截图失败" };
      const meta = await evalInPage(tab, "JSON.stringify({title:document.title,url:location.href,w:window.innerWidth,h:window.innerHeight})");
      let info = {};
      if (meta.ok && typeof meta.value === "string") {
        try { info = JSON.parse(meta.value); } catch { /* ignore */ }
      }
      return {
        ok: true,
        running: true,
        tabId: tab.id,
        image: shot.data,
        title: info.title || "",
        url: info.url || "",
        width: info.w || (viewportOverride ? viewportOverride.width : 0),
        height: info.h || (viewportOverride ? viewportOverride.height : 0)
      };
    }
    case "input": {
      // Raw input forwarding from the embedded panel (real CDP input events).
      const tab = await ensureTab();
      const kind = String(params.type || "");
      if (kind === "click" || kind === "dblclick") {
        const x = Number(params.x) || 0;
        const y = Number(params.y) || 0;
        const btn = ["left", "middle", "right"].includes(params.button) ? params.button : "left";
        const clicks = kind === "dblclick" ? 2 : 1;
        await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: clicks });
        await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: clicks });
        return { ok: true };
      }
      if (kind === "wheel") {
        await tab.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          deltaX: Number(params.deltaX) || 0,
          deltaY: Number(params.deltaY) || 0
        });
        return { ok: true };
      }
      if (kind === "key") {
        const key = String(params.key || "");
        if (!key) return { ok: false, error: "缺少 key" };
        const code = String(params.code || key);
        const vk = Number(params.keyCode) || 0;
        const event = {
          type: params.up ? "keyUp" : "rawKeyDown",
          key, code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk
        };
        let modifiers = 0;
        if (params.alt) modifiers |= 1;
        if (params.ctrl) modifiers |= 2;
        if (params.meta) modifiers |= 4;
        if (params.shift) modifiers |= 8;
        if (modifiers) event.modifiers = modifiers;
        if (!params.up && params.text) {
          event.type = "keyDown";
          event.text = String(params.text);
        }
        await tab.send("Input.dispatchKeyEvent", event);
        if (!params.up && params.text) {
          await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
        }
        return { ok: true };
      }
      if (kind === "text") {
        // IME/composition-safe text insertion into the focused element.
        await tab.send("Input.insertText", { text: String(params.text ?? "") });
        return { ok: true };
      }
      return { ok: false, error: `未知 input 类型：${kind}` };
    }
    case "clear_cache":
    case "clear_data": {
      const all = action === "clear_data" || params.mode === "all";
      const wasRunning = browserProc && browserProc.exitCode === null;
      const port = wasRunning ? debugPort : await ensureBrowser();
      if (port) {
        const browserWsPath = await (async () => {
          try {
            const text = await readFile(join(PROFILE_DIR, "DevToolsActivePort"), "utf8");
            return text.split(/\r?\n/)[1] || "";
          } catch { return ""; }
        })();
        // CDP browser-level session over the flat HTTP endpoint is not enough
        // for storage clearing, so drive it through a temporary page target.
        const tmp = await devtoolsHttp(`/json/new?about:blank`, "PUT").catch(() => devtoolsHttp(`/json/new?about:blank`));
        if (tmp && tmp.webSocketDebuggerUrl) {
          const ws = new WebSocket(tmp.webSocketDebuggerUrl);
          await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
          let id = 0;
          const call = (method, params2 = {}) => new Promise((res) => {
            const mid = ++id;
            const onMsg = (event) => {
              let data = null;
              try { data = JSON.parse(String(event.data)); } catch { return; }
              if (data.id === mid) { ws.removeEventListener("message", onMsg); res(data.result || {}); }
            };
            ws.addEventListener("message", onMsg);
            ws.send(JSON.stringify({ id: mid, method, params: params2 }));
          });
          await call("Network.enable");
          await call("Network.clearBrowserCache");
          if (all) {
            await call("Network.clearBrowserCookies");
            await call("Storage.clearDataForOrigin", { origin: "*", storageTypes: "all" });
          }
          try { ws.close(); } catch { /* ignore */ }
          try { await devtoolsHttp(`/json/close/${tmp.id}`); } catch { /* ignore */ }
        }
        if (!wasRunning) killBrowser(); // we only launched it to clear state
      }
      if (all && !wasRunning) {
        // Browser closed: also drop the on-disk profile for a deep clean.
        try { await rm(PROFILE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return { ok: true, mode: all ? "all" : "cache", note: all ? "已清除 Cookie、站点数据和缓存" : "已清除 HTTP 缓存" };
    }
    case "status": {
      const running = browserProc && browserProc.exitCode === null && debugPort > 0;
      return { ok: true, running: Boolean(running), port: running ? debugPort : 0 };
    }
    case "close": {
      killBrowser();
      return { ok: true, note: "浏览器已关闭" };
    }
    default:
      return { ok: false, error: `未知 action：${action}` };
  }
}

/* ------------------------------------------------------------------ *
 * AI system-prompt section
 * ------------------------------------------------------------------ */

/** Build the AI-facing instruction text (empty when the plugin is disabled). */
function buildPromptText(cfg, port) {
  if (!cfg || cfg.enabled === false) return "";
  const base = `http://127.0.0.1:${port}/browser-use/command`;
  return [
    "## 内置浏览器（browser-use）",
    "",
    "你拥有一个可控的内置浏览器（本机 Edge/Chrome，游客模式独立运行，与用户日常浏览器完全隔离）。当用户要求上网查询、打开网页、查看在线内容或截图时，通过 shell 调用：",
    "",
    "首选 GET 形式（参数直接拼在 URL 上，没有引号转义问题，PowerShell/cmd/bash 通用）：",
    "",
    "```",
    `curl -s "${base}?action=navigate&url=https%3A%2F%2Fwww.bing.com"`,
    "```",
    "",
    "也可 POST JSON（PowerShell 中 -d 的 JSON 建议用单引号包裹：-d '{\"action\":\"...\"}'；bash 中才用双引号转义）：",
    "",
    "```",
    `curl -s -X POST ${base} -H "content-type: application/json" -d '{"action":"..."}'`,
    "```",
    "",
    "可用 action（GET 时参数放在查询串，POST 时放在 JSON 体，同名同义）：",
    "- navigate {url}：打开网址，返回 {title,url}。搜索直接打开 https://www.bing.com/search?q=URL编码后的关键词，比打开首页再输入更可靠",
    "- read：读取当前页，返回 {title,url,text,elements:[{i,tag,label,href}]}；elements 的 i 是元素编号",
    "- click {index}：点击 read 列表中编号为 index 的元素",
    "- type {index,text,submit}：向输入框写入文本；submit=true 表示回车提交",
    "- scroll {direction:\"down\"|\"up\",amount}",
    "- screenshot {fullPage}：截图并返回 {path,markdown,hint}。规则：只要用户要看画面/截图，你的最终回复里**必须原样包含**返回的 markdown 字段那一行（一个可点击放大的内嵌图片），它会让截图以合适尺寸内嵌显示在对话框消息里，点击还能在新标签页打开原图。缺了这一行用户就看不到图。不要用文字描述代替图片，不要只报路径。此通道仅适用于内置浏览器画面；桌面截图等本机图片不在本插件能力范围内，应如实告知用户无法完成",
    "- eval {expression}：在页面里执行 JavaScript 并返回结果",
    "- tabs / new_tab {url} / close_tab {tabId} / back / forward / reload / close",
    "- clear_cache / clear_data：清除缓存 / 清除 Cookie 与站点数据",
    "",
    "操作流程：navigate → read 拿到元素编号 → click/type 交互 → 需要时再 read 或 screenshot。页面跳转后旧编号失效，必须重新 read。所有响应都是 JSON：{ok:true,...} 或 {ok:false,error}。内置浏览器面板对用户实时可见，你的每一步操作用户都看得到。",
    "注意：只访问与任务相关的网页，遵守目标网站的使用条款；不要登录账号或在网页中输入用户的敏感信息。"
  ].join("\n");
}

/** Best-effort detection of the dsh webserver port for the AI-facing URL. */
function detectWebPort(ctx) {
  try {
    const ws = ctx.webServer;
    const cand = ws?.port ?? ws?.options?.port ?? (typeof ws?.address === "function" ? ws.address()?.port : undefined);
    if (Number.isFinite(cand) && cand > 0) return cand;
  } catch { /* ignore */ }
  return Number(process.env.DSH_PORT) || 3080;
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

/** Read and parse a JSON request body (capped at 1MB). */
function readBody(req) {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (c) => {
      data += String(c);
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(data || "{}"));
      } catch {
        resolveBody({});
      }
    });
  });
}

/** Send a JSON response. */
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ *
 * cordis plugin entry
 * ------------------------------------------------------------------ */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 */
function apply(ctx) {
  const webPort = detectWebPort(ctx);
  chatPort = webPort;

  /** Settings + status API for the client settings page. */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/config",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/browser-use/config") return sendJson(res, 404, { ok: false, error: "not found" });
        try {
          if (req.method === "GET") {
            const cfg = await readConfig();
            const running = browserProc && browserProc.exitCode === null && debugPort > 0;
            const { path: exePath } = detectBrowser(cfg);
            return sendJson(res, 200, {
              ok: true,
              config: cfg,
              runtime: { running: Boolean(running), port: running ? debugPort : 0, browser: browserLabel(exePath), found: Boolean(exePath) }
            });
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const current = await readConfig();
            const next = { ...current };
            if (typeof body.enabled === "boolean") next.enabled = body.enabled;
            if (typeof body.ignoreCertErrors === "boolean") next.ignoreCertErrors = body.ignoreCertErrors;
            if (typeof body.headless === "boolean") next.headless = body.headless;
            if (typeof body.browserPath === "string") next.browserPath = body.browserPath.trim();
            const needsRestart = next.ignoreCertErrors !== current.ignoreCertErrors
              || next.headless !== current.headless
              || next.browserPath !== current.browserPath;
            await writeConfig(next);
            if (needsRestart) killBrowser(); // relaunch with new flags on next use
            return sendJson(res, 200, { ok: true, config: next, restarted: needsRestart });
          }
          return sendJson(res, 405, { ok: false, error: "method not allowed" });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    });
    return dispose;
  }, "browser-use: config route");

  /** Data clearing (settings page buttons + AI action share the impl). */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/clear",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "POST" || url.pathname !== "/browser-use/clear") return sendJson(res, 404, { ok: false, error: "not found" });
        try {
          const body = await readBody(req);
          const result = await runCommand(body.mode === "all" ? "clear_data" : "clear_cache", {});
          return sendJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    });
    return dispose;
  }, "browser-use: clear route");

  /** The AI-facing command endpoint (the embedded panel also calls it, with source:"panel"). */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/command",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/browser-use/command") return sendJson(res, 404, { ok: false, error: "not found" });
        try {
          let body;
          if (req.method === "GET") {
            // GET form: params straight in the query string — immune to the
            // JSON quote-escaping pain of PowerShell / cmd on Windows.
            body = {};
            for (const [k, v] of url.searchParams) body[k] = v;
          } else if (req.method === "POST") {
            body = await readBody(req);
          } else {
            return sendJson(res, 405, { ok: false, error: "method not allowed" });
          }
          const isPanel = body.source === "panel"; // manual use from the embedded panel
          const cfg = await readConfig();
          if (cfg.enabled === false && !isPanel) return sendJson(res, 403, { ok: false, error: "内置浏览器控制已在设置中关闭" });
          const action = String(body.action || "");
          const result = await runCommand(action, body);
          // Record AI-driven activity so the panel can auto-expand.
          if (result && result.ok && !isPanel && (action === "navigate" || action === "new_tab")) {
            agentActivityAt = Date.now();
          }
          return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    });
    return dispose;
  }, "browser-use: command route");

  /** Lightweight panel-state poll: running flag, tab list, AI activity. Never launches the browser. */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/state",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/browser-use/state") return sendJson(res, 404, { ok: false, error: "not found" });
        try {
          const running = browserProc && browserProc.exitCode === null && debugPort > 0;
          let tabs = [];
          if (running) {
            try {
              const list = await devtoolsHttp(`/json/list`);
              tabs = (Array.isArray(list) ? list.filter((t) => t.type === "page") : [])
                .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "" }));
            } catch { /* ignore */ }
          }
          return sendJson(res, 200, {
            ok: true,
            running: Boolean(running),
            activeId: activeTab ? activeTab.id : null,
            activityAt: agentActivityAt,
            shotAt: lastShot ? lastShot.ts : 0,
            tabs
          });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    });
    return dispose;
  }, "browser-use: state route");

  /** Serve the latest plugin-managed screenshot to the embedded panel. */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/shot",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/browser-use/shot") return sendJson(res, 404, { ok: false, error: "not found" });
        try {
          // Only ever serves the tracked latest shot inside SHOT_DIR — no
          // user-controlled path handling, so there is nothing to traverse.
          if (!lastShot) return sendJson(res, 404, { ok: false, error: "暂无截图" });
          const wantFull = url.searchParams.get("full") === "1";
          const name = !wantFull && lastShot.chatName ? lastShot.chatName : lastShot.name;
          const file = join(SHOT_DIR, name);
          const data = await readFile(file);
          res.writeHead(200, {
            "content-type": lastShot.type || "image/png",
            "content-length": data.length,
            "cache-control": "no-store"
          });
          res.end(data);
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    });
    return dispose;
  }, "browser-use: shot route");

  /** Live screencast stream for the embedded panel (newline-delimited JSON frames). */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/browser-use/stream",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/browser-use/stream") return sendJson(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        streamClients.add(res);
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          streamClients.delete(res);
          syncScreencast().catch(() => { /* ignore */ });
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        try {
          const tab = await ensureTab();
          await syncScreencast();
          await pushStreamMeta();
        } catch (error) {
          try {
            res.write(JSON.stringify({ running: false, error: String(error?.message ?? error) }) + "\n");
          } catch { /* ignore */ }
        }
      }
    });
    return dispose;
  }, "browser-use: stream route");

  /** Stream heartbeat: page meta + liveness every 2s while someone is watching. */
  ctx.effect(() => {
    const timer = setInterval(() => { pushStreamMeta().catch(() => { /* ignore */ }); }, 2000);
    return () => clearInterval(timer);
  }, "browser-use: stream heartbeat");

  /** Teach the AI how to drive the browser (kept in sync with settings). */
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: "browser-use",
        order: 50,
        text: () => {
          // Sync read: the section API expects (context) => string, not a Promise.
          let cfg = null;
          try {
            cfg = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
          } catch { /* missing config -> defaults */ }
          return buildPromptText(cfg, webPort);
        }
      });
      return dispose;
    }, "browser-use: system prompt section");
  }

  /** Shut the managed browser down with dsh. */
  ctx.effect(() => () => killBrowser(), "browser-use: cleanup");
}

export { name, inject, apply };
