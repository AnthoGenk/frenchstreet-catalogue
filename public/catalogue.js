// Catalogue public French Street
const DEFAULT_CATEGORIES = ["Vêtements", "Chaussures", "Sacs et accessoires", "Électronique"];
const HANDLE = "@french-street";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let products = [];
const state = { q: "", cat: "Tout", brand: "" };

async function load() {
  $("#count").textContent = "Chargement…";
  try {
    const res = await fetch("/api/products");
    if (!res.ok) throw new Error(res.status);
    products = await res.json();
  } catch {
    $("#count").textContent = "";
    showEmpty("Le catalogue n'a pas pu être chargé. Vérifie ta connexion et recharge la page.");
    return;
  }
  renderFilters();
  render();
  openFromHash();
}

function categories() {
  const used = new Set(products.map((p) => p.category));
  const ordered = DEFAULT_CATEGORIES.filter((c) => used.has(c));
  const extra = [...used].filter((c) => !DEFAULT_CATEGORIES.includes(c)).sort();
  return ["Tout", ...ordered, ...extra];
}

function renderFilters() {
  $("#cats").innerHTML = categories().map((c) =>
    `<button class="chip" role="tab" aria-selected="${c === state.cat}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  const brands = [...new Set(products.filter(inCategory).map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = $("#brand");
  sel.hidden = brands.length < 2;
  if (!brands.includes(state.brand)) state.brand = "";
  sel.innerHTML = `<option value="">Toutes les marques</option>` + brands.map((b) => `<option ${b === state.brand ? "selected" : ""}>${esc(b)}</option>`).join("");
}

const inCategory = (p) => state.cat === "Tout" || p.category === state.cat;

function filtered() {
  const words = norm(state.q).split(/\s+/).filter(Boolean);
  return products.filter((p) => {
    if (!inCategory(p)) return false;
    if (state.brand && p.brand !== state.brand) return false;
    if (!words.length) return true;
    const hay = norm([p.name, p.brand, p.model, p.reference, p.category].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

function render() {
  const list = filtered();
  $("#count").textContent = list.length + (list.length > 1 ? " pièces" : " pièce");
  $("#grid").innerHTML = list.map((p) => `
    <button class="card" data-id="${esc(p.id)}" aria-label="${esc(p.brand + " " + p.name)}">
      <div class="card-img">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy" decoding="async">` : `<span class="noimg">PHOTO À VENIR</span>`}</div>
      ${p.brand ? `<div class="card-brand">${esc(p.brand)}</div>` : ""}
      <div class="card-name">${esc(p.name)}</div>
    </button>`).join("");
  if (!products.length) showEmpty("Le catalogue arrive bientôt.");
  else if (!list.length) showEmpty("Aucune pièce ne correspond. Envoie-nous une capture en DM : on la source pour toi.");
  else $("#empty").hidden = true;
}

function showEmpty(msg) { const e = $("#empty"); e.textContent = msg; e.hidden = false; }

function openProduct(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  const meta = [["Marque", p.brand], ["Modèle", p.model], ["Référence", p.reference], ["Catégorie", p.category]].filter(([, v]) => v);
  const ref = p.reference || p.model || p.id;
  $("#detail").innerHTML = `
    ${p.images.length ? `<div class="gallery" id="gal">${p.images.map((src, i) => `<img src="${esc(src)}" alt="${esc(p.name)} — photo ${i + 1}" ${i ? 'loading="lazy"' : ""}>`).join("")}</div>
    ${p.images.length > 1 ? `<div class="dots" id="dots">${p.images.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}` : ""}
    <div class="d-body">
      <div>${p.brand ? `<div class="d-brand">${esc(p.brand)}</div>` : ""}<h2 class="d-name">${esc(p.name)}</h2></div>
      <dl class="d-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${p.description ? `<p class="d-desc">${esc(p.description)}</p>` : ""}
      ${p.specs.length ? `<p class="section-label">Caractéristiques</p><dl class="d-meta">${p.specs.map((s) => `<dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd>`).join("")}</dl>` : ""}
      <button class="cta" id="copyref"><strong>Je veux cette pièce →</strong><span>Copie la référence et envoie-la en DM à ${HANDLE}</span></button>
    </div>`;
  const gal = $("#gal"), dots = $("#dots");
  if (gal && dots) gal.addEventListener("scroll", () => {
    const i = Math.round(gal.scrollLeft / gal.clientWidth);
    [...dots.children].forEach((d, j) => d.classList.toggle("on", i === j));
  }, { passive: true });
  $("#copyref").onclick = () => copy(`French Street — ${[p.brand, p.name].filter(Boolean).join(" ")} (réf. ${ref}) ${location.origin}/#p=${p.id}`);
  const sheet = $("#sheet");
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  history.replaceState(null, "", "#p=" + encodeURIComponent(id));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Référence copiée. Colle-la en DM à " + HANDLE); }
  catch { prompt("Copie cette référence :", text); }
}
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}
function openFromHash() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (m) openProduct(decodeURIComponent(m[1]));
}

$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#cats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]"); if (!b) return;
  state.cat = b.dataset.cat; renderFilters(); render();
});
$("#brand").addEventListener("change", (e) => { state.brand = e.target.value; render(); });
$("#grid").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openProduct(c.dataset.id); });
$("#close").onclick = () => $("#sheet").close();
$("#sheet").addEventListener("close", () => history.replaceState(null, "", location.pathname));
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") e.target.close(); });
window.addEventListener("hashchange", openFromHash);
load();
