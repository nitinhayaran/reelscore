// Default site whitelist and settings. Users edit these from the options page.
//
// A site entry:
//   id            stable identifier
//   name          display name
//   matches       Chrome match patterns where the content script runs
//   cardSelector  optional CSS selector for one movie/show card. Empty = generic detection.
//   titleSelector optional CSS selector (inside the card) whose text/attr holds the title
//   titleAttr     optional attribute to read the title from (on the card or titleSelector match)
//   enabled       on/off switch

export const DEFAULT_SITES = [
  {
    id: "netflix",
    name: "Netflix",
    matches: ["*://*.netflix.com/*"],
    // Logged-in cards link to "/browse?jbv=<id>"; logged-out pages use data-uia="titleId-<id>".
    cardSelector: "a[href*='jbv='][aria-label], a[data-uia^='titleId-'][aria-label]",
    titleSelector: "",
    titleAttr: "aria-label",
    enabled: true,
  },
  {
    id: "primevideo",
    name: "Prime Video",
    matches: [
      "*://*.primevideo.com/*",
      "*://*.amazon.com/gp/video/*",
      "*://*.amazon.in/gp/video/*",
      "*://*.amazon.co.uk/gp/video/*",
    ],
    // Landscape cards: real titles carry an entity type (Movie / TV Show); language and genre tiles don't.
    // Vertical poster rows ("Featured Originals") use super-carousel cards with the title in aria-label.
    cardSelector: "[data-card-title][data-card-entity-type], article[data-testid='super-carousel-card']",
    titleSelector: "",
    titleAttr: "data-card-title",
    enabled: true,
  },
  {
    id: "hotstar",
    name: "Hotstar",
    matches: ["*://*.hotstar.com/*", "*://*.jiohotstar.com/*"],
    cardSelector: "",
    titleSelector: "",
    titleAttr: "",
    enabled: true,
  },
];

export const DEFAULT_SETTINGS = {
  omdbApiKey: "",
  anthropicApiKey: "",
  useAi: true,
  showRottenTomatoes: true,
  showMetacritic: false,
};

// Selectors that earlier versions shipped as defaults. A saved site still using one of
// these gets the current default on update; selectors the user typed are left alone.
const OLD_DEFAULT_SELECTORS = {
  netflix: [
    ".title-card a[aria-label], a.slider-refocus[aria-label], .nm-collections-title",
    ".title-card a[aria-label], a.slider-refocus[aria-label], a[data-uia^='titleId-'][aria-label]",
  ],
  primevideo: ["[data-card-title]", "[data-card-title][data-card-entity-type]"],
};

export async function migrateSites() {
  const { sites } = await chrome.storage.sync.get("sites");
  if (!sites) return;
  let changed = false;
  for (const site of sites) {
    const def = DEFAULT_SITES.find((d) => d.id === site.id);
    if (def && OLD_DEFAULT_SELECTORS[site.id]?.includes(site.cardSelector)) {
      site.cardSelector = def.cardSelector;
      changed = true;
    }
  }
  if (changed) await saveSites(sites);
}

export async function getSites() {
  const { sites } = await chrome.storage.sync.get("sites");
  return sites ?? DEFAULT_SITES;
}

export async function saveSites(sites) {
  await chrome.storage.sync.set({ sites });
}

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

// Turns a match pattern like "*://*.netflix.com/*" into a regex that tests a URL.
export function patternToRegExp(pattern) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const [, scheme, host, path] = m;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : scheme;
  const hostRe = host === "*" ? "[^/]+" : host.startsWith("*.")
    ? `(?:[^/]+\\.)?${esc(host.slice(2))}`
    : esc(host);
  const pathRe = path.split("*").map(esc).join(".*");
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

export function siteForUrl(sites, url) {
  return sites.find((s) => s.matches.some((p) => patternToRegExp(p)?.test(url)));
}
