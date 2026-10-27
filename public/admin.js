// Administration French Street
const DEFAULT_CATEGORIES = ["Vêtements", "Chaussures", "Sacs et accessoires", "Électronique"];
const SOURCE_LABEL = { "json-ld": "données produit", "open-graph": "métadonnées", shopify: "boutique Shopify", html: "texte de la page" };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let password = sessionStorage.getItem("fs_pwd") || "";
let products = [];
let editing = null; // { id?, sourceUrl, images: [{src, on}] }

async function api(path, opts = {}) {
  const res = await fetch("/api/admin/" + path, {
    ...opts,
    headers: { "content-type": "application/json", "x-admin-password": password, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({ error: "Réponse illisible du serveur (" + res.status + ")." }));
  if (res.status === 401) { logout(); throw new Error(data.error || "Session expirée."); }
  if (!res.ok) { const e = new Error(data.error || "Erreur " + res.status); e.code = data.code; throw e; }
  return data;
}
const msg = (el, text, kind = "err") => { $(el).innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : ""; };

// ---------- Connexion ----------
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  password = $("#pwd").value;
  try { await api("login", { method: "POST" }); sessionStorage.setItem("fs_pwd", password); start(); }
  catch (err) { msg("#loginMsg", esc(err.message)); }
};
function logout() {
  password = ""; sessionStorage.removeItem("fs_pwd");
  $("#app").hidden = true; $("#login").hidden = false; $("#logout").hidden = true;
}
$("#logout").onclick = logout;

async function start() {
  $("#login").hidden = true; $("#app").hidden = false; $("#logout").hidden = false;
  await refreshList();
  $("#url").focus();
}

// ---------- Onglets ----------
function showTab(tab) {
  $("#tabAdd").setAttribute("aria-selected", tab === "add");
  $("#tabList").setAttribute("aria-selected", tab === "list");
  $("#tabGz").setAttribute("aria-selected", tab === "gz");
  $("#addView").hidden = tab !== "add";
  $("#listView").hidden = tab !== "list";
  $("#gzView").hidden = tab !== "gz";
  $("#editor").hidden = true;
}
$("#tabAdd").onclick = () => showTab("add");
$("#tabList").onclick = () => showTab("list");
$("#tabGz").onclick = () => showTab("gz");

// ---------- Import ----------
const FALLBACK = {
  blocked: "Ce site bloque les robots. Solution : saisis le produit à la main et ajoute les photos depuis ton téléphone, ou essaie la même pièce sur un autre site (site de la marque, revendeur).",
  no_data: "Solution : essaie l'URL d'un autre revendeur, ou saisis le produit à la main.",
  timeout: "Réessaie dans un instant. Si ça persiste, passe par la saisie manuelle.",
  network: "Vérifie l'URL. Si elle est correcte, le site est peut-être indisponible.",
};
$("#importForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#importBtn");
  btn.disabled = true; btn.textContent = "Analyse en cours…"; msg("#importMsg", "");
  try {
    const data = await api("import", { method: "POST", body: JSON.stringify({ url: $("#url").value.trim() }) });
    const strong = data.images.filter((i) => i.source !== "html");
    const preselect = new Set((strong.length ? strong.slice(0, 8) : data.images.slice(0, 6)).map((i) => i.url));
    openEditor({ ...data, images: data.images.map((i) => ({ src: i.url, on: preselect.has(i.url) })) }, "import");
    const n = data.images.length;
    msg("#importMsg", `Page analysée : ${n} photo${n > 1 ? "s" : ""} trouvée${n > 1 ? "s" : ""}. Vérifie et complète avant de publier.`, "ok");
  } catch (err) {
    msg("#importMsg", `<b>Import impossible.</b> ${esc(err.message)}${FALLBACK[err.code] ? "<br>" + FALLBACK[err.code] : ""}<br><a href="#" data-manual>→ Saisir à la main avec cette URL</a>`);
  } finally { btn.disabled = false; btn.textContent = "Importer le produit"; }
};
$("#importMsg").onclick = (e) => { if (e.target.matches("[data-manual]")) { e.preventDefault(); openEditor({ sourceUrl: $("#url").value.trim() }, "manual"); } };
$("#manual").onclick = (e) => { e.preventDefault(); openEditor({}, "manual"); };

