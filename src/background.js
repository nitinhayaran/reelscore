import { getSites, getSettings, siteForUrl, migrateSites } from "./config.js";
import { lookupTitle, clearCache, normalizeKey, OmdbError, isBlocked, getUsage } from "./ratings.js";
import { normalizeTitles } from "./llm.js";

const SCRIPT_ID_PREFIX = "wr-";

// Register the content script for every enabled site we have host permission for.
// Called on install/startup and whenever the site list or permissions change.
// Calls are chained so two overlapping syncs can't register the same script id twice.
let syncChain = Promise.resolve();
function syncContentScripts() {
  syncChain = syncChain.then(doSync).catch((e) => console.error("[Reelscore] sync failed:", e));
  return syncChain;
}

async function doSync() {
  const sites = await getSites();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.filter((s) => s.id.startsWith(SCRIPT_ID_PREFIX)).map((s) => s.id);
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });

  const scripts = [];
  for (const site of sites) {
    if (!site.enabled || !site.matches.length) continue;
    const granted = await chrome.permissions.contains({ origins: site.matches });
    if (!granted) continue;
    scripts.push({
      id: SCRIPT_ID_PREFIX + site.id,
      matches: site.matches,
      js: ["src/content.js"],
      css: ["src/content.css"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    });
  }
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "update") await migrateSites();
  await syncContentScripts();
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.sites) syncContentScripts();
});

// items: [{ raw, context }] from one content-script batch.
// Returns [{ rating | null, error? }] in the same order.
// useAi false runs only the direct lookups, so the page can show those badges at once;
// the page then sends the misses again with useAi true.
async function rateBatch(items, siteName, useAi) {
  const settings = await getSettings();
  if (!settings.omdbApiKey) return { error: "NO_OMDB_KEY" };

  const results = new Array(items.length).fill(null);
  try {
    // Pass 1: direct lookup of the cleaned title from the page.
    const misses = [];
    await Promise.all(items.map(async (it, i) => {
      results[i] = await lookupTitle({ title: it.raw, year: it.year, type: it.type }, settings.omdbApiKey);
      if (!results[i]) misses.push(i);
    }));

    // Pass 2: ask the model to clean up titles that missed, then retry.
    // Skipped while OMDb is out of requests: the retries couldn't run anyway.
    if (useAi && misses.length && !(await isBlocked())) {
      const guessKey = (i) => "g:" + normalizeKey(items[i].raw);
      const store = await chrome.storage.local.get(misses.map(guessKey));
      const todo = misses.filter((i) => !(guessKey(i) in store));
      if (todo.length) {
        try {
          const guesses = await normalizeTitles(
            todo.map((i) => ({ ...items[i], site: siteName })), settings);
          if (settings.useAi && settings.anthropicApiKey) {
            await chrome.storage.local.set(Object.fromEntries(todo.map((i, j) => [guessKey(i), guesses[j]])));
          }
          todo.forEach((i, j) => (store[guessKey(i)] = guesses[j]));
        } catch (e) {
          console.warn("[Reelscore] title cleanup failed:", e);
        }
      }
      await Promise.all(misses.map(async (i) => {
        const g = store[guessKey(i)];
        if (g?.title) results[i] = await lookupTitle(g, settings.omdbApiKey);
      }));
    }
  } catch (e) {
    if (e instanceof OmdbError) return { error: e.message };
    throw e;
  }
  return {
    results,
    notice: (await isBlocked()) ? "OMDb's daily limit is reached. Showing saved ratings; new titles will load later." : undefined,
    settings: { showRottenTomatoes: settings.showRottenTomatoes, showMetacritic: settings.showMetacritic },
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "getSiteConfig": {
        const sites = await getSites();
        return siteForUrl(sites, msg.url) ?? null;
      }
      case "rate":
        return rateBatch(msg.items, msg.siteName, msg.useAi !== false);
      case "getUsage":
        return getUsage();
      case "clearCache":
        await clearCache();
        return { ok: true };
      case "syncScripts":
        await syncContentScripts();
        return { ok: true };
      case "openOptions":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});
