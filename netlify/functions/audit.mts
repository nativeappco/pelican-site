import type { Context, Config } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

// ---- Hard caps / budget -------------------------------------------------
const MAX_PRODUCTS = 20; // products actually sampled/scored
const PRODUCT_POOL = 250; // products.json page pulled to rank best-sellers against
const MAX_PAGES = 10; // product pages fetched + parsed for HTML
const MAX_COLLECTIONS = 20; // collections sampled from collections.json
const MAX_COLLECTION_PAGES = 5; // collection pages fetched for meta/SEO text
const TOTAL_BUDGET_MS = 9000; // stay under Netlify's default 10s sync timeout
const RATE_LIMIT = 5; // requests
const RATE_WINDOW_MS = 60 * 60 * 1000; // per hour, per IP

const INSTALL_URL = "https://apps.shopify.com/product-pelican";

// Category weights (must sum to 100)
const WEIGHTS = {
  schema: 25,
  faq: 15,
  meta: 12,
  alt: 12,
  content: 14,
  collections: 12,
  crawl: 10,
} as const;

type Status = "pass" | "partial" | "fail";
// State of a single scraped URL inside a category's expandable detail.
type DetailState = "pass" | "partial" | "fail" | "skip";

interface Detail {
  url: string; // full URL scraped
  path: string; // short, display path (e.g. /products/handle)
  state: DetailState;
  note: string; // short plain-language reason
}

interface CategoryResult {
  key: keyof typeof WEIGHTS;
  label: string;
  status: Status;
  score: number; // 0..1
  weight: number; // percentage points
  fix: string; // one-line, plain language
  what: string; // tooltip: what this checks
  how: string; // tooltip: how it's calculated
  details: Detail[]; // per-URL breakdown for the expandable panel
}

// ---- Helpers ------------------------------------------------------------

/** Normalise arbitrary user input to a bare `xxx.myshopify.com` host, or null. */
function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  // Accept "store" or "store.myshopify.com"
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}

function clientIp(req: Request, context: Context): string {
  // context.ip is provided by Netlify; fall back to forwarded header.
  return (
    (context as any).ip ||
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/** Use a global store in production, deploy-scoped elsewhere (keeps test data isolated). */
function stateStore(name: string) {
  const isProd = (globalThis as any).Netlify?.context?.deploy?.context === "production";
  return isProd
    ? getStore({ name, consistency: "strong" })
    : getDeployStore({ name, consistency: "strong" } as any);
}

async function fetchText(url: string, ms: number): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "ProductPelican-Audit/1.0 (+https://productpelican.com)" },
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get("content-type") || "" };
  } catch {
    return { ok: false, status: 0, text: "", contentType: "" };
  } finally {
    clearTimeout(timer);
  }
}

function wordCount(html: string): number {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}

function normText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract product handles in DOM order from a /collections/all?sort_by=best-selling
 * HTML page. Shopify renders that grid server-side in best-selling order (standard
 * Liquid themes); we read the /products/{handle} links, deduped, in order. Returns
 * [] for headless/JS-rendered storefronts (no server-side anchors) so the caller
 * can fall back to the default products.json order.
 */
function bestSellingHandles(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href=["'][^"']*\/products\/([a-z0-9][a-z0-9-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].toLowerCase();
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

// ---- Per-page analysis --------------------------------------------------

interface PageSignals {
  ldJsonCount: number; // number of JSON-LD blocks found (0 => likely JS-rendered)
  hasProductSchema: boolean;
  schemaFieldCount: number; // of the 5 we check
  hasMeta: boolean;
  metaLen: number;
  imgTotal: number;
  imgWithAlt: number;
  hasFaqContent: boolean; // an FAQ heading is present on the page
  hasFaqSchema: boolean; // FAQPage / Question JSON-LD is present (i.e. crawlable)
}

const SCHEMA_FIELDS = ["name", "image", "description", "offers", "brand"] as const;

/** Is this JSON-LD @type a Product or ProductGroup (with or without a schema.org URL prefix)? */
function isProductType(t: unknown): boolean {
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => typeof x === "string" && /(^|\/)(Product|ProductGroup)$/i.test(x));
}
function isFaqType(t: unknown): boolean {
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => typeof x === "string" && /(^|\/)(FAQPage|Question)$/i.test(x));
}

