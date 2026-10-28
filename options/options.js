import { DEFAULT_SITES, getSites, saveSites, getSettings, saveSettings, patternToRegExp } from "../src/config.js";

const $ = (id) => document.getElementById(id);
const SETTING_TEXT = ["omdbApiKey", "anthropicApiKey"];
const SETTING_BOOL = ["useAi", "showRottenTomatoes", "showMetacritic"];

function flash(el, text) {
  el.textContent = text;
  setTimeout(() => (el.textContent = ""), 4000);
}

// ---- settings ----

async function loadSettings() {
  const s = await getSettings();
  SETTING_TEXT.forEach((k) => ($(k).value = s[k]));
  SETTING_BOOL.forEach((k) => ($(k).checked = s[k]));
}

$("saveSettings").addEventListener("click", async () => {
  const s = {};
  SETTING_TEXT.forEach((k) => (s[k] = $(k).value.trim()));
  SETTING_BOOL.forEach((k) => (s[k] = $(k).checked));
  await saveSettings(s);
  flash($("settingsStatus"), "Saved. Reload streaming tabs to apply.");
});

$("clearCache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearCache" });
  flash($("settingsStatus"), "Cache cleared.");
});

// ---- sites ----

function renderSite(site) {
  const node = $("siteTpl").content.firstElementChild.cloneNode(true);
  node.dataset.id = site.id;
  node.querySelector(".f-enabled").checked = site.enabled;
  node.querySelector(".f-name").value = site.name;
  node.querySelector(".f-matches").value = site.matches.join("\n");
  node.querySelector(".f-cardSelector").value = site.cardSelector ?? "";
  node.querySelector(".f-titleAttr").value = site.titleAttr ?? "";
  node.querySelector(".f-titleSelector").value = site.titleSelector ?? "";
  node.querySelector(".remove").addEventListener("click", () => node.remove());
  $("sites").appendChild(node);
}

function readSites() {
  return [...$("sites").children].map((node) => {
    const name = node.querySelector(".f-name").value.trim() || "Untitled";
    return {
      id: node.dataset.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36),
      name,
      enabled: node.querySelector(".f-enabled").checked,
      matches: node.querySelector(".f-matches").value.split(/\s+/).filter(Boolean),
      cardSelector: node.querySelector(".f-cardSelector").value.trim(),
      titleAttr: node.querySelector(".f-titleAttr").value.trim(),
      titleSelector: node.querySelector(".f-titleSelector").value.trim(),
    };
  });
}

async function loadSites() {
  $("sites").replaceChildren();
  (await getSites()).forEach(renderSite);
}

$("addSite").addEventListener("click", () => {
  renderSite({ id: "", name: "", enabled: true, matches: [], cardSelector: "", titleAttr: "", titleSelector: "" });
  $("sites").lastElementChild.querySelector(".f-name").focus();
});

$("saveSites").addEventListener("click", async () => {
  const sites = readSites();
  const bad = sites.flatMap((s) => s.matches).filter((p) => !patternToRegExp(p));
  if (bad.length) return flash($("sitesStatus"), `Invalid match pattern: ${bad[0]}`);
  for (const s of sites) {
    if (s.cardSelector) {
      try { document.querySelector(s.cardSelector); } catch { return flash($("sitesStatus"), `Invalid selector for ${s.name}`); }
    }
  }

  // Ask for access to the sites first, while we still have the click's user gesture.
  const origins = [...new Set(sites.filter((s) => s.enabled).flatMap((s) => s.matches))];
  const granted = origins.length ? await chrome.permissions.request({ origins }) : true;
  await saveSites(sites);
  await chrome.runtime.sendMessage({ type: "syncScripts" });
  flash($("sitesStatus"), granted ? "Saved. Reload open tabs on these sites." : "Saved, but site access was not granted, so some sites stay off.");
});

$("resetSites").addEventListener("click", async () => {
  await saveSites(DEFAULT_SITES);
  await loadSites();
  flash($("sitesStatus"), "Defaults restored.");
});

async function loadUsage() {
  const u = await chrome.runtime.sendMessage({ type: "getUsage" });
  $("usage").textContent = `OMDb requests today: ${u.today} / 1,000` + (u.blocked ? " (limit reached, pausing for an hour)" : "");
}

loadSettings();
loadSites();
loadUsage();
