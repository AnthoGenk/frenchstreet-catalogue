// API unique du catalogue.
// Public  : GET /api/products, GET /api/img/:clé
// Admin   : /api/admin/* (en-tête x-admin-password = variable d'environnement ADMIN_PASSWORD)
import crypto from "node:crypto";
import { store } from "../../lib/store.mjs";
import { importProduct, assertPublicUrl, fetchWithTimeout, ImportError } from "../../lib/extract.mjs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

export default async (req) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

    if (req.method === "GET" && parts[0] === "products" && parts.length === 1) {
      const items = (await readCatalog()).map(({ sourceUrl, ...pub }) => pub);
      return json(items, 200, { "cache-control": "public, max-age=0, must-revalidate" });
    }
    if (req.method === "GET" && parts[0] === "img" && parts[1]) return serveImage(decodeURIComponent(parts[1]));

    if (parts[0] === "admin") {
      const authError = await checkAuth(req);
      if (authError) return authError;
      const route = parts.slice(1);
      if (req.method === "POST" && route[0] === "login") return json({ ok: true });
      if (req.method === "GET" && route[0] === "products") return json(await readCatalog());
      if (req.method === "POST" && route[0] === "import") {
        const { url: target } = await req.json().catch(() => ({}));
        if (!target) return json({ error: "URL manquante.", code: "invalid_url" }, 400);
        return json(await importProduct(String(target)));
      }
      if (req.method === "POST" && route[0] === "products") return saveProduct(await req.json().catch(() => null));
      if (req.method === "DELETE" && route[0] === "products" && route[1]) return deleteProduct(route[1]);
    }
    return json({ error: "Route inconnue." }, 404);
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message, code: e.code }, 422);
    console.error(e);
    return json({ error: "Erreur serveur : " + e.message }, 500);
  }
};

export const config = { path: "/api/*" };

// ---------- Authentification ----------
async function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return json({ error: "ADMIN_PASSWORD n'est pas configuré sur le serveur." }, 500);
  const given = req.headers.get("x-admin-password") || "";
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  if (!crypto.timingSafeEqual(h(given), h(expected))) {
    await new Promise((r) => setTimeout(r, 600)); // ralentit les essais en série
    return json({ error: "Mot de passe incorrect." }, 401);
  }
  return null;
}

// ---------- Catalogue ----------
const catalog = () => store("catalog");
async function readCatalog() { return (await catalog().get("products", { type: "json" })) || []; }
async function writeCatalog(items) { await catalog().setJSON("products", items); }

async function saveProduct(body) {
  if (!body || typeof body !== "object") return json({ error: "Données invalides." }, 400);
  const str = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(body.name);
  const category = str(body.category, 60);
  if (!name) return json({ error: "Le nom du produit est obligatoire." }, 400);
  if (!category) return json({ error: "Choisis une catégorie." }, 400);

  const items = await readCatalog();
  const existing = body.id ? items.find((p) => p.id === body.id) : null;
  if (body.id && !existing) return json({ error: "Produit introuvable." }, 404);
  const id = existing?.id || crypto.randomUUID().slice(0, 8);

  const images = [], imageErrors = [];
  for (const src of Array.isArray(body.images) ? body.images.slice(0, 20) : []) {
    try { images.push(await storeImage(id, String(src))); }
    catch (e) { imageErrors.push({ src: String(src).slice(0, 120), error: e.message }); }
  }
  // Supprime les images retirées du produit
  for (const old of existing?.images || []) if (!images.includes(old)) await imgStore().delete(old.replace("/api/img/", "")).catch(() => {});

  const specs = (Array.isArray(body.specs) ? body.specs : [])
    .map((s) => ({ label: str(s?.label, 60), value: str(s?.value, 300) }))
    .filter((s) => s.label && s.value).slice(0, 30);

  const now = new Date().toISOString();
  const product = {
    id, name, category,
    brand: str(body.brand, 80), model: str(body.model, 120), reference: str(body.reference, 120),
    description: str(body.description, 3000), specs, images,
    sourceUrl: str(body.sourceUrl, 1000),
    createdAt: existing?.createdAt || now, updatedAt: now,
  };
  const next = existing ? items.map((p) => (p.id === id ? product : p)) : [product, ...items];
  await writeCatalog(next);
  return json({ product, imageErrors }, existing ? 200 : 201);
}

async function deleteProduct(id) {
  const items = await readCatalog();
  const p = items.find((x) => x.id === id);
  if (!p) return json({ error: "Produit introuvable." }, 404);
  for (const img of p.images) await imgStore().delete(img.replace("/api/img/", "")).catch(() => {});
  await writeCatalog(items.filter((x) => x.id !== id));
  return json({ ok: true });
}

// ---------- Images (copiées et hébergées chez nous) ----------
const imgStore = () => store("images");

async function storeImage(productId, src) {
  if (src.startsWith("/api/img/")) return src; // déjà hébergée
  let bytes, contentType;
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!m) throw new Error("Fichier image illisible.");
    contentType = m[1];
    bytes = Buffer.from(m[2], "base64");
  } else {
    const u = assertPublicUrl(src);
    const res = await fetchWithTimeout(u.href, { headers: { accept: "image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5", referer: u.origin + "/" } });
    if (!res.ok) throw new Error(`Le site refuse de fournir l'image (erreur ${res.status}).`);
    contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (!IMAGE_TYPES.includes(contentType)) throw new Error("Format non accepté (" + (contentType || "inconnu") + ").");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image trop lourde (max 10 Mo).");
  if (bytes.length < 1000) throw new Error("Image vide ou trop petite.");
  const key = `${productId}-${crypto.randomUUID().slice(0, 8)}`;
  await imgStore().set(key, bytes, { metadata: { contentType } });
  return "/api/img/" + key;
}

async function serveImage(key) {
  const entry = await imgStore().getWithMetadata(key, { type: "arrayBuffer" });
  if (!entry) return new Response("Image introuvable", { status: 404 });
  return new Response(entry.data, {
    headers: { "content-type": entry.metadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