/**
 * Walk arbitrary JSON-LD (objects, arrays, @graph, nested hasVariant, etc.) and
 * surface Product / FAQ signals wherever they appear. Shopify commonly wraps the
 * real Product inside a ProductGroup's `hasVariant`, or buries nodes in @graph —
 * a shallow, exact `@type === "Product"` check misses most real stores.
 */
function walkJsonLd(d: any, out: { product: boolean; fields: number; faq: boolean }): void {
  if (!d || typeof d !== "object") return;
  if (Array.isArray(d)) {
    d.forEach((x) => walkJsonLd(x, out));
    return;
  }
  const type = d["@type"];
  if (isProductType(type)) {
    out.product = true;
    const count = SCHEMA_FIELDS.filter((f) => d[f] != null && d[f] !== "").length;
    out.fields = Math.max(out.fields, count);
  }
  if (isFaqType(type)) out.faq = true;
  for (const k of Object.keys(d)) walkJsonLd(d[k], out);
}

const FAQ_HEADING_RE = /\b(faqs?|frequently\s+asked\s+questions)\b/i;

function analysePage(html: string): PageSignals {
  const $ = cheerio.load(html);
  const sig: PageSignals = {
    ldJsonCount: 0,
    hasProductSchema: false,
    schemaFieldCount: 0,
    hasMeta: false,
    metaLen: 0,
    imgTotal: 0,
    imgWithAlt: 0,
    hasFaqContent: false,
    hasFaqSchema: false,
  };

  // JSON-LD — recurse through everything so nested / @graph / ProductGroup markup counts.
  const out = { product: false, fields: 0, faq: false };
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    sig.ldJsonCount += 1;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    walkJsonLd(data, out);
  });
  sig.hasProductSchema = out.product;
  sig.schemaFieldCount = out.fields;
  sig.hasFaqSchema = out.faq;

  // FAQ content — an FAQ heading in the visible page (headings + accordion triggers).
  $("h1,h2,h3,h4,h5,h6,summary,button,[role='heading']").each((_, el) => {
    if (sig.hasFaqContent) return;
    if (FAQ_HEADING_RE.test($(el).text() || "")) sig.hasFaqContent = true;
  });

  // Meta description
  const meta = $('meta[name="description"]').attr("content") || "";
  sig.hasMeta = meta.trim().length > 0;
  sig.metaLen = meta.trim().length;

  // Image alt coverage — restrict to Shopify-hosted media to avoid nav/footer
  // noise. Shopify serves product images from cdn.shopify.com AND from the
  // store's own domain at /cdn/shop/ (the common case once the product page
  // redirects to the primary domain). Also check lazy-load attributes, since
  // many themes leave `src` as a placeholder and put the real URL in data-src /
  // srcset. Match on any of these so we don't undercount to zero.
  const SHOPIFY_CDN = /cdn\.shopify\.com|\/cdn\/shop\//i;
  $("img").each((_, el) => {
    const $el = $(el);
    const srcAttrs = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("srcset"),
      $el.attr("data-srcset"),
      $el.attr("data-original"),
    ]
      .filter(Boolean)
      .join(" ");
    if (!SHOPIFY_CDN.test(srcAttrs)) return;
    sig.imgTotal += 1;
    if (($el.attr("alt") || "").trim().length > 0) sig.imgWithAlt += 1;
  });

  return sig;
}

/** Collection page: does it expose a meta description (SEO text)? */
function collectionMeta(html: string): { hasMeta: boolean } {
  const $ = cheerio.load(html);
  const meta = ($('meta[name="description"]').attr("content") || "").trim();
  return { hasMeta: meta.length > 0 };
}