// ---------- Éditeur ----------
function openEditor(p, mode) {
  editing = { id: p.id, sourceUrl: p.sourceUrl || "", images: p.images || [] };
  const f = $("#editor");
  for (const k of ["name", "brand", "model", "reference", "description"]) f.elements[k].value = p[k] || "";
  $("#edTitle").textContent = mode === "edit" ? "Modifier le produit" : mode === "import" ? "Vérifier le produit importé" : "Nouveau produit";
  document.querySelectorAll("[data-src]").forEach((el) => {
    const field = el.dataset.src;
    if (mode !== "import") { el.textContent = ""; return; }
    const s = p.sources?.[field];
    el.className = "src " + (s ? "found" : "miss");
    el.textContent = s ? "· trouvé (" + SOURCE_LABEL[s] + ")" : "· non trouvé";
  });
  fillCategories(p.category);
  $("#specs").innerHTML = "";
  (p.specs || []).forEach((s) => addSpecRow(s.label, s.value));
  renderImages();
  msg("#saveMsg", "");
  $("#saveBtn").textContent = mode === "edit" ? "Enregistrer les modifications" : "Publier dans le catalogue";
  f.hidden = false;
  f.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fillCategories(current) {
  const all = [...new Set([...DEFAULT_CATEGORIES, ...products.map((p) => p.category)])];
  if (current && !all.includes(current)) all.push(current);
  $("#catSel").innerHTML = `<option value="">— Choisir —</option>` + all.map((c) => `<option ${c === current ? "selected" : ""}>${esc(c)}</option>`).join("") + `<option value="__new">+ Nouvelle catégorie…</option>`;
  $("#newCat").hidden = true; $("#newCat").value = "";
}
$("#catSel").onchange = (e) => { $("#newCat").hidden = e.target.value !== "__new"; if (e.target.value === "__new") $("#newCat").focus(); };

function renderImages() {
  let n = 0;
  $("#imgs").innerHTML = editing.images.map((im, i) => `
    <button type="button" class="tile ${im.on ? "on" : ""}" data-i="${i}" aria-pressed="${im.on}">
      <img src="${esc(im.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.insertAdjacentHTML('afterend','<span class=broken>Aperçu bloqué par le site</span>')">
      ${im.on ? `<span class="badge">${++n}</span>` : ""}
    </button>`).join("") || `<p class="hint">Aucune photo pour l'instant.</p>`;
  $("#imgCount").textContent = n ? `· ${n} gardée${n > 1 ? "s" : ""}` : "";
}
$("#imgs").onclick = (e) => {
  const t = e.target.closest(".tile"); if (!t) return;
  const im = editing.images[+t.dataset.i]; im.on = !im.on; renderImages();
};
$("#addImgUrl").onclick = () => {
  const u = $("#imgUrl").value.trim();
  if (!/^https?:\/\//.test(u)) return msg("#saveMsg", "L'URL de la photo doit commencer par https://");
  editing.images.push({ src: u, on: true }); $("#imgUrl").value = ""; renderImages(); msg("#saveMsg", "");
};
$("#upload").onchange = async (e) => {
  for (const file of e.target.files) {
    try { editing.images.push({ src: await resizeImage(file), on: true }); }
    catch { msg("#saveMsg", "Impossible de lire « " + esc(file.name) + " »."); }
  }
  e.target.value = ""; renderImages();
};
// Réduit les photos du téléphone (max 1600 px, JPEG) pour un chargement rapide
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function addSpecRow(label = "", value = "") {
  const row = document.createElement("div");
  row.className = "spec";
  row.innerHTML = `<input class="in" placeholder="Ex. Matière" value="${esc(label)}"><input class="in" placeholder="Ex. Cuir" value="${esc(value)}"><button type="button" class="btn small ghost" aria-label="Supprimer">✕</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("#specs").append(row);
}
$("#addSpec").onclick = () => addSpecRow();

$("#cancel").onclick = () => { $("#editor").hidden = true; editing = null; };

$("#editor").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  let category = f.elements.category.value;
  if (category === "__new") category = $("#newCat").value.trim();
  if (!f.elements.name.value.trim()) return msg("#saveMsg", "Le nom du produit est obligatoire.");
  if (!category) return msg("#saveMsg", "Choisis une catégorie.");
  const body = {
    id: editing.id, sourceUrl: editing.sourceUrl, category,
    name: f.elements.name.value, brand: f.elements.brand.value, model: f.elements.model.value,
    reference: f.elements.reference.value, description: f.elements.description.value,
    specs: [...$("#specs").children].map((r) => { const [l, v] = r.querySelectorAll("input"); return { label: l.value, value: v.value }; }),
    images: editing.images.filter((i) => i.on).map((i) => i.src),
  };
  const btn = $("#saveBtn"), label = btn.textContent;
  btn.disabled = true; btn.textContent = body.images.length ? "Copie des photos…" : "Enregistrement…";
  try {
    const { product, imageErrors } = await api("products", { method: "POST", body: JSON.stringify(body) });
    await refreshList();
    $("#editor").hidden = true; editing = null;
    let text = `<b>${esc(product.name)}</b> est en ligne (${product.images.length} photo${product.images.length > 1 ? "s" : ""}). <a href="/#p=${esc(product.id)}" target="_blank">Voir la fiche</a>`;
    if (imageErrors.length) text += `<br>${imageErrors.length} photo(s) non récupérée(s) : ${esc(imageErrors[0].error)} Tu peux les ajouter depuis ton téléphone via « Modifier ».`;
    showTab("add");
    msg("#importMsg", text, imageErrors.length ? "err" : "ok");
    $("#url").value = ""; $("#url").focus();
  } catch (err) { msg("#saveMsg", esc(err.message)); }
  finally { btn.disabled = false; btn.textContent = label; }
};

// ---------- Liste ----------
async function refreshList() {
  products = await api("products");
  $("#tabList").textContent = `Mes produits (${products.length})`;
  renderList();
}
function renderList() {
  const words = norm($("#listQ").value).split(/\s+/).filter(Boolean);
  const list = products.filter((p) => words.every((w) => norm([p.name, p.brand, p.model, p.reference, p.category].join(" ")).includes(w)));
  $("#list").innerHTML = list.map((p) => `
    <div class="list-item">
      ${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy">` : `<div class="ph"></div>`}
      <div><div class="t">${esc(p.name)}</div><div class="s">${esc([p.brand, p.category, p.reference].filter(Boolean).join(" · "))}</div></div>
      <div class="row"><button class="btn small ghost" data-edit="${esc(p.id)}">Modifier</button><button class="btn small danger" data-del="${esc(p.id)}">Supprimer</button></div>
    </div>`).join("") || `<p class="hint">Aucun produit.</p>`;
}
$("#listQ").oninput = renderList;
$("#list").onclick = async (e) => {
  const ed = e.target.closest("[data-edit]"), del = e.target.closest("[data-del]");
  if (ed) {
    const p = products.find((x) => x.id === ed.dataset.edit);
    openEditor({ ...p, images: p.images.map((src) => ({ src, on: true })) }, "edit");
  }
  if (del) {
    const p = products.find((x) => x.id === del.dataset.del);
    if (!confirm(`Supprimer « ${p.name} » du catalogue ? Ses photos seront aussi supprimées.`)) return;
    try { await api("products/" + encodeURIComponent(p.id), { method: "DELETE" }); await refreshList(); }
    catch (err) { alert(err.message); }
  }
};

// ---------- Import en masse GZ SPORT ----------
let gzAlbums = [], gzSelected = new Set(), gzStop = false;
$("#gzLoad").onclick = async () => {
  const b = $("#gzLoad"); b.disabled = true; b.textContent = "Chargement…"; msg("#gzMsg", "");
  try {
    gzAlbums = await api("gz/albums");
    gzSelected = new Set(gzAlbums.filter((a) => !a.imported && !a.soldOut).map((a) => a.id));
    const done = gzAlbums.filter((a) => a.imported).length;
    msg("#gzMsg", `${gzAlbums.length} produits trouvés, dont ${done} déjà importé${done > 1 ? "s" : ""}. Les produits non importés et disponibles sont présélectionnés.`, "ok");
    $("#gzTools").hidden = false; renderGz();
  } catch (err) { msg("#gzMsg", esc(err.message)); }
  finally { b.disabled = false; b.textContent = "Recharger le catalogue GZ SPORT"; }
};
function gzVisible() {
  const words = norm($("#gzQ").value).split(/\s+/).filter(Boolean);
  return gzAlbums.filter((a) => words.every((w) => norm([a.title, a.brand, a.model, a.category].join(" ")).includes(w)));
}
function renderGz() {
  $("#gzList").innerHTML = gzVisible().map((a) => `
    <label class="gz-item">
      <input type="checkbox" data-gz="${esc(a.id)}" ${gzSelected.has(a.id) ? "checked" : ""}>
      <span><b>${esc(a.frName || a.title || "Sans titre")}</b>${a.imported ? '<span class="tag ok">DÉJÀ IMPORTÉ</span>' : ""}${a.soldOut ? '<span class="tag">SOLD OUT</span>' : ""}<br>
      <span class="hint">${esc([a.brand, a.model, a.category, a.photoIds.length + " photos", "→ " + a.suggestedCategory].filter(Boolean).join(" · "))}</span></span>
    </label>`).join("") || `<p class="hint">Aucun produit.</p>`;
  $("#gzRun").textContent = `Importer la sélection (${gzSelected.size})`;
}
$("#gzQ").oninput = renderGz;
$("#gzList").onchange = (e) => { const id = e.target.dataset.gz; if (!id) return; e.target.checked ? gzSelected.add(id) : gzSelected.delete(id); renderGz(); };
$("#gzAll").onclick = () => { gzVisible().forEach((a) => gzSelected.add(a.id)); renderGz(); };
$("#gzNone").onclick = () => { gzVisible().forEach((a) => gzSelected.delete(a.id)); renderGz(); };
$("#gzStop").onclick = () => { gzStop = true; };
$("#gzRun").onclick = async () => {
  const todo = gzAlbums.filter((a) => gzSelected.has(a.id));
  if (!todo.length) return msg("#gzMsg", "Sélectionne au moins un produit.");
  gzStop = false; $("#gzRun").disabled = true; $("#gzStop").hidden = false;
  let ok = 0; const failed = [], photoErrors = [];
  for (const [n, a] of todo.entries()) {
    if (gzStop) break;
    const label = `Produit ${n + 1}/${todo.length} : ${esc(a.title || a.id)}`;
    try {
      const images = [];
      for (const [i, pid] of a.photoIds.slice(0, 20).entries()) {
        msg("#gzMsg", `${label} — photo ${i + 1}/${Math.min(a.photoIds.length, 20)}`, "ok");
        const body = JSON.stringify({ albumId: a.id, photoId: pid });
        try { images.push((await api("gz/photo", { method: "POST", body })).src); }
        catch (e1) {
          try { images.push((await api("gz/photo", { method: "POST", body })).src); } // 2e essai
          catch (e2) { photoErrors.push(e2.message); }
        }
      }
      const existing = products.find((p) => p.sourceUrl === "gzsport:" + a.id);
      await api("products", { method: "POST", body: JSON.stringify({
        id: existing?.id, name: a.frName || a.title || "Sans titre", brand: a.brand, model: a.model,
        description: a.description, category: existing?.category || a.suggestedCategory,
        images, specs: a.sizes ? [{ label: "Tailles", value: a.sizes }] : [], reference: a.title, sourceUrl: "gzsport:" + a.id,
      }) });
      a.imported = true; gzSelected.delete(a.id); ok++;
    } catch (err) { failed.push(`${a.title || a.id} : ${err.message}`); }
  }
  await refreshList();
  $("#gzRun").disabled = false; $("#gzStop").hidden = true; renderGz();
  msg("#gzMsg", `${ok} produit${ok > 1 ? "s" : ""} importé${ok > 1 ? "s" : ""}${gzStop ? " (arrêté)" : ""}.` +
    (failed.length ? `<br>${failed.length} échec(s) : ${failed.slice(0, 5).map(esc).join("<br>")}` : "") +
    (photoErrors.length ? `<br>${photoErrors.length} photo(s) non récupérée(s). Raison : ${esc([...new Set(photoErrors)].slice(0, 3).join(" | "))}` : ""),
    failed.length || photoErrors.length ? "err" : "ok");
};

if (password) start().catch(() => logout());
