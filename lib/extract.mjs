// Extraction des infos produit d'une page web.
// Chaque champ indique sa source ("json-ld", "open-graph", "shopify", "html")
// pour ne jamais présenter une supposition comme une donnée récupérée.
import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (compatible; FrenchStreetCatalogue/1.0)";
const TIMEOUT_MS = 12000;

export class ImportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ImportError("invalid_url", "Cette adresse n'est pas une URL valide."); }
  if (!/^https?:$/.test(u.protocol)) throw new ImportError("invalid_url", "L'URL doit commencer par http:// ou https://.");
  const h = u.hostname;
  const isPrivate = h === "localhost" || h.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "[::1]";
  if (isPrivate && !process.env.ALLOW_PRIVATE_URLS) throw new ImportError("invalid_url", "Adresse locale ou privée refusée.");
  return u;
}

export async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow", headers: { "user-agent": UA, "accept-language": "fr,en;q=0.8", ...(opts.headers || {}) } });
  } catch (e) {
    if (e.name === "AbortError") throw new ImportError("timeout", "Le site a mis trop de temps à répondre.");
    throw new ImportError("network", "Impossible de joindre le site (" + (e.cause?.code || e.message) + ").");
  } finally { clearTimeout(t); }
}

export async function importProduct(rawUrl) {
  const url = assertPublicUrl(rawUrl);
  const res = await fetchWithTimeout(url.href, { headers: { accept: "text/html,application/xhtml+xml" } });
  if (res.status === 401 || res.status === 403) throw new ImportError("blocked", `Le site refuse l'accès automatique (erreur ${res.status}). Il protège ses pages contre les robots.`);
  if (res.status === 404) throw new ImportError("not_found", "Page introuvable (erreur 404).");
  if (res.status === 429) throw new ImportError("rate_limited", "Le site limite les requêtes (erreur 429). Réessaie plus tard.");
  if (!res.ok) throw new ImportError("http_error", `Le site a répondu avec l'erreur ${res.status}.`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) throw new ImportError("not_html", "Cette URL ne pointe pas vers une page web (type : " + type + ").");
  const html = await res.text();
  const result = extractFromHtml(html, res.url || url.href);

  // Boutiques Shopify : données produit officielles en JSON (/products/xxx.js)
  if (!result.found.jsonLd && /cdn\.shopify\.com|Shopify\.theme/.test(html) && /\/products\//.test(url.pathname)) {
    try {
      const r = await fetchWithTimeout(url.origin + url.pathname.replace(/\/$/, "") + ".js", { headers: { accept: "application/json" } });
      if (r.ok) mergeShopify(result, await r.json(), url);
    } catch { /* facultatif */ }
  }
  if (!result.name && result.images.length === 0) {
    throw new ImportError("no_data", "Page récupérée, mais aucune info produit trouvée. Le site charge probablement son contenu en JavaScript.");
  }
  return result;
}

