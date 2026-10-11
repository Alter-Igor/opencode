// The dashboard stylesheet. A constant string served at styles.css - like page.ts it never carries
// task data. Zero hex literals here by design (test-enforced): every colour comes from the tokens
// declared in the page's own :root (WEBSTA-001-UX-QUALITY-STANDARDS UX-BRAND-08a - the six brand
// constants never redefined per theme; only the semantic tokens swap), so the file is theme-safe
// and the contrast rules are stated once. Colour is never the only signal: state cells pair colour
// with text and weight, the rate number is always printed beside its bar, and the re-routed row
// keeps a dashed border (UX-AX-06). Motion: transitions are the brand's 150-200 ms and are clamped
// under prefers-reduced-motion (portal /motion).
// Brand type (UX-BRAND-07a): the page declares its own first-party @font-face from files served on
// this same token-gated server (assets/fonts/, woff2 cuts of the licensed .otf/.ttf from the brand
// guide - never inherited from a third-party stylesheet). Chronicle Display only at 400/600 and
// only for the 36px+ heading; Montserrat 400/500/600/700 for everything else (TYPO-002/003).
export const DASHBOARD_CSS = `
@font-face { font-family: "Chronicle Display"; src: url("fonts/chronicle-display-roman.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "Chronicle Display"; src: url("fonts/chronicle-display-semibold.woff2") format("woff2"); font-weight: 600; font-style: normal; font-display: swap; }
@font-face { font-family: "Montserrat"; src: url("fonts/montserrat-regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "Montserrat"; src: url("fonts/montserrat-medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: "Montserrat"; src: url("fonts/montserrat-semibold.woff2") format("woff2"); font-weight: 600; font-style: normal; font-display: swap; }
@font-face { font-family: "Montserrat"; src: url("fonts/montserrat-bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
* { box-sizing: border-box; }
html, body { margin: 0; max-width: 100%; overflow-x: hidden; }
body {
  padding: 0 16px 32px;
  background: var(--surface);
  color: var(--text-primary);
  font-family: "Montserrat", "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.45;
}
.bar { display: flex; align-items: center; gap: 16px; margin-top: 16px; }
.logo { height: 40px; width: auto; }
h1 {
  font-family: "Chronicle Display", Georgia, serif;
  font-size: 40px;
  font-weight: 600;
  line-height: 1.1;
  margin: 0;
}
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 16px; border-bottom: 1px solid var(--line); }
.tab {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 44px; padding: 8px 16px;
  background: none; border: 0; border-bottom: 3px solid transparent;
  color: var(--text-secondary); font: inherit; font-weight: 500; cursor: pointer;
  transition: color 150ms cubic-bezier(0.2, 0, 0, 1), border-color 200ms cubic-bezier(0.2, 0, 0, 1);
}
.tab:hover { color: var(--text-primary); }
.tab-active { color: var(--text-primary); border-bottom-color: var(--accent); font-weight: 600; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.tabicon, .mark {
  display: inline-block; width: 20px; height: 20px; flex: none;
  background-color: currentColor;
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
}
.theme { margin-left: auto; min-height: 44px; padding: 8px 12px; background: none; border: 1px solid var(--line); border-radius: 8px; color: var(--text-secondary); font: inherit; cursor: pointer; }
.theme:hover { color: var(--text-primary); }
.muted { color: var(--text-secondary); margin: 0; }
.top { margin: 12px 0 0; font-weight: 600; }
.status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: var(--text-secondary); margin-right: 6px; }
.status-run { background-color: var(--accent); }
.status-down { background-color: var(--text-danger); }
.notice {
  margin: 12px 0 0; padding: 8px 12px;
  border: 1px solid var(--as-warning);
  background: color-mix(in srgb, var(--as-warning) 15%, var(--surface));
  color: var(--text-primary);
  border-radius: 8px;
}
section[hidden] { display: none; }
h2 { font-size: 17px; font-weight: 600; margin: 28px 0 8px; }
.scroll {
  max-width: 100%; overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}
table { border-collapse: collapse; width: 100%; background: var(--surface); color: var(--text-primary); }
th, td {
  padding: 6px 10px; text-align: left; vertical-align: top; white-space: nowrap;
  border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 12%, var(--surface));
}
th { background: var(--surface-muted); color: var(--text-primary); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.state { font-weight: 600; }
.state-running { color: var(--accent); }
.state-error { color: var(--text-danger); text-decoration: underline; }
.empty { margin: 0; padding: 4px 0; color: var(--text-secondary); }
.badge {
  border: 1px solid color-mix(in srgb, var(--text-primary) 40%, var(--surface));
  border-radius: 4px; padding: 0 6px; margin-left: 6px;
  color: var(--text-secondary); white-space: nowrap;
}
.badge-rerouted { border-style: dashed; font-weight: 600; color: var(--text-primary); background: var(--surface-muted); }
.track {
  display: inline-block; vertical-align: middle;
  width: 90px; height: 8px; border-radius: 4px;
  border: 1px solid var(--line); background: var(--surface-muted);
}
.fill { display: block; height: 100%; border-radius: 4px; }
.fill-good { background-color: var(--as-green); }
.fill-mid { background-color: var(--as-warning); }
.fill-bad { background-color: var(--as-error); }
.bar-none { display: inline-block; vertical-align: middle; width: 90px; height: 8px; border-radius: 4px; border: 1px dashed var(--line); }
.about { margin: 8px 0 0; }
.about li { margin: 6px 0; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`