// ---- Main ---------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const start = Date.now();
  const remaining = () => Math.max(500, TOTAL_BUDGET_MS - (Date.now() - start));

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const store = normaliseDomain(body?.domain);
  if (!store) {
    return json({ error: "Please enter a valid myshopify.com domain (e.g. your-store.myshopify.com)." }, 400);
  }

  // ---- Rate limit -------------------------------------------------------
  try {
    const rl = stateStore("audit-ratelimit");
    const ip = clientIp(req, context);
    const now = Date.now();
    const prev: number[] = (await rl.get(ip, { type: "json" })) || [];
    const recent = prev.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      return json(
        {
          error: "rate_limited",
          message: "You've hit the audit limit for now (5 per hour). Install Pelican to audit your whole catalogue for free.",
          installUrl: INSTALL_URL,
        },
        429,
      );
    }
    recent.push(now);
    await rl.setJSON(ip, recent);
  } catch {
    // If the rate-limit store is unavailable, fail open rather than block a lead.
  }

  // ---- Phase A: catalogue JSON + crawl files (all in parallel) ----------
  const jsonBudget = Math.min(6000, remaining());
  const robotsUrl = `https://${store}/robots.txt`;
  const sitemapUrl = `https://${store}/sitemap.xml`;
  const llmsUrl = `https://${store}/llms.txt`;
  const [productsRes, collectionsRes, bestSellersRes, robots, sitemap, llms] = await Promise.all([
    fetchText(`https://${store}/products.json?limit=${PRODUCT_POOL}`, jsonBudget),
    fetchText(`https://${store}/collections.json?limit=${MAX_COLLECTIONS}`, jsonBudget),
    // Best-selling order is only exposed via the rendered collection HTML (the
    // .json endpoint ignores sort_by). fetchText follows the redirect to the
    // store's primary domain. Empty for headless/JS-rendered storefronts.
    fetchText(`https://${store}/collections/all?sort_by=best-selling`, jsonBudget),
    fetchText(robotsUrl, jsonBudget),
    fetchText(sitemapUrl, jsonBudget),
    fetchText(llmsUrl, jsonBudget),
  ]);

  let pool: any[] = [];
  if (productsRes.ok && /json/.test(productsRes.contentType)) {
    try {
      pool = JSON.parse(productsRes.text)?.products || [];
    } catch {
      pool = [];
    }
  }

  if (!pool.length) {
    // Graceful failure — password-protected, blocked, 404, or empty catalogue.
    return json({ status: "unavailable", store });
  }

  // ---- Pick which products to sample: best-sellers first, else default order.
  const byHandle = new Map<string, any>();
  for (const p of pool) {
    const h = String(p?.handle || "").toLowerCase();
    if (h) byHandle.set(h, p);
  }
  const ranked = bestSellingHandles(bestSellersRes.ok ? bestSellersRes.text : "");
  const ordered: any[] = [];
  const used = new Set<string>();
  for (const h of ranked) {
    const p = byHandle.get(h);
    if (p && !used.has(h)) {
      ordered.push(p);
      used.add(h);
      if (ordered.length >= MAX_PRODUCTS) break;
    }
  }
  const sampledBy = ordered.length ? "best-selling" : "recent";
  // Pad with default (products.json) order if best-selling was unavailable or short.
  if (ordered.length < MAX_PRODUCTS) {
    for (const p of pool) {
      const h = String(p?.handle || "").toLowerCase();
      if (!used.has(h)) {
        ordered.push(p);
        used.add(h);
        if (ordered.length >= MAX_PRODUCTS) break;
      }
    }
  }

  let products: any[] = ordered.slice(0, MAX_PRODUCTS);

  let collections: any[] = [];
  if (collectionsRes.ok && /json/.test(collectionsRes.contentType)) {
    try {
      collections = (JSON.parse(collectionsRes.text)?.collections || []).slice(0, MAX_COLLECTIONS);
    } catch {
      collections = [];
    }
  }

  // ---- Phase B: product + collection page HTML (all in parallel) --------
  const productTargets = products
    .map((p) => p.handle)
    .filter(Boolean)
    .slice(0, MAX_PAGES)
    .map((h: string) => ({ handle: h, path: `/products/${h}`, url: `https://${store}/products/${h}` }));
  const collectionTargets = collections
    .map((c) => c.handle)
    .filter(Boolean)
    .slice(0, MAX_COLLECTION_PAGES)
    .map((h: string) => ({ handle: h, path: `/collections/${h}`, url: `https://${store}/collections/${h}` }));
  const pageBudget = Math.min(6000, remaining());

  const [productPages, collectionPages] = await Promise.all([
    Promise.all(
      productTargets.map(async (t) => {
        const r = await fetchText(t.url, pageBudget);
        return { ...t, ok: r.ok, sig: r.ok ? analysePage(r.text) : null };
      }),
    ),
    Promise.all(
      collectionTargets.map(async (t) => {
        const r = await fetchText(t.url, pageBudget);
        return { ...t, ok: r.ok, meta: r.ok ? collectionMeta(r.text) : null };
      }),
    ),
  ]);

  // Pages we actually read HTML for (schema/meta/alt/faq depend on it).
  const analysedPages = productPages.filter((p) => p.sig);
  const analysed = analysedPages.map((p) => p.sig as PageSignals);
  const nPages = analysed.length || 1;
  const htmlOk = analysed.length > 0;

  const categories: CategoryResult[] = [];

  // Schema ----------------------------------------------------------------
  {
    const withSchema = analysed.filter((p) => p.hasProductSchema);
    const coverage = withSchema.length / nPages;
    const completeness = withSchema.length ? withSchema.reduce((s, p) => s + p.schemaFieldCount / 5, 0) / withSchema.length : 0;
    const score = htmlOk ? coverage * (0.5 + 0.5 * completeness) : 0.5;
    const missing = nPages - withSchema.length;
    const details: Detail[] = productPages.map((p) => {
      if (!p.ok || !p.sig) return { url: p.url, path: p.path, state: "skip", note: "couldn't read this page" };
      if (p.sig.hasProductSchema) {
        const f = p.sig.schemaFieldCount;
        return { url: p.url, path: p.path, state: f >= 4 ? "pass" : "partial", note: `Product schema found — ${f}/5 key fields` };
      }
      return {
        url: p.url,
        path: p.path,
        state: "fail",
        note: p.sig.ldJsonCount > 0 ? "structured data present, but no Product schema" : "no structured data in the page HTML (may be JavaScript-rendered)",
      };
    });
    categories.push({
      key: "schema",
      label: "Structured data (schema.org)",
      weight: WEIGHTS.schema,
      score,
      status: htmlOk ? band(score) : "partial",
      what: "Whether your product pages include schema.org Product structured data — the machine-readable summary AI shopping agents and search engines read instead of guessing from your HTML.",
      how: "We fetch up to 10 product pages and parse their JSON-LD (including nested and ProductGroup markup). A page passes if it contains Product markup; the score also rewards completeness across name, image, description, offers and brand.",
      details,
      fix: !htmlOk
        ? `We couldn't read your product pages to check schema markup. Pelican adds complete schema.org Product data automatically so AI shopping agents can read your catalogue.`
        : missing > 0
          ? `${missing} of your last ${nPages} products have no readable Product schema markup. AI shopping agents can't read your product data properly. Pelican adds complete schema automatically on install.`
          : `Your products have schema markup, but it's often incomplete. Pelican fills in missing fields (brand, offers, ratings) so agents get the full picture.`,
    });
  }

  // FAQ schema ------------------------------------------------------------
  {
    const crawlable = analysed.filter((p) => p.hasFaqSchema).length; // FAQ schema present
    const contentNoSchema = analysed.filter((p) => p.hasFaqContent && !p.hasFaqSchema).length; // FAQs shown but not marked up
    const noFaq = analysed.filter((p) => !p.hasFaqContent && !p.hasFaqSchema).length;
    const pageScore = (p: PageSignals) => (p.hasFaqSchema ? 1 : p.hasFaqContent ? 0.4 : 0);
    const score = htmlOk ? analysed.reduce((s, p) => s + pageScore(p), 0) / nPages : 0.5;
    const details: Detail[] = productPages.map((p) => {
      if (!p.ok || !p.sig) return { url: p.url, path: p.path, state: "skip", note: "couldn't read this page" };
      if (p.sig.hasFaqSchema) return { url: p.url, path: p.path, state: "pass", note: "FAQs marked up as FAQ schema (crawlable)" };
      if (p.sig.hasFaqContent) return { url: p.url, path: p.path, state: "partial", note: "FAQs on the page but no FAQ schema — not crawlable" };
      return { url: p.url, path: p.path, state: "fail", note: "no FAQs found on the page" };
    });
    categories.push({
      key: "faq",
      label: "Product FAQ schema",
      weight: WEIGHTS.faq,
      score,
      status: htmlOk ? band(score) : "partial",
      what: "Whether product FAQs are present and marked up as FAQ schema so AI agents can actually read the questions and answers — not just render them for humans.",
      how: "On each product page we look for an FAQ heading (“FAQs” / “Frequently asked questions”) and for FAQPage / Question JSON-LD. A page passes only when FAQ schema is present (crawlable); it partly passes if FAQs appear on the page but aren't marked up.",
      details,
      fix: !htmlOk
        ? `We couldn't read your product pages to check for FAQs. Pelican generates product FAQs and marks them up with FAQ schema so AI agents can read them.`
        : contentNoSchema > 0
          ? `${contentNoSchema} of your last ${nPages} products show FAQs on the page but they're not marked up as FAQ schema, so AI agents can't read them. Pelican adds crawlable FAQ schema automatically.`
          : noFaq === nPages
            ? `None of your last ${nPages} product pages have FAQs. Product FAQs are exactly what shoppers and AI assistants ask — Pelican generates them and marks them up as FAQ schema.`
            : noFaq > 0
              ? `${noFaq} of your last ${nPages} products have no FAQs at all. Pelican generates on-brand product FAQs and marks them up so agents can surface them.`
              : `Your product FAQs are marked up as FAQ schema — great. Pelican keeps new products at the same standard automatically.`,
    });
  }

  // Meta descriptions -----------------------------------------------------
  {
    const good = analysed.filter((p) => p.hasMeta && p.metaLen >= 70 && p.metaLen <= 160).length;
    const some = analysed.filter((p) => p.hasMeta).length;
    const score = htmlOk ? (good / nPages) * 0.8 + (some / nPages) * 0.2 : 0.5;
    const missing = nPages - some;
    const details: Detail[] = productPages.map((p) => {
      if (!p.ok || !p.sig) return { url: p.url, path: p.path, state: "skip", note: "couldn't read this page" };
      if (!p.sig.hasMeta) return { url: p.url, path: p.path, state: "fail", note: "no meta description" };
      const inRange = p.sig.metaLen >= 70 && p.sig.metaLen <= 160;
      return { url: p.url, path: p.path, state: inRange ? "pass" : "partial", note: `${p.sig.metaLen} characters${inRange ? "" : " (ideal 70–160)"}` };
    });
    categories.push({
      key: "meta",
      label: "Meta descriptions",
      weight: WEIGHTS.meta,
      score,
      status: htmlOk ? band(score) : "partial",
      what: "Whether each product page has a meta description — the snippet search and AI engines show, and a strong signal of what the page is about.",
      how: "From the same product pages we read the <meta name=“description”> tag. Full marks for a description in the ideal 70–160 character range; partial credit if one exists but is too short or long.",
      details,
      fix: !htmlOk
        ? `We couldn't read your product pages to check meta descriptions. Pelican writes optimised meta descriptions across your catalogue in bulk.`
        : missing > 0
          ? `${missing} of your last ${nPages} products are missing a meta description. Search and AI engines fall back to guessing your snippet. Pelican writes optimised meta descriptions in bulk.`
          : `Your meta descriptions exist but many fall outside the ideal 70–160 characters. Pelican rewrites them to the right length automatically.`,
    });
  }

  // Alt text --------------------------------------------------------------
  {
    const totalImgs = analysed.reduce((s, p) => s + p.imgTotal, 0);
    const withAlt = analysed.reduce((s, p) => s + p.imgWithAlt, 0);
    const missing = totalImgs - withAlt;
    let altScore: number, altStatus: Status, altFix: string;
    if (totalImgs === 0) {
      // Couldn't sample product images from the page HTML (JS-rendered / headless).
      altScore = 0.5;
      altStatus = "partial";
      altFix = `We couldn't read your product images from the page — they may load via JavaScript. Pelican generates descriptive AI alt text for every image so agents and accessibility tools can understand them.`;
    } else {
      altScore = withAlt / totalImgs;
      altStatus = band(altScore);
      altFix =
        missing > 0
          ? `${missing} of ${totalImgs} product images we checked have no alt text. Agents and accessibility tools can't understand them. Pelican generates descriptive AI alt text for every image.`
          : `Your product images have alt text — nice. Pelican keeps it consistent and descriptive as you add new products.`;
    }
    const details: Detail[] = productPages.map((p) => {
      if (!p.ok || !p.sig) return { url: p.url, path: p.path, state: "skip", note: "couldn't read this page" };
      if (p.sig.imgTotal === 0) return { url: p.url, path: p.path, state: "skip", note: "no product images detected in the HTML" };
      const ratio = p.sig.imgWithAlt / p.sig.imgTotal;
      const state: DetailState = ratio >= 0.999 ? "pass" : ratio >= 0.5 ? "partial" : "fail";
      return { url: p.url, path: p.path, state, note: `${p.sig.imgWithAlt}/${p.sig.imgTotal} images have alt text` };
    });
    categories.push({
      key: "alt",
      label: "Image alt text",
      weight: WEIGHTS.alt,
      score: altScore,
      status: altStatus,
      what: "Whether your product images have alt text — the text description agents and accessibility tools rely on to understand an image.",
      how: "We count Shopify-hosted images on each product page and check how many have non-empty alt text. The score is the overall share of images with alt text.",
      details,
      fix: altFix,
    });
  }

  // Content quality (from products.json body_html) ------------------------
  {
    const texts = products.map((p) => normText(p.body_html || ""));
    const seen = new Map<string, number>();
    texts.forEach((t) => t && seen.set(t, (seen.get(t) || 0) + 1));
    const thin = texts.filter((t) => t && wordCount(t) < 30).length + texts.filter((t) => !t).length;
    const duplicated = [...seen.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0);
    const n = products.length;
    const thinScore = 1 - thin / n;
    const dupScore = 1 - duplicated / n;
    const score = Math.max(0, thinScore * 0.6 + dupScore * 0.4);
    const details: Detail[] = products.map((p) => {
      const path = p.handle ? `/products/${p.handle}` : `#${p.id ?? "?"}`;
      const url = p.handle ? `https://${store}/products/${p.handle}` : "";
      const t = normText(p.body_html || "");
      const wc = t ? wordCount(t) : 0;
      if (!t) return { url, path, state: "fail", note: "empty description" };
      if (wc < 30) return { url, path, state: "fail", note: `thin description (${wc} words)` };
      if ((seen.get(t) || 0) > 1) return { url, path, state: "partial", note: `${wc} words, but duplicated across products` };
      return { url, path, state: "pass", note: `${wc} words, unique` };
    });
    categories.push({
      key: "content",
      label: "Content quality",
      weight: WEIGHTS.content,
      score,
      status: band(score),
      what: "Whether product descriptions are substantial and unique — AI engines need real content to understand and recommend a product.",
      how: "We read the description of up to 20 products from your public products.json. Products score down for thin (under 30 words) or empty descriptions, and for descriptions duplicated across products.",
      details,
      fix:
        thin > 0
          ? `${thin} of ${n} products have thin or empty descriptions. AI engines need substance to recommend you. Pelican writes rich, on-brand descriptions in bulk.`
          : duplicated > 0
            ? `${duplicated} products share duplicate/boilerplate descriptions. Search engines discount duplicate content. Pelican rewrites each one to be unique.`
            : `Your descriptions look healthy. Pelican keeps new products at the same standard automatically.`,
    });
  }

  // Collections — descriptions (collections.json) + SEO text (page meta) --
  {
    const nColl = collections.length;
    if (nColl === 0) {
      categories.push({
        key: "collections",
        label: "Collection descriptions & SEO",
        weight: WEIGHTS.collections,
        score: 0.5,
        status: "partial",
        what: "Whether your collection pages have descriptions and SEO text — collection pages are where agents understand your ranges and categories.",
        how: "We read descriptions from collections.json and fetch up to 5 collection pages to check for SEO meta text. Full marks need both a description and meta text.",
        details: [],
        fix: `We couldn't find public collections for this store. Collection pages are prime real estate for AI search — Pelican writes collection descriptions and SEO text so they rank and get recommended.`,
      });
    } else {
      const withDesc = collections.filter((c) => wordCount(String(c.body_html || "")) >= 15).length;
      const missingDesc = nColl - withDesc;
      const descScore = withDesc / nColl;
      const metaSampled = collectionPages.filter((c) => c.meta).length;
      const metaWith = collectionPages.filter((c) => c.meta?.hasMeta).length;
      const metaScore = metaSampled ? metaWith / metaSampled : descScore;
      const score = descScore * 0.6 + metaScore * 0.4;
      const missingMeta = metaSampled - metaWith;
      // Detail: for each collection page we fetched, combine its description (json) + SEO meta (page).
      const descByHandle = new Map<string, boolean>();
      collections.forEach((c) => descByHandle.set(c.handle, wordCount(String(c.body_html || "")) >= 15));
      const details: Detail[] = collectionPages.map((c) => {
        if (!c.ok || !c.meta) return { url: c.url, path: c.path, state: "skip", note: "couldn't read this collection page" };
        const hasDesc = !!descByHandle.get(c.handle);
        const hasMeta = c.meta.hasMeta;
        if (hasDesc && hasMeta) return { url: c.url, path: c.path, state: "pass", note: "description + SEO meta text" };
        if (hasDesc || hasMeta) return { url: c.url, path: c.path, state: "partial", note: hasDesc ? "has description, no SEO meta text" : "has SEO meta, no description" };
        return { url: c.url, path: c.path, state: "fail", note: "no description or SEO meta text" };
      });
      categories.push({
        key: "collections",
        label: "Collection descriptions & SEO",
        weight: WEIGHTS.collections,
        score,
        status: band(score),
        what: "Whether your collection pages have descriptions and SEO text — collection pages are where agents understand your ranges and categories.",
        how: `We read descriptions from collections.json (sampled ${nColl}) and fetch up to ${MAX_COLLECTION_PAGES} collection pages to check for SEO meta text. Full marks need both a description and meta text.`,
        details,
        fix:
          missingDesc > 0
            ? `${missingDesc} of your ${nColl} collections have little or no description. Collection pages are where AI agents understand your ranges — Pelican writes rich collection descriptions and SEO text in bulk.`
            : missingMeta > 0
              ? `${missingMeta} of the collection pages we sampled are missing SEO meta text. Pelican adds optimised collection descriptions and meta so they surface in search and AI results.`
              : `Your collections have descriptions and SEO text — strong. Pelican keeps new collections at the same standard automatically.`,
      });
    }
  }

  // Crawlability (robots / sitemap / llms.txt) ----------------------------
  {
    const hasSitemap = sitemap.ok && /<urlset|<sitemapindex/.test(sitemap.text);
    const robotsOk = robots.ok && !/Disallow:\s*\/\s*$/im.test(robots.text.split("\n").slice(0, 40).join("\n"));
    const hasLlms = llms.ok && llms.text.trim().length > 0;
    const score = (hasSitemap ? 0.5 : 0) + (robotsOk ? 0.3 : 0) + (hasLlms ? 0.2 : 0);
    const missing: string[] = [];
    if (!hasSitemap) missing.push("a valid sitemap.xml");
    if (!robotsOk) missing.push("crawler-friendly robots.txt");
    if (!hasLlms) missing.push("an llms.txt for AI crawlers");
    const details: Detail[] = [
      { url: sitemapUrl, path: "/sitemap.xml", state: hasSitemap ? "pass" : "fail", note: hasSitemap ? "valid sitemap found" : "no valid sitemap.xml" },
      { url: robotsUrl, path: "/robots.txt", state: robotsOk ? "pass" : "fail", note: robotsOk ? "crawler-friendly" : "missing or blocks crawlers" },
      { url: llmsUrl, path: "/llms.txt", state: hasLlms ? "pass" : "fail", note: hasLlms ? "llms.txt found" : "no llms.txt (most stores don't have one yet)" },
    ];
    categories.push({
      key: "crawl",
      label: "Crawlability (robots / sitemap / llms.txt)",
      weight: WEIGHTS.crawl,
      score,
      status: band(score),
      what: "Whether AI crawlers and search engines can discover and access your catalogue — via sitemap.xml, a permissive robots.txt, and the emerging llms.txt standard for AI crawlers.",
      how: "We fetch /sitemap.xml, /robots.txt and /llms.txt. A valid sitemap contributes 50%, a crawler-friendly robots.txt 30%, and an llms.txt 20% of this score.",
      details,
      fix: hasLlms
        ? `Crawlers can reach your catalogue. Keep it that way as you grow.`
        : `You're missing ${missing.join(", ")}. AI crawlers increasingly look for llms.txt — most stores don't have one yet, so it's an easy edge. Pelican helps you get discovery-ready.`,
    });
  }

  // ---- Overall score + bands -------------------------------------------
  const overall = Math.round(categories.reduce((s, c) => s + c.score * c.weight, 0));
  const scoreBand = overall >= 80 ? "Agent-ready" : overall >= 50 ? "Needs work" : "Room for improvement";

  const topFixes = categories
    .filter((c) => c.status !== "pass")
    .sort((a, b) => ((1 - a.score) * a.weight < (1 - b.score) * b.weight ? 1 : -1))
    .slice(0, 5)
    .map((c) => ({ label: c.label, status: c.status, fix: c.fix }));

  // ---- Advisory: brand / colour in title (advisory only, NOT scored) ----
  // Uses data already fetched. Leaving brand or colour out of a title is a
  // legitimate choice, so this never touches the score — only surfaces a
  // pattern as an advisory fix card when it's clearly widespread.
  const advisories: { fix: string }[] = [];
  {
    let colourMissing = 0;
    let brandMissing = 0;
    let brandTotal = 0;
    for (const p of products) {
      const title = String(p.title || "").toLowerCase();
      if (!title) continue;

      const colourOpt = (p.options || []).find((o: any) => /colou?r/i.test(o?.name || ""));
      const colours: string[] = (colourOpt && Array.isArray(colourOpt.values) ? colourOpt.values : [])
        .map((v: any) => String(v || "").toLowerCase().trim())
        .filter((v: string) => v && v !== "default title");
      if (colours.length && !colours.some((v) => title.includes(v))) colourMissing++;

      const vendor = String(p.vendor || "").toLowerCase().trim();
      if (vendor.length >= 3) {
        brandTotal++;
        if (!title.includes(vendor)) brandMissing++;
      }
    }
    if (colourMissing >= 3) {
      advisories.push({
        fix: `${colourMissing} products have a colour variant but no colour in the title. Shoppers and AI agents search by colour — adding it helps them match. Want Pelican to add it?`,
      });
    }
    if (brandMissing >= 5 && brandMissing >= brandTotal * 0.6) {
      advisories.push({
        fix: `${brandMissing} products don't include your brand name in the title. Adding it can lift brand recognition in search and AI results — Pelican can do it in bulk.`,
      });
    }
  }

  // One real product for the live "before/after" example on the results page.
  const ex: any = products[0] || null;
  const exampleProduct = ex
    ? {
        title: String(ex.title || ""),
        description: String(ex.body_html || ""),
        vendor: String(ex.vendor || ""),
        options: (ex.options || []).map((o: any) => ({
          name: o?.name,
          values: Array.isArray(o?.values) ? o.values.slice(0, 12) : [],
        })),
      }
    : null;

  return json({
    status: "ok",
    store,
    score: overall,
    band: scoreBand,
    sampled: products.length,
    sampledBy,
    pagesAnalysed: analysed.length,
    collectionsSampled: collections.length,
    categories: categories.map((c) => ({
      key: c.key,
      label: c.label,
      status: c.status,
      score: Math.round(c.score * 100),
      weight: c.weight,
      fix: c.fix,
      what: c.what,
      how: c.how,
      details: c.details,
    })),
    topFixes,
    advisories,
    exampleProduct,
    installUrl: INSTALL_URL,
    tookMs: Date.now() - start,
  });
};

function band(score: number): Status {
  if (score >= 0.8) return "pass";
  if (score >= 0.4) return "partial";
  return "fail";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/audit",
};
