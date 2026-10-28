import { getSites, saveSites, getSettings, siteForUrl } from "../src/config.js";

const $ = (id) => document.getElementById(id);
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await getSettings();
  $("keyWarn").hidden = !!settings.omdbApiKey;

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    $("status").textContent = "Open a streaming site to see ratings.";
    return;
  }
  if (!/^https?:$/.test(url.protocol)) {
    $("status").textContent = "Open a streaming site to see ratings.";
    return;
  }

  const sites = await getSites();
  const site = siteForUrl(sites, tab.url);
  const toggle = $("toggle");
  toggle.hidden = false;

  if (site) {
    $("status").textContent = `${site.name} is in your list (${site.enabled ? "on" : "off"}).`;
    toggle.textContent = site.enabled ? `Turn off for ${site.name}` : `Turn on for ${site.name}`;
    toggle.addEventListener("click", async () => {
      if (!site.enabled && !(await chrome.permissions.request({ origins: site.matches }))) return;
      site.enabled = !site.enabled;
      await saveSites(sites);
      if (site.enabled) await inject(tab.id);
      else chrome.tabs.reload(tab.id);
      window.close();
    });
  } else {
    const host = url.hostname.replace(/^www\./, "");
    $("status").textContent = `${host} isn't in your list.`;
    toggle.textContent = `Add ${host}`;
    toggle.addEventListener("click", async () => {
      const matches = [`*://*.${host}/*`];
      if (!(await chrome.permissions.request({ origins: matches }))) return;
      sites.push({
        id: host.replace(/[^a-z0-9]+/gi, "-") + "-" + Date.now().toString(36),
        name: host,
        matches,
        cardSelector: "",
        titleSelector: "",
        titleAttr: "",
        enabled: true,
      });
      await saveSites(sites);
      await inject(tab.id);
      window.close();
    });
  }
}

init();
