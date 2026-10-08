import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { mergeDesktop } from "../src/lib/desktop-state.ts";

const base = process.env.PREVIEW_BASE_URL || "http://127.0.0.1:3000";
const nonce = randomUUID().slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, description, timeout = 20000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; } catch (e) { error = e; }
    await sleep(150);
  }
  throw new Error(`Timeout: ${description}${error ? ` (${error.message})` : ""}`);
}
const win = (id, app, opts = {}) => ({ id, app, x: 150, y: 40, w: 700, h: 500, z: 20, minimized: false, maximized: false, ...opts });
const empty = { wins: [], z: 10, seq: 0 };
const mkState = (wins) => ({ wins, z: Math.max(10, ...wins.map((w) => w.z)), seq: wins.length });
const a = win("wa", "calculator"), b = win("wb", "settings");
assert.equal(mergeDesktop(mkState([a]), mkState([b]), empty).wins.length, 2);
assert.equal(mergeDesktop(empty, mkState([{ ...a, x: 200 }]), mkState([a])).wins.length, 0);
assert.deepEqual(mergeDesktop(mkState([{ ...a, x: 200 }]), mkState([{ ...a, y: 80 }]), mkState([a])).wins[0], { ...a, x: 200, y: 80 });
console.log("PASS pure merge: concurrent create, independent fields, no resurrection");

