// The dashboard's static brand files (src/dashboard/assets): logo PNGs and the four hand-drawn
// icon vectors. The registry is fixed here - names, MIME types, nothing else - so the server
// serves exactly this set and a request for any other name is the normal 404 (no path traversal,
// no extension inference). Contents are read at serve time with Bun.file; the files ship with the
// source, so there is no build step.
export type DashboardAsset = { readonly file: string; readonly type: string }

export const DASHBOARD_ASSETS: Record<string, DashboardAsset> = {
  "logo.png": { file: "assets/logo.png", type: "image/png" },
  "logo-reversed.png": { file: "assets/logo-reversed.png", type: "image/png" },
  "icon_sustain.svg": { file: "assets/icon_sustain.svg", type: "image/svg+xml; charset=utf-8" },
  "icon_build.svg": { file: "assets/icon_build.svg", type: "image/svg+xml; charset=utf-8" },
  "icon_validate.svg": { file: "assets/icon_validate.svg", type: "image/svg+xml; charset=utf-8" },
  "icon_discover.svg": { file: "assets/icon_discover.svg", type: "image/svg+xml; charset=utf-8" },
  "fonts/chronicle-display-roman.woff2": { file: "assets/fonts/chronicle-display-roman.woff2", type: "font/woff2" },
  "fonts/chronicle-display-semibold.woff2": { file: "assets/fonts/chronicle-display-semibold.woff2", type: "font/woff2" },
  "fonts/montserrat-regular.woff2": { file: "assets/fonts/montserrat-regular.woff2", type: "font/woff2" },
  "fonts/montserrat-medium.woff2": { file: "assets/fonts/montserrat-medium.woff2", type: "font/woff2" },
  "fonts/montserrat-semibold.woff2": { file: "assets/fonts/montserrat-semibold.woff2", type: "font/woff2" },
  "fonts/montserrat-bold.woff2": { file: "assets/fonts/montserrat-bold.woff2", type: "font/woff2" },
}
