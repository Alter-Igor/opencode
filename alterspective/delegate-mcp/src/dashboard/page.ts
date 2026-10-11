// #129 + iter-8 brand pass: the dashboard's static shell. Every byte here is a constant - the
// server never puts task data into it, and the client script (app.ts) builds all data elements with
// createElement + textContent, so a repo or model name is only ever text.
//
// Brand: Alterspective tokens (WEBSTA-001-UX-QUALITY-STANDARDS UX-BRAND-08a/08e - the page owns its
// own :root with the portal's literal values; nothing else in this file pair carries a hex).
// LOGO-001 left-aligned logo img, LOGO-003 the reversed wordmark on dark, LOGO-004 a real <img> at
// >=120px. ICON-001: the four hand-drawn brand icons (assets/*.svg, outlined vectors) are applied
// by CSS mask so they take the text colour of the theme. Fonts: the brand stack (Chronicle Display
// / Montserrat where the machine has them installed, documented fallbacks otherwise - UX-BRAND-07;
// self-hosted webfonts are a follow-up that carries the used-font probe UX-BRAND-07a requires).
// The four views (Overview / Tasks / Models / About) are static sections; the script shows exactly
// one at a time, so this is a small app, not one long page.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delegated work</title>
<style>
:root {
  color-scheme: light;
  --as-marine: #075156;
  --as-green: #2C8248;
  --as-citrus: #ABDD65;
  --as-navy: #17232D;
  --as-pale-blue: #E5EEEF;
  --as-white: #FFFFFF;
  --as-warning: #F59E0B;
  --as-error: #BA1A1A;
  --as-gray: #6B7280;
  --as-dark-1: #0f171d;
  --as-dark-2: #1a2530;
  --as-dark-text-1: #e5eeef;
  --as-dark-text-2: #d0d8dc;
  --surface: var(--as-white);
  --surface-muted: var(--as-pale-blue);
  --text-primary: var(--as-navy);
  --text-secondary: var(--as-gray);
  --accent: var(--as-marine);
  --text-danger: var(--as-error);
  --line: color-mix(in srgb, var(--as-navy) 18%, var(--as-white));
}
[data-theme="dark"] {
  color-scheme: dark;
  --surface: var(--as-dark-1);
  --surface-muted: var(--as-dark-2);
  --text-primary: var(--as-dark-text-1);
  --text-secondary: var(--as-dark-text-2);
  --accent: var(--as-green);
  --text-danger: color-mix(in srgb, var(--as-error) 55%, var(--as-dark-text-1));
  --line: color-mix(in srgb, var(--as-dark-text-1) 22%, var(--as-dark-1));
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --surface: var(--as-dark-1);
    --surface-muted: var(--as-dark-2);
    --text-primary: var(--as-dark-text-1);
    --text-secondary: var(--as-dark-text-2);
    --accent: var(--as-green);
    --text-danger: color-mix(in srgb, var(--as-error) 55%, var(--as-dark-text-1));
    --line: color-mix(in srgb, var(--as-dark-text-1) 22%, var(--as-dark-1));
  }
}
</style>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="bar">
  <img class="logo" data-role="logo" src="logo.png" alt="Alterspective" width="320" height="50">
  <h1>Delegated work</h1>
</header>
<nav class="tabs" data-role="tabs" aria-label="Dashboard views" role="tablist"></nav>
<p class="muted" data-role="asof">Loading.</p>
<p class="notice" data-role="notice" hidden></p>
<main>
  <section id="view-overview" data-view="overview" role="tabpanel" aria-labelledby="tab-overview"><div data-role="body-overview"></div></section>
  <section id="view-tasks" data-view="tasks" role="tabpanel" aria-labelledby="tab-tasks" hidden><div data-role="body-tasks"></div></section>
  <section id="view-models" data-view="models" role="tabpanel" aria-labelledby="tab-models" hidden><div data-role="body-models"></div></section>
  <section id="view-about" data-view="about" role="tabpanel" aria-labelledby="tab-about" hidden><div data-role="body-about"></div></section>
</main>
<script src="app.js"></script>
</body>
</html>
`