export function extractFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = { sourceUrl: pageUrl, name: "", brand: "", model: "", reference: "", description: "", specs: [], images: [], sources: {}, found: {} };
  const set = (field, value, source) => {
    const v = clean(value);
    if (v && !out[field]) { out[field] = v; out.sources[field] = source; }
  };
  const imgs = new Map(); // url -> source
  const addImg = (src, source) => {
    const abs = absolute(src, pageUrl);
    if (!abs || imgs.has(abs) || isJunkImage(abs)) return;
    imgs.set(abs, source);
  };

  // 1. JSON-LD Schema.org Product
  const product = findJsonLdProduct($);
  if (product) {
    out.found.jsonLd = true;
    set("name", product.name, "json-ld");
    set("brand", typeof product.brand === "string" ? product.brand : product.brand?.name, "json-ld");
    set("model", typeof product.model === "string" ? product.model : product.model?.name, "json-ld");
    set("reference", product.sku || product.mpn || product.productID || product.gtin13 || product.gtin, "json-ld");
    set("description", product.description, "json-ld");
    for (const k of ["color", "material", "size", "pattern", "category"]) {
      const v = Array.isArray(product[k]) ? product[k].join(", ") : product[k];
      if (typeof v === "string" && clean(v)) out.specs.push({ label: LABELS[k], value: clean(v), source: "json-ld" });
    }
    for (const p of [].concat(product.additionalProperty || [])) {
      if (p?.name && p?.value != null) out.specs.push({ label: clean(p.name), value: clean(String(p.value)), source: "json-ld" });
    }
    for (const im of [].concat(product.image || [])) addImg(typeof im === "string" ? im : im?.url || im?.contentUrl, "json-ld");
    for (const off of [].concat(product.offers || [])) for (const im of [].concat(off?.image || [])) addImg(typeof im === "string" ? im : im?.url, "json-ld");
  }

  // 2. Open Graph / métadonnées
  const meta = (sel) => $(sel).attr("content");
  if (meta('meta[property="og:title"]')) out.found.openGraph = true;
  set("name", meta('meta[property="og:title"]'), "open-graph");
  set("brand", meta('meta[property="product:brand"]') || meta('meta[property="og:brand"]'), "open-graph");
  set("reference", meta('meta[property="product:retailer_item_id"]'), "open-graph");
  set("description", meta('meta[property="og:description"]'), "open-graph");
  $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').each((_, el) => addImg($(el).attr("content"), "open-graph"));

  // 3. HTML brut (dernier recours)
  set("name", $("h1").first().text(), "html");
  set("description", meta('meta[name="description"]'), "html");
  $("img").each((_, el) => {
    const e = $(el);
    const candidates = [e.attr("data-zoom-image"), e.attr("data-large_image"), e.attr("data-zoom"), largestFromSrcset(e.attr("srcset") || e.attr("data-srcset")), e.attr("data-src"), e.attr("src")];
    const src = candidates.find((s) => s && !s.startsWith("data:"));
    const w = parseInt(e.attr("width") || "0", 10);
    if (src && (w === 0 || w >= 200)) addImg(src, "html");
  });

  out.images = [...imgs].slice(0, 40).map(([url, source]) => ({ url, source }));
  return out;
}

function mergeShopify(out, p, pageUrl) {
  const set = (f, v) => { const c = clean(v); if (c && !out[f]) { out[f] = c; out.sources[f] = "shopify"; } };
  if (p.title) { out.name = ""; } // le titre Shopify est plus fiable que og:title
  set("name", p.title); set("brand", p.vendor); set("reference", p.variants?.[0]?.sku);
  set("description", cheerio.load(p.description || "").text());
  if (p.type) out.specs.push({ label: "Type", value: clean(p.type), source: "shopify" });
  const known = new Set(out.images.map((i) => i.url));
  const add = [];
  for (const im of p.images || []) {
    const abs = absolute(im, pageUrl.href);
    if (abs && !known.has(abs)) { known.add(abs); add.push({ url: abs, source: "shopify" }); }
  }
  out.images = [...add, ...out.images].slice(0, 40);
  out.found.shopify = true;
}

const LABELS = { color: "Couleur", material: "Matière", size: "Taille", pattern: "Motif", category: "Catégorie d'origine" };

function findJsonLdProduct($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { collect(JSON.parse($(el).contents().text().trim()), nodes); } catch { /* JSON invalide ignoré */ }
  });
  const isProduct = (n) => [].concat(n?.["@type"] || []).some((t) => /^(Product|ProductGroup|IndividualProduct)$/.test(t));
  const found = nodes.find(isProduct);
  if (found && !found.image && found.hasVariant) {
    const v = [].concat(found.hasVariant)[0];
    if (v?.image) found.image = v.image;
  }
  return found;
}
function collect(data, nodes) {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data)) return data.forEach((d) => collect(d, nodes));
  nodes.push(data);
  if (data["@graph"]) collect(data["@graph"], nodes);
  if (data.mainEntity) collect(data.mainEntity, nodes);
}

function largestFromSrcset(s) {
  if (!s) return null;
  let best = null, bestW = -1;
  for (const part of s.split(",")) {
    const [u, d] = part.trim().split(/\s+/);
    const w = parseFloat(d) || 0;
    if (u && w >= bestW) { best = u; bestW = w; }
  }
  return best;
}
function absolute(src, base) {
  if (!src || typeof src !== "string") return null;
  try {
    const u = new URL(src.trim().replace(/^\/\//, "https://"), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}
function isJunkImage(u) {
  return /\.(svg|gif)(\?|$)/i.test(u) || /(logo|icon|sprite|favicon|pixel|tracking|placeholder|blank|spinner|loader|badge|flag|payment)/i.test(u);
}
function clean(v) {
  if (v == null) return "";
  return String(v).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/\s+([.,])/g, "$1").trim().slice(0, 3000);
}
