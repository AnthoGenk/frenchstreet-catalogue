// Stockage : Netlify Blobs en ligne, dossier local pour les tests (LOCAL_STORE_DIR).
import { getStore } from "@netlify/blobs";
import fs from "node:fs/promises";
import path from "node:path";

export function store(name) {
  const dir = process.env.LOCAL_STORE_DIR;
  if (!dir) return getStore({ name, consistency: "strong" });
  const base = path.join(dir, name);
  const file = (k) => path.join(base, encodeURIComponent(k));
  return {
    async get(k, { type } = {}) {
      try {
        const b = await fs.readFile(file(k));
        return type === "json" ? JSON.parse(b) : b.toString();
      } catch { return null; }
    },
    async getWithMetadata(k) {
      try {
        const data = await fs.readFile(file(k));
        const metadata = JSON.parse(await fs.readFile(file(k) + ".meta", "utf8"));
        return { data: new Uint8Array(data).buffer, metadata };
      } catch { return null; }
    },
    async set(k, v, { metadata } = {}) {
      await fs.mkdir(base, { recursive: true });
      await fs.writeFile(file(k), Buffer.from(v));
      if (metadata) await fs.writeFile(file(k) + ".meta", JSON.stringify(metadata));
    },
    async setJSON(k, v) {
      await fs.mkdir(base, { recursive: true });
      await fs.writeFile(file(k), JSON.stringify(v));
    },
    async delete(k) {
      await fs.rm(file(k), { force: true });
      await fs.rm(file(k) + ".meta", { force: true });
    },
  };
}
