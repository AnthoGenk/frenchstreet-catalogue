// Lecture du catalogue GZ SPORT (base Firebase Firestore publique en lecture, projet gzsport-7565c).
// Collections connues : albums (produits) et "cat_photos" (une photo = un document, champ "data").
import { fetchWithTimeout } from "./extract.mjs";

const BASE = process.env.GZ_FIRESTORE_BASE ||
  "https://firestore.googleapis.com/v1/projects/gzsport-7565c/databases/(default)/documents";
const ALBUM_COLLECTIONS = ["cat_albums", "albums", "cat_products", "products", "cat_items", "catalog"];

// Convertit le format typé de Firestore REST en objet JavaScript simple
function decode(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields);
  return null;
}
const decodeFields = (fields = {}) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
const docId = (name) => name.split("/").pop();

async function getJson(url) {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Liste tous les albums (sans les photos, juste leurs identifiants)
export async function listAlbums() {
  for (const col of ALBUM_COLLECTIONS) {
    const albums = [];
    let token = "";
    for (let page = 0; page < 50; page++) {
      const { status, data } = await getJson(`${BASE}/${col}?pageSize=300${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
      if (status === 403) throw new Error("La base GZ SPORT refuse la lecture (accès fermé par son propriétaire).");
      if (status !== 200) break;
      for (const d of data.documents || []) albums.push(normalizeAlbum(docId(d.name), decodeFields(d.fields)));
      token = data.nextPageToken;
      if (!token) break;
    }
    const withPhotos = albums.filter((a) => a.photoIds.length);
    if (withPhotos.length) return { collection: col, albums: withPhotos };
  }
  throw new Error("Aucun produit trouvé dans la base GZ SPORT (structure inconnue).");
}

function normalizeAlbum(id, f) {
  const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
  return {
    id,
    title: str(f.title || f.name),
    brand: str(f.brand),
    model: str(f.model),
    category: str(f.category),
    description: str(f.description || f.desc),
    photoIds: Array.isArray(f.photoIds) ? f.photoIds.map(String) : [],
    soldOut: !!f.soldOut,
    createdAt: typeof f.createdAt === "number" ? f.createdAt : null,
  };
}

// Récupère une photo (stockée en data URL dans le document cat_photos/{id})
export async function getPhotoData(photoId) {
  if (!/^[\w-]{1,200}$/.test(photoId)) throw new Error("Identifiant de photo invalide.");
  const { status, data } = await getJson(`${BASE}/cat_photos/${encodeURIComponent(photoId)}`);
  if (status !== 200) throw new Error(`Photo introuvable (erreur ${status}).`);
  const v = decode(data.fields?.data);
  if (typeof v !== "string" || !v) throw new Error("Photo vide.");
  return v; // data:image/...;base64,... ou URL https
}

// Catégorie French Street à partir des infos GZ SPORT
export function mapCategory(album) {
  const t = (album.category + " " + album.title).toLowerCase();
  if (/shoe|sneaker|boot|slide|sandal|chaussure|basket|鞋|靴/.test(t)) return "Chaussures";
  if (/bag|sac|wallet|belt|cap|hat|casquette|glass|lunette|accessor|包|帽|眼镜|皮带/.test(t)) return "Sacs et accessoires";
  if (/watch|phone|earbud|headphone|electro|montre|écouteur|手表|耳机|电子/.test(t)) return "Électronique";
  return "Vêtements";
}

// Couleurs chinoises → français (les plus longues d'abord)
const COLORS = [["藏青", "Bleu marine"], ["墨绿", "Vert foncé"], ["军绿", "Kaki"], ["卡其", "Kaki"], ["米白", "Crème"], ["奶白", "Crème"],
  ["白玉", "Blanc jade"], ["酒红", "Bordeaux"], ["天蓝", "Bleu ciel"], ["宝蓝", "Bleu roi"], ["荧光", "Fluo"], ["彩色", "Multicolore"],
  ["白", "Blanc"], ["黑", "Noir"], ["灰", "Gris"], ["绿", "Vert"], ["蓝", "Bleu"], ["红", "Rouge"], ["粉", "Rose"], ["黄", "Jaune"],
  ["紫", "Violet"], ["棕", "Marron"], ["咖", "Café"], ["米", "Crème"], ["银", "Argent"], ["金", "Or"], ["橙", "Orange"], ["橘", "Orange"],
  ["杏", "Abricot"], ["青", "Bleu-vert"], ["玉", "Jade"]];
const SHADES = [["浅", "clair"], ["深", "foncé"]];

function translateColors(zh) {
  const out = []; let shade = "";
  let i = 0;
  while (i < zh.length) {
    const sh = SHADES.find(([k]) => zh.startsWith(k, i));
    if (sh) { shade = sh[1]; i += sh[0].length; continue; }
    const c = COLORS.find(([k]) => zh.startsWith(k, i));
    if (c) { out.push(shade ? c[1] + " " + shade : c[1]); shade = ""; i += c[0].length; continue; }
    i++; // caractère non traduit (ex. 色) : ignoré
  }
  return [...new Set(out)].join(" / ");
}

// "OFF-WHITE 米白黑36-47" → { name: "ASICS GEL-KAYANO 14 — Off-White · Crème / Noir", sizes: "36 – 47" }
export function frenchName(album) {
  let t = album.title || "";
  let sizes = "";
  t = t.replace(/(\d{2}(?:\.5)?)\s*[-~～–至]\s*(\d{2}(?:\.5)?)(?:码|碼)?/, (_, a, b) => { sizes = a + " – " + b; return " "; });
  const zh = (t.match(/[\u3400-\u9fff]+/g) || []).join("");
  const latin = t.replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
  const color = translateColors(zh) || (latin && titleCase(latin)); // couleurs en français en priorité
  const base = [album.brand, album.model].filter(Boolean).join(" ").trim() || "Produit";
  return { name: color ? `${base} — ${color}` : base, sizes };
}
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
