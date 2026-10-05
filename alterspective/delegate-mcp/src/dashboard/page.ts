// #129: the dashboard's page. Both parts are constant strings: the server never puts data into
// them. The script reads data.json and builds every element with createElement + textContent, so a
// repo or model name is only ever text. The CSP in server.ts allows only this script and inline style.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delegated work</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; max-width: 100%; overflow-x: hidden; }
body {
  padding: 0 16px 32px;
  background: Canvas;
  color: CanvasText;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.45;
}
h1 { font-size: 1.5rem; margin: 20px 0 4px; }
h2 { font-size: 1.1rem; margin: 28px 0 8px; }
.muted { color: GrayText; margin: 0; }
.top { margin: 12px 0 0; font-weight: 600; }
.notice {
  margin: 12px 0 0;
  padding: 8px 12px;
  border: 1px solid Highlight;
  background: color-mix(in srgb, Highlight 15%, Canvas);
  color: CanvasText;
  border-radius: 6px;
}
.scroll {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
  border-radius: 6px;
}
table { border-collapse: collapse; width: 100%; background: Field; color: FieldText; }
th, td {
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
}
th { background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText; font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.state { font-weight: 600; }
.state-running { color: Highlight; }
.state-error { text-decoration: underline; }
.empty { margin: 0; padding: 4px 0; color: GrayText; }
</style>
</head>
<body>
<h1>Delegated work</h1>
<p class="muted" data-role="asof">Loading.</p>
<p class="notice" data-role="notice" hidden></p>
<main data-role="main"></main>
<script src="app.js"></script>
</body>
</html>
`

export const DASHBOARD_JS = `"use strict";
var REFRESH_MS = 5000;
var STATES = { running: "Running", completed: "Completed", error: "Error", aborted: "Aborted", unknown: "Unknown" };

function el(tag, text, className) {
  var node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function formatTime(iso) {
  var t = Date.parse(iso);
  return isNaN(t) ? "unknown time" : new Date(t).toLocaleString();
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "n/a";
  var s = Math.round(ms / 1000);
  if (s < 60) return s + " s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + " min " + (s % 60) + " s";
  var h = Math.floor(m / 60);
  return h + " h " + (m % 60) + " min";
}

function modelsText(served) {
  if (!served) return "not known yet";
  var names = Object.keys(served);
  if (!names.length) return "not known yet";
  return names.map(function (name) { return name + " (" + served[name] + (served[name] === 1 ? " call)" : " calls)"); }).join(", ");
}

function stateCell(outcome) {
  var td = el("td");
  td.appendChild(el("span", STATES[outcome] || "Unknown", "state state-" + (STATES[outcome] ? outcome : "unknown")));
  return td;
}

function table(columns, rows, emptyText) {
  if (!rows.length) return el("p", emptyText, "empty");
  var wrap = el("div", null, "scroll");
  var t = el("table");
  var head = el("tr");
  columns.forEach(function (c) { head.appendChild(el("th", c.label, c.num ? "num" : "")); });
  t.appendChild(el("thead")).appendChild(head);
  var body = el("tbody");
  rows.forEach(function (cells) {
    var tr = el("tr");
    cells.forEach(function (cell, i) {
      if (typeof cell === "object" && cell !== null) tr.appendChild(cell);
      else tr.appendChild(el("td", cell, columns[i].num ? "num" : ""));
    });
    body.appendChild(tr);
  });
  t.appendChild(body);
  wrap.appendChild(t);
  return wrap;
}

function section(title, content) {
  var s = el("section");
  s.appendChild(el("h2", title));
  s.appendChild(content);
  return s;
}

/** Pure: the same (data, now) always builds the same elements. */
function render(data, now) {
  var root = el("div");
  var count = data.busy === 1 ? "1 task running" : data.busy + " tasks running";
  root.appendChild(el("p", (data.boxRunning ? "Box running" : "Box stopped") + ". " + count + ". This bridge: " + data.bridge + ".", "top"));

  root.appendChild(section("Who is delegating", table(
    [{ label: "Bridge" }, { label: "Running", num: true }, { label: "Tasks, last 24 hours", num: true }, { label: "Tasks, last 7 days", num: true }],
    data.bridges.map(function (b) { return [b.bridge, b.running, b.last24h, b.last7d]; }),
    "No bridge has delegated work in the last 7 days.")));

  root.appendChild(section("Running now", table(
    [{ label: "Bridge" }, { label: "Repo" }, { label: "Model sent" }, { label: "Model served" }, { label: "Started" }, { label: "Last send" }, { label: "Sends", num: true }, { label: "Running for" }],
    data.running.map(function (r) {
      return [r.bridge, r.repo, r.requestedModel || "n/a", modelsText(r.servedModels), formatTime(r.startedAt), r.lastSendAt ? formatTime(r.lastSendAt) : "not sent", r.sendCount, formatDuration(now - Date.parse(r.startedAt))];
    }),
    "Nothing running.")));

  root.appendChild(section("Recent tasks", table(
    [{ label: "Started" }, { label: "Bridge" }, { label: "Repo" }, { label: "Model sent" }, { label: "Model served" }, { label: "State" }, { label: "Duration" }, { label: "Error" }, { label: "Work" }],
    data.recent.map(function (r) {
      var duration = r.outcome === "running" ? formatDuration(now - Date.parse(r.startedAt)) + " so far" : formatDuration(r.durationMs);
      return [formatTime(r.startedAt), r.bridge, r.repo, r.requestedModel || "n/a", r.servedModel || "not known", stateCell(r.outcome), duration, r.errorCode || "none", r.disposition];
    }),
    "No tasks in the last 7 days.")));

  root.appendChild(section("Models served (7 days)", table(
    [{ label: "Model" }, { label: "Calls", num: true }],
    data.servedModels.map(function (m) { return [m.model, m.calls]; }),
    "No served models recorded in the last 7 days.")));
  return root;
}

var main = document.querySelector("[data-role=main]");
var asOf = document.querySelector("[data-role=asof]");
var notice = document.querySelector("[data-role=notice]");
var lastGood = null;
var busy = false;

function show(data, now) {
  main.replaceChildren(render(data, now));
  asOf.textContent = "As of " + formatTime(data.asOf) + ". Updates every 5 seconds.";
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    var response = await fetch("data.json", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("status " + response.status);
    var data = await response.json();
    lastGood = data;
    show(data, Date.now());
    notice.hidden = true;
  } catch (error) {
    if (lastGood) {
      notice.textContent = "Not updated since " + formatTime(lastGood.asOf) + ". Showing the last data received.";
      notice.hidden = false;
    } else {
      notice.textContent = "No data yet. The bridge may have stopped.";
      notice.hidden = false;
    }
  } finally {
    busy = false;
  }
}

tick();
setInterval(tick, REFRESH_MS);
`