await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 1000 } }), browser.newContext({ viewport: { width: 1440, height: 1000 } })]);
const pages = await Promise.all(contexts.map((c) => c.newPage()));
const [p1, p2] = pages;
const sockets = [];
const pageErrors = [];
const wsUrls = [[], []];
let savedLayout, savedSettings, fixturePath, cloudId;
let cookie = "";
const api = async (path, body, method = body === undefined ? "GET" : "POST", expected = 200) => {
  const response = await fetch(base + path, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
const state = () => api("/api/desktop/state");
const setState = (next, old) => api("/api/desktop/state", { state: next, ...(old ? { base: old } : {}), cid: `test-${nonce}` });
const windows = (page) => page.getByRole("button", { name: "关闭", exact: true });
const editor = (page) => page.locator("textarea:not(.xterm-helper-textarea)").last();
async function terminal(sid) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/term/ws?sid=${sid}&cols=90&rows=25`, { headers: { Cookie: cookie } });
  const entry = { ws, output: "" };
  sockets.push(entry);
  ws.on("message", (data, binary) => { if (binary) entry.output += data.toString(); });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return entry;
}
const input = (term, command) => term.ws.send(JSON.stringify({ t: "i", d: command + "\r" }));
const shellQuote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
async function desktopLogin(page) {
  await page.goto(base);
  await page.getByPlaceholder("访问密码").fill(process.env.DESKTOP_PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "进入桌面", exact: true }).click(),
  ]);
  await page.getByText("主目录", { exact: true }).first().waitFor();
}
try {
  assert.equal((await fetch(base + "/api/fs")).status, 401);
  for (let i = 0; i < pages.length; i++) {
    pages[i].on("pageerror", (e) => pageErrors.push(e.message));
    pages[i].on("websocket", (ws) => wsUrls[i].push(ws.url()));
  }
  await Promise.all(pages.map(desktopLogin));
  cookie = (await contexts[0].cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  savedLayout = (await state()).state;
  savedSettings = (await api("/api/fs")).settings;
  await setState(empty);
  await eventually(async () => (await windows(p1).count()) === 0 && (await windows(p2).count()) === 0, "clean desktops");
  await p1.screenshot({ path: "test-results/desktop.png" });
  console.log("PASS original login UI and authenticated APIs in independent contexts");

  // Independent concurrent browser updates must not clobber one another.
  const wa = win(`wa-${nonce}`, "calculator", { w: 320, h: 470 });
  const wb = win(`wb-${nonce}`, "settings", { x: 500 });
  await Promise.all([setState(mkState([wa]), empty), setState(mkState([wb]), empty)]);
  await eventually(async () => (await state()).state.wins.length === 2 && (await windows(p2).count()) === 2, "concurrent windows broadcast");
  const before = (await state()).state;
  await Promise.all([
    setState({ ...before, wins: before.wins.map((w) => w.id === wa.id ? { ...w, x: 222 } : w) }, before),
    setState({ ...before, wins: before.wins.map((w) => w.id === wa.id ? { ...w, y: 88 } : w) }, before),
  ]);
  const merged = (await state()).state.wins.find((w) => w.id === wa.id);
  assert.equal(merged.x, 222); assert.equal(merged.y, 88);
  const old = (await state()).state;
  await setState({ ...old, wins: old.wins.filter((w) => w.id !== wa.id) }, old);
  await setState({ ...old, wins: old.wins.map((w) => w.id === wa.id ? { ...w, x: 300 } : w) }, old);
  assert(!(await state()).state.wins.some((w) => w.id === wa.id));
  console.log("PASS transactional concurrent layouts and stale-close protection");

  await setState(empty);
  await eventually(async () => (await windows(p1).count()) === 0, "cleared layout");
  await contexts[0].setOffline(true);
  await p1.getByText("终端", { exact: true }).first().dblclick();
  await p2.getByText("主目录", { exact: true }).first().dblclick();
  await eventually(async () => (await state()).state.wins.some((w) => w.app === "sysfiles"), "online browser change");
  await contexts[0].setOffline(false);
  await eventually(async () => {
    const s = (await state()).state;
    return s.wins.some((w) => w.app === "systerm") && s.wins.some((w) => w.app === "sysfiles");
  }, "offline local window survives reconnect");
  console.log("PASS offline retry and rebase across browser instances");

  await setState(empty);
  await eventually(async () => (await windows(p1).count()) === 0, "terminal test layout");
  await p1.getByText("终端", { exact: true }).first().dblclick();
  const tw = await eventually(async () => (await state()).state.wins.find((w) => w.app === "systerm"), "shared terminal window");
  await eventually(async () => (await p2.locator(".xterm").count()) === 1, "terminal mirrored in second browser");
  await eventually(() => wsUrls.every((urls) => urls.some((url) => url.includes(`/api/term/ws?sid=${tw.id}`))), "same terminal SID in both UIs");
  const [t1, t2] = await Promise.all([terminal(tw.id), terminal(tw.id)]);
  input(t1, `export DES11_SYNC_TOKEN=${shellQuote(nonce)}`);
  input(t2, 'printf "TOKEN:%s\\n" "$DES11_SYNC_TOKEN"');
  await eventually(() => t1.output.includes(`TOKEN:${nonce}`) && t2.output.includes(`TOKEN:${nonce}`), "shared shell environment/output");
  const info = await api("/api/sys/info?lite=1");
  fixturePath = `${info.desktop}/sync-${nonce}.txt`;
  input(t1, `printf %s ${shellQuote("created from terminal")} > ${shellQuote(fixturePath)}`);
  await eventually(async () => (await api(`/api/sys/fs?path=${encodeURIComponent(fixturePath)}&read=1`)).content === "created from terminal", "terminal writes real file");
  await eventually(async () => (await p1.getByText(`sync-${nonce}.txt`, { exact: true }).count()) > 0 && (await p2.getByText(`sync-${nonce}.txt`, { exact: true }).count()) > 0, "terminal file on both desktops");
  await p1.reload();
  await eventually(async () => (await p1.locator(".xterm").count()) === 1, "terminal after refresh");
  input(t2, 'printf "REFRESH:%s\\n" "$DES11_SYNC_TOKEN"');
  await eventually(() => t2.output.includes(`REFRESH:${nonce}`), "shell state survives one-viewer refresh");
  console.log("PASS shared PTY, bidirectional output, terminal file visibility and refresh survival");

  // The OSC open command must open only one shared editor, never one per viewer.
  await p1.locator(".xterm-helper-textarea").focus();
  await p1.keyboard.type(`open ${shellQuote(fixturePath)}`);
  await p1.keyboard.press("Enter");
  await eventually(async () => (await state()).state.wins.filter((w) => w.app === "sysedit").length === 1, "single terminal-open action");
  await eventually(async () => (await editor(p2).inputValue()) === "created from terminal", "shared native editor load");
  await editor(p2).fill("saved from GUI");
  await p2.getByRole("button", { name: "保存", exact: true }).click();
  await eventually(async () => (await editor(p1).inputValue()) === "saved from GUI", "GUI edit in other browser");
  input(t2, `printf 'FILE:'; cat ${shellQuote(fixturePath)}; printf '\\n'`);
  await eventually(() => t2.output.includes("FILE:saved from GUI"), "GUI content visible in terminal");
  await editor(p1).fill("unsaved local draft");
  input(t2, `printf %s ${shellQuote("changed externally")} > ${shellQuote(fixturePath)}`);
  await eventually(async () => (await editor(p2).inputValue()) === "changed externally", "external change in clean editor");
  assert.equal(await editor(p1).inputValue(), "unsaved local draft");
  await api("/api/sys/fs", { path: fixturePath, content: "stale save", expectedContent: "saved from GUI" }, "PUT", 409);
  console.log("PASS terminal ↔ GUI saved-file sync and preserved unsaved drafts/conflicts");

  await setState(empty);
  const raceSid = `wrace-${nonce}`;
  const [r1, r2] = await Promise.all([terminal(raceSid), terminal(raceSid)]);
  input(r1, `export DES11_RACE_TOKEN=${shellQuote(nonce)}`);
  await sleep(100);
  input(r2, 'printf "RACE:%s\\n" "$DES11_RACE_TOKEN"');
  await eventually(() => r1.output.includes(`RACE:${nonce}`) && r2.output.includes(`RACE:${nonce}`), "concurrent initial PTY attaches share one process");
  input(r1, "exit");
  console.log("PASS concurrent terminal creation lock");

  const fs = await api("/api/fs");
  const documents = fs.nodes.find((n) => n.name === "Documents" && n.parentId === null);
  const created = await api("/api/fs", { parentId: documents.id, name: `sync-${nonce}.txt`, kind: "file", content: "cloud original" });
  cloudId = created.node.id;
  await setState(mkState([win(`wnote-${nonce}`, "notepad", { fileId: cloudId })]));
  await eventually(async () => (await editor(p1).inputValue()) === "cloud original" && (await editor(p2).inputValue()) === "cloud original", "cloud file shared load");
  await api(`/api/fs/${cloudId}`, { content: "cloud synchronized", expectedContent: "cloud original" }, "PATCH");
  await eventually(async () => (await editor(p1).inputValue()) === "cloud synchronized" && (await editor(p2).inputValue()) === "cloud synchronized", "cloud file live update");
  await api(`/api/fs/${cloudId}`, { content: "stale cloud", expectedContent: "cloud original" }, "PATCH", 409);
  await api("/api/settings", { key: "wallpaper", value: "img2" }, "PUT");
  await eventually(async () => (await p2.locator('[style*="--accent"]').getAttribute("style")).includes("/wallpapers/2.jpg"), "wallpaper sync");
  console.log("PASS cloud files, stale-save rejection and wallpaper synchronization");

  const guiId = `wgui-${nonce}`;
  await setState(mkState([win(guiId, "gui", { cmd: "xterm", title: "Sync verification" })]));
  const [g1, g2] = await Promise.all([api("/api/gui", { key: guiId, exec: "xterm", w: 700, h: 450 }), api("/api/gui", { key: guiId, exec: "xterm", w: 700, h: 450 })]);
  assert.equal(g1.sid, g2.sid);
  await eventually(async () => (await api(`/api/gui/${g1.sid}`)).state === "running", "native xterm GUI startup", 45000);
  await eventually(() => wsUrls.every((urls) => urls.some((url) => url.includes(`/api/gui/ws?sid=${g1.sid}`))), "both noVNC viewers attach");
  await p1.reload();
  await sleep(2000);
  assert.equal((await api(`/api/gui/${g1.sid}`)).state, "running");
  assert.equal((await api("/api/gui", { key: guiId, exec: "xterm" })).sid, g1.sid);
  await setState(empty);
  await eventually(async () => (await fetch(base + `/api/gui/${g1.sid}`, { headers: { Cookie: cookie } })).status === 404, "shared GUI window close shuts down server process");
  console.log("PASS shared native GUI/noVNC session, refresh survival and window-close cleanup");

  const browserId = `wbrowser-${nonce}`;
  await setState(mkState([win(browserId, "lite", { path: `${base}/api/health` })]));
  const [br1, br2] = await Promise.all([api("/api/browser", { key: browserId, url: `${base}/api/health`, w: 800, h: 500 }), api("/api/browser", { key: browserId, url: `${base}/api/health`, w: 800, h: 500 })]);
  assert.equal(br1.sid, br2.sid);
  await api(`/api/browser/${br1.sid}/input`, { events: [{ type: "newtab", url: `${base}/api/health?shared=${nonce}` }] });
  await eventually(async () => (await api(`/api/browser/${br1.sid}/meta?v=-1`)).tabs.some((t) => t.url.includes(nonce)), "browser tab state shared");
  await p1.reload();
  await sleep(1200);
  assert.equal((await api("/api/browser", { key: browserId })).sid, br1.sid);
  await p2.screenshot({ path: "test-results/shared-browser.png" });
  await setState(empty);
  console.log("PASS shared remote-browser tabs and refresh survival");
  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
  console.log("ALL SYNCHRONIZATION CHECKS PASSED");
} catch (error) {
  await p1.screenshot({ path: "test-results/failure.png" }).catch(() => {});
  console.error("Browser errors:", pageErrors);
  console.error("Observed WebSocket URLs:", wsUrls);
  console.error("Final shared state:", await state().catch(() => null));
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.setOffline(false).catch(() => {});
  if (savedLayout) await setState(savedLayout).catch(console.error);
  if (savedSettings) await api("/api/settings", { key: "wallpaper", value: savedSettings.wallpaper && savedSettings.wallpaper !== "1" ? savedSettings.wallpaper : "img1" }, "PUT").catch(console.error);
  if (cloudId) await api(`/api/fs/${cloudId}?permanent=1`, undefined, "DELETE").catch(console.error);
  if (fixturePath) await api(`/api/sys/fs?path=${encodeURIComponent(fixturePath)}&permanent=1`, undefined, "DELETE").catch(console.error);
  for (const { ws } of sockets) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "kill" })); ws.close(); }
  await browser.close();
}
