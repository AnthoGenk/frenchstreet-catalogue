# French Street — Catalogue

- `public/` : catalogue public (`/`) et administration (`/admin.html`)
- `netlify/functions/api.mjs` : API (lecture publique, import d'URL, ajout/modif/suppression protégés)
- `lib/extract.mjs` : extraction produit (Schema.org JSON-LD → Open Graph → Shopify → HTML)
- `lib/store.mjs` : stockage Netlify Blobs (produits + photos copiées)

## Mise en ligne (Netlify)
1. Netlify → Add new project → Import from GitHub → ce dépôt. Aucun réglage de build à changer.
2. Project configuration → Environment variables → `ADMIN_PASSWORD` = mot de passe long (12+ caractères).
3. Redéployer une fois. Catalogue : `https://<site>.netlify.app` · Admin : `https://<site>.netlify.app/admin.html`

Ajouter des produits ne redéploie pas le site (données dans Netlify Blobs) : ça ne coûte pas de crédits de déploiement.

## Test local
`LOCAL_STORE_DIR=./.data ADMIN_PASSWORD=test npx netlify dev`
