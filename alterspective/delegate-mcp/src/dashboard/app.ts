// The dashboard client script (served at app.js). Like the page shell it is a constant string:
// task data arrives only through data.json, and every data element is built with createElement and
// textContent, so a repo, model or caller name is only ever text, never markup.
// iter-8 (brand pass): four views - Overview / Tasks / Models / About - behind a tablist, so this
// is a small app, not one long page; a theme cycle (system -> light -> dark) kept in localStorage,
// with the reversed logo on dark; the hand-drawn brand icons are applied by CSS mask (currentColor)
// so they follow the theme. One setInterval in total: the 5-second tick. render/renderView/
// formatDuration stay pure, and boot() only wires the page when the real DOM answers (a tab strip
// whose elements carry addEventListener), so the tests can run render() against a DOM double.
export const DASHBOARD_APP_JS = `"use strict";
var REFRESH_MS = 5000;
var VIEWS = [
  { id: "overview", label: "Overview", icon: "icon_sustain" },
  { id: "tasks", label: "Tasks", icon: "icon_build" },
  { id: "models", label: "Models", icon: "icon_validate" },
  { id: "about", label: "About", icon: "icon_discover" }
];
var THEMES = ["system", "light", "dark"];
var STATES = { running: "Running", completed: "Completed", error: "Error", aborted: "Aborted", unknown: "Unknown" };

function el(tag, text, className) {
  var node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function icon(name) {
  var span = el("span", null, "tabicon");
  span.setAttribute("aria-hidden", "true");
  span.style.setProperty("--icon", 'url("' + name + '.svg")');
  return span;
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

function minutesText(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "n/a";
  var m = ms / 60000;
  return (m < 0.1 ? m.toFixed(2) : m < 10 ? m.toFixed(1) : Math.round(m)) + " min";
}

function percentText(fraction) {
  if (typeof fraction !== "number" || !isFinite(fraction)) return "n/a";
  return Math.round(fraction * 100) + "%";
}

function formatTokensK(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0k";
  var k = n / 1000;
  return (k < 10 ? k.toFixed(1) : Math.round(k)) + "k";
}

function rateBar(rate) {
  var wrap = el("td");
  if (rate === null || typeof rate !== "number" || !isFinite(rate)) {
    wrap.appendChild(el("span", null, "bar-none"));
    wrap.appendChild(el("span", " no data yet", "muted"));
    return wrap;
  }
  var cls = rate >= 0.85 ? "good" : rate >= 0.6 ? "mid" : "bad";
  var bar = el("span", null, "track");
  var fill = el("span", null, "fill fill-" + cls);
  fill.style.width = Math.round(rate * 100) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);
  wrap.appendChild(el("span", " " + percentText(rate), "muted"));
  return wrap;
}

function kindBadge(kind) {
  if (kind === "requested-only") {
    var b = el("span", "re-routed", "badge badge-rerouted");
    b.title = "Requested but never served - Synapse re-routed or 404'd it. The routing-health signal.";
    return b;
  }
  return el("span", "served", "badge");
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
  var s = el("div");
  s.appendChild(el("h2", title));
  s.appendChild(content);
  return s;
}

function statusLine(data, now) {
  var count = data.busy === 1 ? "1 task running" : data.busy + " tasks running";
  var p = el("p", null, "top");
  var dot = el("span", null, "status " + (data.boxRunning ? "status-run" : "status-down"));
  dot.setAttribute("aria-hidden", "true");
  p.appendChild(dot);
  p.appendChild(el("span", (data.boxRunning ? "Box running" : "Box stopped") + ". " + count + ". This bridge: " + data.bridge + "."));
  return p;
}

function callersSection(data) {
  return section("Who is delegating", table(
    [{ label: "Session (project folder)" }, { label: "Running", num: true }, { label: "Tasks, last 24 hours", num: true }, { label: "Tasks, last 7 days", num: true }],
    data.callers.map(function (c) { return [c.who, c.running, c.last24h, c.last7d]; }),
    "No session has delegated work in the last 7 days."));
}

function runningSection(data, now) {
  return section("Running now", table(
    [{ label: "Session" }, { label: "Bridge" }, { label: "Repo" }, { label: "Model sent" }, { label: "Model served" }, { label: "Started" }, { label: "Last send" }, { label: "Sends", num: true }, { label: "Running for" }],
    data.running.map(function (r) {
      return [r.caller || "n/a", r.bridge, r.repo, r.requestedModel || "n/a", modelsText(r.servedModels), formatTime(r.startedAt), r.lastSendAt ? formatTime(r.lastSendAt) : "not sent", r.sendCount, formatDuration(now - Date.parse(r.startedAt))];
    }),
    "Nothing running."));
}

function recentSection(data, now) {
  return section("Recent tasks", table(
    [{ label: "Started" }, { label: "Session" }, { label: "Bridge" }, { label: "Repo" }, { label: "Model sent" }, { label: "Model served" }, { label: "State" }, { label: "Duration" }, { label: "Error" }, { label: "Work" }],
    data.recent.map(function (r) {
      var duration = r.outcome === "running" ? formatDuration(now - Date.parse(r.startedAt)) + " so far" : formatDuration(r.durationMs);
      return [formatTime(r.startedAt), r.caller || "n/a", r.bridge, r.repo, r.requestedModel || "n/a", r.servedModel || "not known", stateCell(r.outcome), duration, r.errorCode || "none", r.disposition];
    }),
    "No tasks in the last 7 days."));
}

function servedSection(data) {
  return section("Models served (7 days)", table(
    [{ label: "Model" }, { label: "Calls", num: true }],
    data.servedModels.map(function (m) { return [m.model, m.calls]; }),
    "No served models recorded in the last 7 days."));
}

function scorecardSection(data) {
  var card = data.scorecard;
  var score = section("Model scorecard (30 days)", table(
    [{ label: "Model" }, { label: "Rate" }, { label: "Tasks", num: true }, { label: "Err", num: true }, { label: "Median", num: true }, { label: "P90", num: true }, { label: "Tok in", num: true }, { label: "Repos", num: true }],
    card.models.map(function (m) {
      var model = el("td", m.model);
      model.appendChild(kindBadge(m.kind));
      var finished = m.completed + m.error + m.aborted + m.unknown;
      return [model, rateBar(m.successRate), m.tasks.toFixed(1), percentText(finished > 0 ? m.error / finished : 0), minutesText(m.medianMs), minutesText(m.p90Ms), formatTokensK(m.tokensIn), m.repos];
    }),
    "No model activity in the last 30 days."));
  score.appendChild(el("p", "Models are grouped by the share of calls they served. 'Re-routed' rows are asks Synapse did not serve (e.g. a retired or unserved model) - the owner's on-prem tuning signal.", "muted"));
  return score;
}

function aboutSection(data) {
  var s = el("div");
  s.appendChild(el("h2", "About this page"));
  var ul = el("ul", null, "about");
  ul.appendChild(el("li", "Bridge: " + data.bridge + "."));
  ul.appendChild(el("li", "Box: " + (data.boxRunning ? "running" : "not running (this page never starts it)") + "."));
  ul.appendChild(el("li", "As of " + formatTime(data.asOf) + " - " + data.busy + " running now, " + data.recent.length + " recent rows shown, " + data.scorecard.tasks + " tasks in the 30-day scorecard."));
  ul.appendChild(el("li", "This page is local (127.0.0.1), read-only, and stops when the bridge stops. It shows host-side task records only: no prompts, no code."));
  s.appendChild(ul);
  return s;
}

/** Pure: the same (view, data, now) always builds the same elements. */
function renderView(view, data, now) {
  var root = el("div");
  if (view === "tasks") {
    root.appendChild(runningSection(data, now));
    root.appendChild(recentSection(data, now));
  } else if (view === "models") {
    root.appendChild(servedSection(data));
    root.appendChild(scorecardSection(data));
  } else if (view === "about") {
    root.appendChild(aboutSection(data));
  } else {
    root.appendChild(statusLine(data, now));
    root.appendChild(callersSection(data));
    var run = data.running.length;
    root.appendChild(el("p", run === 1 ? "1 task is running now - open the Tasks view for detail." : run + " tasks are running now - open the Tasks view for detail.", "muted"));
  }
  return root;
}

/** All four views in order; show() spreads them over the page's static panels. */
function render(data, now) {
  var root = el("div");
  VIEWS.forEach(function (v) { root.appendChild(renderView(v.id, data, now)); });
  return root;
}

function boot() {
  var tabsBar = document.querySelector("[data-role=tabs]");
  if (!tabsBar || typeof tabsBar.addEventListener !== "function") return;
  var bodies = {};
  var panels = {};
  VIEWS.forEach(function (v) {
    bodies[v.id] = document.querySelector("[data-role=body-" + v.id + "]");
    panels[v.id] = document.querySelector("#view-" + v.id);
  });
  var asOf = document.querySelector("[data-role=asof]");
  var notice = document.querySelector("[data-role=notice]");
  var logo = document.querySelector("[data-role=logo]");
  var lastGood = null;
  var busy = false;
  var active = "overview";
  var theme = "system";
  try {
    var stored = typeof localStorage !== "undefined" ? localStorage.getItem("oc-dash-theme") : null;
    if (THEMES.indexOf(stored) >= 0) theme = stored;
  } catch (e) {}

  function darkActive() {
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function show(data, now) {
    VIEWS.forEach(function (v) {
      if (bodies[v.id]) bodies[v.id].replaceChildren(renderView(v.id, data, now));
      if (panels[v.id]) panels[v.id].hidden = v.id !== active;
    });
    asOf.textContent = "As of " + formatTime(data.asOf) + ". Updates every 5 seconds.";
  }

  function applyTheme() {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    if (logo) logo.setAttribute("src", darkActive() ? "logo-reversed.png" : "logo.png");
    themeButton.textContent = "Theme: " + theme;
  }

  var themeButton = el("button", null, "theme");
  themeButton.setAttribute("aria-label", "Colour theme");
  themeButton.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { if (typeof localStorage !== "undefined") localStorage.setItem("oc-dash-theme", theme); } catch (e) {}
    applyTheme();
  });

  function setActive(id, focus) {
    active = id;
    VIEWS.forEach(function (v, i) {
      var b = tabsBar.children[i];
      var selected = v.id === id;
      b.className = "tab" + (selected ? " tab-active" : "");
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("tabindex", selected ? "0" : "-1");
      if (panels[v.id]) panels[v.id].hidden = !selected;
      if (focus && selected && typeof b.focus === "function") b.focus();
    });
    if (lastGood) show(lastGood, Date.now());
  }

  VIEWS.forEach(function (v, i) {
    var b = el("button", null, "tab" + (v.id === active ? " tab-active" : ""));
    b.id = "tab-" + v.id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", v.id === active ? "true" : "false");
    b.setAttribute("aria-controls", "view-" + v.id);
    b.setAttribute("tabindex", v.id === active ? "0" : "-1");
    b.appendChild(icon(v.icon));
    b.appendChild(el("span", v.label));
    b.addEventListener("click", function () { setActive(v.id, false); });
    b.addEventListener("keydown", function (event) {
      var dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (dir) setActive(VIEWS[(i + dir + VIEWS.length) % VIEWS.length].id, true);
    });
    tabsBar.appendChild(b);
  });
  tabsBar.appendChild(themeButton);

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

  applyTheme();
  tick();
  setInterval(tick, REFRESH_MS);
}

boot();
`;
