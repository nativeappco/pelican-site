import type { Context, Config } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

// Bonus enrichment for the results page: one LLM call turns a real product into
// a "this is what Pelican would generate" before/after example.
//
// Uses Groq (free tier, OpenAI-compatible) rather than a paid key — so even if
// this endpoint is spammed, the worst case is hitting Groq's free rate limit,
// never a bill. We also rate-limit per IP here (the endpoint is public and, if
// called directly, isn't behind the audit's own limiter).
//
// Fired AFTER the score renders; must fail silently — any non-200 just means the
// frontend doesn't show the live-example card. Never touches the audit score.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const RATE_LIMIT = 10; // enrich calls
const RATE_WINDOW_MS = 60 * 60 * 1000; // per hour, per IP
const TIMEOUT_MS = 9000; // stay under Netlify's default 10s function timeout

function stateStore(name: string) {
  const isProd = (globalThis as any).Netlify?.context?.deploy?.context === "production";
  return isProd
    ? getStore({ name, consistency: "strong" })
    : getDeployStore({ name, consistency: "strong" } as any);
}

function clientIp(req: Request, context: Context): string {
  return (
    (context as any).ip ||
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey =
    (globalThis as any).Netlify?.env?.get?.("GROQ_API_KEY") || process.env.GROQ_API_KEY;
  if (!apiKey) {
    // No key configured — the card just won't show. Not an error worth surfacing.
    return json({ error: "enrichment_unavailable" }, 503);
  }

  // ---- Rate limit (per IP) ---------------------------------------------
  try {
    const rl = stateStore("enrich-ratelimit");
    const ip = clientIp(req, context);
    const now = Date.now();
    const prev: number[] = (await rl.get(ip, { type: "json" })) || [];
    const recent = prev.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      return json({ error: "rate_limited" }, 429);
    }
    recent.push(now);
    await rl.setJSON(ip, recent);
  } catch {
    // Blobs unavailable — fail open rather than drop a legitimate example.
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const ep = body?.exampleProduct;
  const title = String(ep?.title || "").trim();
  if (!title) {
    return json({ error: "Missing product" }, 400);
  }

  const description = stripHtml(String(ep?.description || ""));
  const vendor = String(ep?.vendor || "").trim();
  const options = Array.isArray(ep?.options)
    ? ep.options
        .map((o: any) => `${o?.name}: ${(Array.isArray(o?.values) ? o.values : []).join(", ")}`)
        .filter(Boolean)
        .join("; ")
    : "";

  const system =
    "You are Product Pelican, a Shopify PIM that improves product data for AI shopping agents. " +
    "Respond with ONLY a JSON object (no markdown, no prose) with exactly these keys: " +
    '"title" (an improved product title, string), ' +
    '"description" (a richer 2-3 sentence description, string), ' +
    '"category" (the single best-fit Shopify Standard Taxonomy category path, e.g. "Apparel & Accessories > Clothing > Sweaters > Crewnecks", string), ' +
    '"metafields" (array of 2-4 objects, each {"label": string, "value": string}), ' +
    '"faqs" (array of exactly 3 objects, each {"q": string, "a": string}). ' +
    "Base everything only on the product provided; do not invent specifics you cannot reasonably infer.";

  const user =
    `Title: ${title}\n` +
    (vendor ? `Vendor/brand: ${vendor}\n` : "") +
    (options ? `Options: ${options}\n` : "") +
    (description ? `Current description: ${description}\n` : "");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 900,
      }),
    });

    if (!res.ok) return json({ error: "enrichment_failed" }, 502);
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return json({ error: "empty" }, 502);

    const data = JSON.parse(content);
    return json({ status: "ok", enrichment: data });
  } catch {
    // Model error, timeout, bad JSON — all silent. Card simply won't show.
    return json({ error: "enrichment_failed" }, 502);
  } finally {
    clearTimeout(timer);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/audit-enrich",
};
