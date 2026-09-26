import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HolidayStore } from "../src/lib/store.js";
import { createServer, config } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

let serverPromise = null;

function resolveDataPaths() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(process.cwd(), "data"),
    path.join(ROOT_DIR, "data"),
    path.join("/var/task", "data"),
  ].filter(Boolean);

  let dataDir = path.join(ROOT_DIR, "data");
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      dataDir = c;
      break;
    }
  }

  const cacheCandidates = [
    process.env.CACHE_DIR,
    path.join(dataDir, "cache"),
    path.join(process.cwd(), "data", "cache"),
  ].filter(Boolean);

  let cacheDir = path.join(dataDir, "cache");
  for (const c of cacheCandidates) {
    if (fs.existsSync(c)) {
      cacheDir = c;
      break;
    }
  }

  return { dataDir, cacheDir };
}

async function getServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      const { dataDir, cacheDir } = resolveDataPaths();
      const store = await new HolidayStore({
        dataDir,
        cacheDir,
        refreshTtlMs: config.refreshTtlMs,
      }).init();

      return createServer({ store });
    })();
  }
  return serverPromise;
}

export default async function handler(req, res) {
  try {
    // Di lingkungan Vercel rewrites, path asli dikirimkan di header x-matched-path atau x-now-route-matches
    const originalUrl =
      req.headers["x-matched-path"] ||
      req.headers["x-vercel-matched-path"] ||
      req.headers["x-forwarded-uri"] ||
      req.url;

    if (originalUrl && originalUrl !== req.url && !originalUrl.startsWith("/api/index")) {
      req.url = originalUrl;
    }

    const server = await getServer();
    server.emit("request", req, res);
  } catch (err) {
    console.error("[vercel-handler] Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Internal Server Error", message: err.message, stack: err.stack }));
  }
}


