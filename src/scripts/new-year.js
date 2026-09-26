#!/usr/bin/env node
/**
 * Skrip penyusun dataset SKB untuk tahun yang belum ada (`npm run new-year`).
 *
 * Tujuannya: tahun baru (mis. 2029) tetap punya jawaban meski SKB resmi belum
 * terbit. Semua entri hasil diberi `tentative: true` dan `status: "draft"` supaya
 * konsumen tahu datanya belum final dan tidak boleh dipakai untuk keputusan resmi.
 *
 * Contoh:
 *   node src/scripts/new-year.js                    # tahun depan, simulasi saja
 *   node src/scripts/new-year.js --year 2029 --write # tulis data/skb/2029.json
 *   node src/scripts/new-year.js --year 2029 --write --force
 *
 * Catatan penting: cuti bersama tidak pernah ada di feed komunitas, sehingga
 * tahun berstatus "draft" HANYA berisi hari libur nasional.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HolidayStore } from "../lib/store.js";
import { sortByDate, todayISO, uniqueBy, yearOf } from "../lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, "cache");

function parseArgs(argv) {
  const args = { year: null, write: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--year") {
      args.year = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
    } else if (arg === "--write" || arg === "-w") args.write = true;
    else if (arg === "--force" || arg === "-f") args.force = true;
  }
  return args;
}

/** Nama kegiatan yang perlu dibersihkan agar konsisten dengan gaya penulisan dataset resmi. */
function normalizeName(name) {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*\)\s*/g, " ")
    .trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentYear = Number(todayISO().slice(0, 4));
  const year = Number.isFinite(args.year) ? args.year : currentYear + 1;

  if (year < 2020 || year > currentYear + 5) {
    console.error(`[new-year] tahun ${year} di luar rentang wajar (2020-${currentYear + 5})`);
    process.exitCode = 1;
    return;
  }

  const store = await new HolidayStore({ dataDir: DATA_DIR, cacheDir: CACHE_DIR }).init();
  const curatedYears = store.curatedYears();
  console.log(`[new-year] tahun terkurasi saat ini: ${curatedYears.join(", ") || "(kosong)"}`);
  if (curatedYears.includes(year) && !args.force) {
    console.log(`[new-year] data/skb/${year}.json sudah ada. Gunakan --force untuk menimpa.`);
    return;
  }

  const source = (store.community?.entries ?? []).filter(
    (entry) => yearOf(entry.date) === year && entry.type === "national_holiday",
  );
  const entries = uniqueBy(sortByDate(source), (entry) => entry.date).map((entry) => ({
    date: entry.date,
    name: normalizeName(entry.name),
    type: "national_holiday",
    tentative: true,
  }));

  const payload = {
    year,
    status: "draft",
    skb: {
      title: `Hari Libur Nasional dan Cuti Bersama Tahun ${year}`,
      numbers: [],
      signedAt: null,
      sourceUrl: null,
      amendments: [],
    },
    entries,
    notes: [
      `Draft otomatis: disusun dari feed komunitas, BELUM berdasarkan SKB 3 Menteri resmi.`,
      `SKB biasanya terbit sekitar September-November tahun sebelumnya; jalankan "npm run refresh" setelah artikel resmi terbit.`,
      `Cuti bersama belum dapat diketahui dan akan ditambahkan setelah SKB resmi diurai.`,
      `Ubah status menjadi "official" dan hapus flag tentative hanya setelah mencocokkan dengan lampiran SKB resmi.`,
    ],
  };

  const target = path.join(DATA_DIR, "skb", `${year}.json`);
  console.log(`[new-year] ${year}: ${entries.length} hari libur nasional (status draft, tentative)`);
  for (const entry of entries) console.log(`  - ${entry.date}  ${entry.name}`);
  if (!entries.length) console.log("  (feed komunitas belum punya data untuk tahun ini)");

  if (!args.write) {
    console.log(`[new-year] mode simulasi. Tambahkan --write untuk menyimpan ${path.relative(ROOT_DIR, target)}`);
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[new-year] ditulis: ${path.relative(ROOT_DIR, target)}`);
}

main().catch((error) => {
  console.error("[new-year] gagal:", error);
  process.exitCode = 1;
});
