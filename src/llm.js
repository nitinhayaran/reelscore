// Turns noisy card text ("Watch Panchayat S3 E1 | Hindi | U/A 13+") into clean
// { title, year, type } guesses. Only called for cards whose plain lookup missed.
//
// Provider: Claude Haiku 5.5 over the Messages API. The extension has no build
// step, so it calls the HTTP API with fetch directly. To try another provider
// (e.g. Jev), add a function with the same signature and pick it in normalizeTitles.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-5-5";

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          title: { type: ["string", "null"] },
          year: { type: ["string", "null"] },
          type: { type: "string", enum: ["movie", "series", "unknown"] },
        },
        required: ["index", "title", "year", "type"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM = `You receive text scraped from movie/TV cards on a streaming website.
For each item, return the official English release title as listed on IMDb, so it can be looked up there.
Drop UI words (Watch, Play, New Episode, Trailer), season/episode markers, language/rating tags, and site names.
If you know the release year, give it; otherwise null. If the text is not a movie or show (a genre row, ad, button, sport event, or channel), return title null.`;

async function anthropicNormalize(items, apiKey) {
  const lines = items.map((it, i) => `${i}. ${JSON.stringify(it.raw)}${it.context ? `  (card text: ${JSON.stringify(it.context)})` : ""}`);
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Site: ${items[0].site}\n\n${lines.join("\n")}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const msg = await res.json();
  if (msg.stop_reason === "refusal") return items.map(() => null);
  const text = msg.content.find((b) => b.type === "text")?.text;
  const parsed = JSON.parse(text);
  const out = items.map(() => null);
  for (const r of parsed.items) {
    if (r.index >= 0 && r.index < items.length && r.title) {
      out[r.index] = { title: r.title, year: r.year ?? undefined, type: r.type };
    }
  }
  return out;
}

// items: [{ raw, context, site }] -> [{ title, year, type } | null]
export async function normalizeTitles(items, settings) {
  if (!settings.useAi || !settings.anthropicApiKey || items.length === 0) return items.map(() => null);
  return anthropicNormalize(items, settings.anthropicApiKey);
}
