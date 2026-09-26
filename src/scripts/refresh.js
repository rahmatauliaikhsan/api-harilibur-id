#!/usr/bin/env node
/**
 * CLI pemutakhiran data (`npm run refresh`).
 *
 * Contoh:
 *   node src/scripts/refresh.js                  # resmi + komunitas (hormati TTL)
 *   node src/scripts/refresh.js --force          # paksa ambil ulang semua sumber
 *   node src/scripts/refresh.js --official       # hanya artikel resmi SKB
 *   node src/scripts/refresh.js --community      # hanya feed komunitas
 *   node src/scripts/refresh.js --years 2028,2029
 *   node src/scripts/refresh.js --dry-run        # tidak menulis cache, hanya menampilkan hasil
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { HolidayStore } from "../lib/store.js";
import { Updater } from "../lib/updater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, "cache");

function parseArgs(argv) {
  const args = { force: false, dryRun: false, years: null, sources: ["official", "community"] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force" || arg === "-f") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--official") args.sources = ["official"];
    else if (arg === "--community") args.sources = ["community"];
    else if (arg === "--years") {
      args.years = String(argv[i + 1] ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter(Number.isFinite);
      i += 1;
    }
  }
  return args;
}

function diffYears(store, parsedByYear) {
  const lines = [];
  for (const [year, entries] of parsedByYear) {
    const known = new Map(
      store.yearData(Number(year)).entries
        .filter((entry) => entry.is_tanggal_merah)
        .map((entry) => [entry.date, entry]),
    );
    const parsed = new Map(entries.map((entry) => [entry.date, entry]));
    const added = [...parsed.keys()].filter((date) => !known.has(date)).sort();
    const removed = [...known.keys()].filter((date) => !parsed.has(date)).sort();
    const renamed = [...parsed.keys()]
      .filter((date) => {
        if (!known.has(date)) return false;
        const a = (known.get(date).name ?? "").toLowerCase();
        const b = (parsed.get(date).name ?? "").toLowerCase();
        return a && b && !a.includes(b.slice(0, 12)) && !b.includes(a.slice(0, 12));
      })
      .sort();
    lines.push(
      `  • ${year}: parse=${parsed.size} tersimpan=${known.size} +${added.length} -${removed.length} ~${renamed.length}`,
    );
    if (added.length) lines.push(`      tanggal baru    : ${added.join(", ")}`);
    if (removed.length) lines.push(`      hilang/berubah : ${removed.join(", ")}`);
    if (renamed.length) {
      for (const date of renamed) {
        lines.push(`      nama berbeda   : ${date} "${known.get(date).name}" -> "${parsed.get(date).name}"`);
      }
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = await new HolidayStore({ dataDir: DATA_DIR, cacheDir: CACHE_DIR }).init();
  const updater = new Updater({
    cacheDir: CACHE_DIR,
    curatedYears: store.curatedYears(),
    log: console,
  });

  if (args.dryRun) {
    const write = updater.writeCache.bind(updater);
    let skipped = 0;
    updater.writeCache = async () => {
      skipped += 1;
      return "<dry-run>";
    };
    updater.mergeState = async () => ({ "<dry-run>": true });
    void write;
    console.log(`[refresh] mode dry-run: cache tidak ditulis (${skipped} file dilewati)`);
  }

  console.log(`[refresh] tahun terkurasi: ${store.curatedYears().join(", ") || "(kosong)"}`);
  const summary = await updater.run({
    years: args.years,
    sources: args.sources,
    force: args.force,
    ttlMs: args.force ? 0 : undefined,
  });

  const official = summary.results.official;
  if (official) {
    console.log(`[refresh] artikel resmi: ${official.articleCount} tersimpan, ${official.results.length} diperiksa`);
    for (const result of official.results) {
      const counts = Object.entries(result.counts ?? {})
        .map(([type, count]) => `${type}=${count}`)
        .join(" ");
      console.log(
        `  - [${result.status}] ${result.year} via ${result.via} (${result.sourceId}) ${counts}` +
          (result.warnings?.length ? ` warnings=${result.warnings.length}` : ""),
      );
      if (result.warnings?.length) console.log(`      ${result.warnings.join(" | ")}`);
    }
    if (official.errors?.length) console.log(`  ! error: ${JSON.stringify(official.errors, null, 2)}`);
  }

  const community = summary.results.community;
  if (community) {
    console.log(`[refresh] komunitas: ${community.entryCount} entri dari ${community.sources.length} endpoint`);
    for (const source of community.sources) {
      console.log(`  - ${source.ok ? "ok" : "gagal"} ${source.id} (${source.count ?? 0} entri)`);
    }
  }

  if (summary.skipped.length) console.log(`[refresh] dilewati (cache masih segar): ${summary.skipped.join(", ")}`);

  await store.reload();
  const parsedByYear = new Map();
  for (const article of store.official.articles ?? []) {
    if (article.status !== "accepted") continue;
    const list = parsedByYear.get(article.year) ?? [];
    list.push(...article.entries.filter((entry) => entry.type !== "observance"));
    parsedByYear.set(article.year, list);
  }
  if (parsedByYear.size) {
    console.log("[refresh] perbandingan hasil parse vs data tersimpan:");
    console.log(diffYears(store, parsedByYear));
  }
  console.log(`[refresh] selesai dalam ${Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)} ms`);
}

main().catch((error) => {
  console.error("[refresh] gagal:", error);
  process.exitCode = 1;
});
