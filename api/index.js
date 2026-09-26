import path from "node:path";
import { fileURLToPath } from "node:url";
import { HolidayStore } from "../src/lib/store.js";
import { createServer, config } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

let serverPromise = null;

async function getServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      const dataDir = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
      const cacheDir = process.env.CACHE_DIR || path.join(ROOT_DIR, "data", "cache");
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
    const server = await getServer();
    server.emit("request", req, res);
  } catch (err) {
    console.error("[vercel-handler] Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Internal Server Error", message: err.message }));
  }
}
