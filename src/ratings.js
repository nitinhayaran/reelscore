// Rating lookup through OMDb (IMDb rating, Rotten Tomatoes, Metacritic), with a local cache.
//
// OMDb's free key allows 1,000 requests a day, and every request counts (repeat
// titles included), so the cache does most of the work:
//   - Ratings expire by the title's age: new releases and running series still
//     gain votes quickly, while a 20-year-old film's score barely moves.
//   - Expired entries are kept. If OMDb fails or the daily limit is hit, the
//     old rating is shown instead of nothing.

const DAY = 24 * 3600 * 1000;
const MISS_TTL = 3 * DAY;
const MAX_CONCURRENT = 4;
const LIMIT_BACKOFF = 3600 * 1000; // after hitting the limit, wait an hour before trying OMDb again

// How long a rating stays fresh, from its release year ("2019", "2016–2023", or "2021–" for a running series).
export function ttlFor(data, now = new Date()) {
  if (!data) return MISS_TTL;
  const years = String(data.year ?? "").match(/\d{4}/g);
  if (!years || /–\s*$/.test(data.year)) return 2 * DAY; // unknown year or still airing
  const age = now.getFullYear() - Number(years[years.length - 1]);
  if (age <= 1) return 2 * DAY;
  if (age <= 5) return 30 * DAY;
  return 180 * DAY;
}

export function normalizeKey(title, year) {
  const t = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  return year ? `${t}|${year}` : t;
}

// Returns { data, fresh } or undefined if never looked up. data null means "known miss".
async function getCached(key) {
  const k = "r:" + key;
  const { [k]: entry } = await chrome.storage.local.get(k);
  if (!entry) return undefined;
  const ttl = entry.ttl ?? ttlFor(entry.data);
  return { data: entry.data, fresh: Date.now() - entry.ts < ttl };
}

async function setCached(key, data) {
  await chrome.storage.local.set({ ["r:" + key]: { data, ts: Date.now(), ttl: ttlFor(data) } });
}

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("r:") || k.startsWith("g:")));
}

// ---- daily usage and limit tracking ----

const today = () => new Date().toISOString().slice(0, 10);

export async function getUsage() {
  const { omdbUsage, omdbBlockedUntil } = await chrome.storage.local.get(["omdbUsage", "omdbBlockedUntil"]);
  return {
    today: omdbUsage?.day === today() ? omdbUsage.count : 0,
    blocked: (omdbBlockedUntil ?? 0) > Date.now(),
  };
}

async function countRequest() {
  const { omdbUsage } = await chrome.storage.local.get("omdbUsage");
  const count = omdbUsage?.day === today() ? omdbUsage.count + 1 : 1;
  await chrome.storage.local.set({ omdbUsage: { day: today(), count } });
}

export async function isBlocked() {
  return (await getUsage()).blocked;
}

// ---- requests ----

// Small semaphore so a page with 200 cards doesn't fire 200 requests at once.
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export class OmdbError extends Error {}
class LimitReached extends Error {}

async function omdb(params, apiKey) {
  if (await isBlocked()) throw new LimitReached();
  const url = new URL("https://www.omdbapi.com/");
  url.search = new URLSearchParams({ apikey: apiKey, ...params });
  const res = await withSlot(() => fetch(url));
  await countRequest();
  const body = await res.json().catch(() => ({}));
  if (/limit/i.test(body.Error ?? "")) {
    await chrome.storage.local.set({ omdbBlockedUntil: Date.now() + LIMIT_BACKOFF });
    throw new LimitReached();
  }
  if (res.status === 401 || /invalid api key|no api key/i.test(body.Error ?? "")) {
    throw new OmdbError("Invalid OMDb API key (check that you clicked the activation link in OMDb's email)");
  }
  if (!res.ok) throw new OmdbError(`OMDb HTTP ${res.status}`);
  return body.Response === "False" ? null : body;
}

function toRating(body) {
  const rt = body.Ratings?.find((r) => r.Source === "Rotten Tomatoes")?.Value ?? null;
  const num = (v) => (v && v !== "N/A" ? v : null);
  return {
    title: body.Title,
    year: body.Year,
    type: body.Type,
    imdbId: body.imdbID,
    imdbRating: num(body.imdbRating),
    imdbVotes: num(body.imdbVotes),
    rottenTomatoes: rt,
    metacritic: num(body.Metascore),
    genre: num(body.Genre),
  };
}

// Looks up one title. Returns a rating object, or null if there is no match
// (or no saved rating while OMDb is unavailable).
export async function lookupTitle({ title, year, type }, apiKey) {
  // The type is part of the key: "Anupama" the 1966 film and "Anupama" the series are different entries.
  const key = normalizeKey(title, year) + (type === "movie" || type === "series" ? "|" + type : "");
  const cached = await getCached(key);
  if (cached?.fresh) return cached.data;

  const params = { t: title };
  if (year) params.y = year;
  if (type === "movie" || type === "series") params.type = type;
  try {
    let body = await omdb(params, apiKey);
    // A wrong year or type guess is a common cause of misses; retry with the title alone.
    if (!body && (year || params.type)) body = await omdb({ t: title }, apiKey);
    const data = body ? toRating(body) : null;
    await setCached(key, data);
    return data;
  } catch (e) {
    // Out of requests or OMDb is down: fall back to the saved rating, however old.
    if (e instanceof LimitReached || !(e instanceof OmdbError)) return cached?.data ?? null;
    throw e;
  }
}
