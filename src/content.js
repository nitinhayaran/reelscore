// Finds movie/show cards on the page, reads their titles, and adds a rating badge.
// Runs on every site in the whitelist. Site entries can give exact selectors;
// without them, generic detection looks for poster-sized images and labelled cards.

(() => {
  if (window.__reelscoreLoaded) return;

  const DONE = "data-wr-done";
  const BATCH_SIZE = 20;
  const JUNK = /^(image|img|poster|thumbnail|logo|banner|icon|avatar|profile|play|close|menu|search|home|ad|advertisement|loading|featured|trending|recommended|popular|more like this|see all|view all)\b/i;
  // Category tiles ("Hindi", "Comedy") whose label would otherwise match some unrelated film on OMDb.
  const CATEGORY = new Set([
    "hindi", "english", "tamil", "telugu", "malayalam", "kannada", "bengali", "bangla", "marathi", "punjabi",
    "gujarati", "odia", "urdu", "spanish", "korean", "japanese", "french", "german", "italian", "chinese",
    "arabic", "turkish", "portuguese", "thai", "indonesian", "action", "adventure", "comedy", "drama",
    "horror", "thriller", "romance", "romantic", "crime", "mystery", "fantasy", "sci-fi", "science fiction",
    "documentary", "documentaries", "anime", "animation", "kids", "family", "sports", "music", "reality",
    "movies", "tv shows", "shows", "series", "originals", "live tv", "channels", "news",
  ]);
  // Live matches ("Baroda vs Jammu and Kashmir: Day 3") and highlight reels.
  const SPORT = /\bvs?\.?\s.+:\s*(day|match|game|innings|leg)\b|\bhighlights\b/i;
  // Links to clips, live streams and trailers rather than to a movie or show.
  const SKIP_HREF = /\/(live|clips?|trailers?|sports?|highlights)(\/|\?|$)/i;
  // Player routes: Hotstar ".../watch", Netflix "/watch/<id>".
  const PLAYER_PATH = /\/(watch|play|player)(\/|$)/i;

  let site = null;
  const resultCache = new Map(); // normalized title -> Promise<rating|null>
  const queue = [];
  let flushTimer = null;
  let errorShown = false;

  // ---- title extraction ----

  function cleanTitle(raw) {
    let t = raw.replace(/\s+/g, " ").trim();
    t = t.replace(/^(go to|watch|play|resume|continue watching|more info(?: about)?|details(?: for)?|trailer)\s*[:\-–]?\s+/i, "");
    let year;
    const ym = t.match(/\(((?:19|20)\d{2})\)/);
    if (ym) {
      year = ym[1];
      t = t.replace(ym[0], " ");
    }
    // Hotstar-style labels: "Billions, Show, Season 3, Episode 10, Next Episode".
    let type, skip = false;
    const tm = t.match(/^(.+?),\s*(show|series|movie|film|clip|episode|live|channel|match|trailer|highlights?)\b(?:,.*)?$/i);
    if (tm) {
      t = tm[1];
      const kind = tm[2].toLowerCase();
      if (kind === "show" || kind === "series") type = "series";
      else if (kind === "movie" || kind === "film") type = "movie";
      else skip = true;
    }
    if (SPORT.test(t)) skip = true;
    t = t
      .replace(/\s*[-–:|,]\s*(season|series|s|part|vol\.?|volume)\s*\d+.*$/i, "")
      .replace(/\s+(season|s)\s*\d+(\s*e\d+)?\b.*$/i, "")
      .replace(/\s*\|.*$/, "")
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { title: t, year, type, skip };
  }

  function isPlausible(title) {
    if (!title || title.length < 2 || title.length > 100) return false;
    if (JUNK.test(title) || CATEGORY.has(title.toLowerCase().replace(/^(watch )?in /, ""))) return false;
    if (site && title.toLowerCase() === site.name.toLowerCase()) return false;
    return /\p{L}|\d/u.test(title);
  }

  function readRawTitle(card) {
    if (site.titleSelector) {
      const el = card.querySelector(site.titleSelector);
      if (el) return (site.titleAttr && el.getAttribute(site.titleAttr)) || el.textContent;
    }
    if (site.titleAttr && card.hasAttribute(site.titleAttr)) return card.getAttribute(site.titleAttr);
    const attrs = ["data-card-title", "aria-label", "title"];
    for (const a of attrs) {
      const v = card.getAttribute(a);
      if (v) return v;
    }
    const labelled = card.querySelector("[data-card-title], [aria-label]");
    if (labelled) return labelled.getAttribute("data-card-title") || labelled.getAttribute("aria-label");
    const img = card.tagName === "IMG" ? card : card.querySelector("img[alt]");
    if (img?.alt) return img.alt;
    return card.textContent;
  }

  function typeHint(card) {
    const t = (card.getAttribute("data-card-entity-type") || "").toLowerCase();
    if (t.includes("movie")) return "movie";
    if (t.includes("tv") || t.includes("show") || t.includes("series")) return "series";
    return undefined;
  }

  // ---- card discovery ----

  const CHROME_AREAS = "header, nav, footer, [role=banner], [role=navigation]";
  const LABELLED_LINK = "a[aria-label], [role=link][aria-label]";

  function isPosterImage(img, needAlt = true) {
    const r = img.getBoundingClientRect();
    const w = r.width || img.naturalWidth;
    const h = r.height || img.naturalHeight;
    // Small thumbnails (carousel indicators, avatars) are too small for a badge.
    return w >= 100 && h >= 56 && w <= 900 && (!needAlt || !!img.alt?.trim());
  }

  function genericCards(root) {
    const out = new Set();
    root.querySelectorAll("[data-card-title]").forEach((e) => out.add(e));
    // Links labelled with the title around a poster (Netflix style, where the image alt is empty).
    root.querySelectorAll(LABELLED_LINK).forEach((el) => {
      if (el.closest(CHROME_AREAS)) return;
      const img = el.querySelector("img");
      if (img && isPosterImage(img, false)) out.add(el);
    });
    root.querySelectorAll("img[alt]").forEach((img) => {
      if (img.closest(CHROME_AREAS)) return;
      if (!isPosterImage(img)) return;
      if (img.closest("[data-card-title]") || out.has(img.closest(LABELLED_LINK))) return;
      // The card is the nearest interactive wrapper of the poster, else the image's parent.
      const wrap = img.closest("a, [role=link], [role=button], [tabindex], article, li") ?? img.parentElement;
      out.add(wrap && wrap.contains(img) && wrap !== document.body ? wrap : img.parentElement);
    });
    return [...out];
  }

  function findCards(root) {
    if (site.cardSelector) {
      try {
        return [...root.querySelectorAll(site.cardSelector)];
      } catch {
        console.warn("[Reelscore] bad card selector:", site.cardSelector);
      }
    }
    return genericCards(root);
  }

  // The badge sits in the top-left of the card's poster area.
  function badgeHost(card) {
    if (card.tagName === "IMG") return card.parentElement;
    return card.querySelector("[data-testid=packshot]") ?? card;
  }

  // ---- rating requests ----

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      enqueue(e.target);
    }
  }, { rootMargin: "300px" });

  // Badges are for browsing: hide them while a title plays (player page or fullscreen)
  // and stop looking for cards there.
  function isWatching() {
    return !!document.fullscreenElement || PLAYER_PATH.test(location.pathname);
  }

  function updateHidden() {
    const watching = isWatching();
    document.documentElement.classList.toggle("wr-watching", watching);
    return watching;
  }

  function scan() {
    if (updateHidden()) return;
    for (const card of findCards(document)) {
      if (card.hasAttribute(DONE)) continue;
      if (card.parentElement?.closest(`[${DONE}]`)) continue; // nested inside a card we already handle
      const raw = readRawTitle(card);
      if (!raw) continue;
      const { title, year, type, skip } = cleanTitle(raw);
      if (skip || !isPlausible(title)) continue;
      // Cards that state a type that isn't a movie or show (live event, sport, channel) have no IMDb rating.
      if (card.hasAttribute("data-card-entity-type") && !typeHint(card)) continue;
      const href = (card.closest("a[href]") ?? card.querySelector("a[href]"))?.getAttribute("href") ?? "";
      if (SKIP_HREF.test(href.split("?")[0])) continue;
      card.setAttribute(DONE, "");
      card.__wr = { title, year, type: typeHint(card) ?? type, context: (card.innerText || "").replace(/\s+/g, " ").slice(0, 160) };
      io.observe(card);
    }
  }

  function keyOf(info) {
    return info.title.toLowerCase() + "|" + (info.year ?? "") + "|" + (info.type ?? "");
  }

  function enqueue(card) {
    const info = card.__wr;
    const key = keyOf(info);
    if (!resultCache.has(key)) {
      let resolve;
      resultCache.set(key, new Promise((r) => (resolve = r)));
      queue.push({ key, info, resolve });
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, queue.length >= BATCH_SIZE ? 0 : 250);
    }
    resultCache.get(key).then((res) => res && renderBadge(card, res));
  }

  // Direct lookups first so their badges show at once; titles that missed go through
  // the slower AI cleanup in a second request that doesn't hold up the next batch.
  async function flush() {
    while (queue.length) {
      const batch = queue.splice(0, BATCH_SIZE);
      const misses = await request(batch, false);
      if (misses.length) request(misses, true);
    }
  }

  // Resolves each item that got a rating; returns the items still unresolved (when useAi is false).
  async function request(batch, useAi) {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "rate",
        siteName: site.name,
        useAi,
        items: batch.map((b) => ({ raw: b.info.title, year: b.info.year, type: b.info.type, context: b.info.context })),
      });
    } catch (e) {
      resp = { error: String(e) };
    }
    if (resp?.error) {
      showError(resp.error);
      // Forget failed keys so a later scroll can retry once the problem is fixed.
      batch.forEach((b) => {
        resultCache.delete(b.key);
        b.resolve(null);
      });
      return [];
    }
    if (resp.notice) showError(resp.notice);
    const misses = [];
    batch.forEach((b, i) => {
      if (resp.results[i]) b.resolve({ rating: resp.results[i], prefs: resp.settings });
      else if (!useAi && !resp.notice) misses.push(b);
      else {
        // While OMDb is out of requests, a miss may just mean "not fetched yet": allow a retry later.
        if (resp.notice) resultCache.delete(b.key);
        b.resolve(null);
      }
    });
    return misses;
  }

  // ---- rendering ----

  function ratingClass(v) {
    const n = parseFloat(v);
    if (n >= 7.5) return "wr-good";
    if (n >= 6) return "wr-ok";
    return "wr-bad";
  }

  function renderBadge(card, { rating, prefs }) {
    if (!card.isConnected || !rating.imdbRating && !rating.rottenTomatoes) return;
    const host = badgeHost(card);
    if (host.querySelector(":scope > .wr-badge")) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const badge = document.createElement("a");
    badge.className = "wr-badge";
    badge.href = `https://www.imdb.com/title/${rating.imdbId}/`;
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.title = [`${rating.title} (${rating.year})`, rating.genre, rating.imdbVotes && `${rating.imdbVotes} IMDb votes`]
      .filter(Boolean).join(" · ");

    const add = (cls, label, value) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = label + value;
      badge.appendChild(s);
    };
    if (rating.imdbRating) add(`wr-imdb ${ratingClass(rating.imdbRating)}`, "IMDb ", rating.imdbRating);
    if (prefs.showRottenTomatoes && rating.rottenTomatoes) add("wr-rt", "🍅 ", rating.rottenTomatoes);
    if (prefs.showMetacritic && rating.metacritic) add("wr-mc", "MC ", rating.metacritic);

    // Keep the card's own click handler (play/expand) from firing.
    const stop = (e) => e.stopPropagation();
    ["pointerdown", "mousedown", "mouseup"].forEach((t) => badge.addEventListener(t, stop));
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.open(badge.href, "_blank", "noopener");
    });
    host.appendChild(badge);
  }

  function showError(err) {
    if (errorShown) return;
    errorShown = true;
    const toast = document.createElement("div");
    toast.className = "wr-toast";
    toast.textContent = err === "NO_OMDB_KEY"
      ? "Reelscore: add your free OMDb API key to see ratings. Click to open settings."
      : `Reelscore: ${err}`;
    toast.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openOptions" });
      toast.remove();
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 12000);
  }

  // ---- boot ----

  async function start() {
    site = await chrome.runtime.sendMessage({ type: "getSiteConfig", url: location.href });
    // The flag is set only once we actually run, so the popup can inject again after "Turn on".
    if (!site?.enabled || window.__reelscoreLoaded) return;
    window.__reelscoreLoaded = true;
    scan();
    document.addEventListener("fullscreenchange", updateHidden);
    window.addEventListener("popstate", scan);
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scan, 400);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["alt", "aria-label", "data-card-title"] });
  }

  start();
})();
