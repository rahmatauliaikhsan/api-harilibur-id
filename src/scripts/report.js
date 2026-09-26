#!/usr/bin/env node
/**
 * Menyusun ringkasan hasil refresh dalam bentuk Markdown (`npm run report`).
 * Dipakai GitHub Actions untuk Step Summary dan sebagai payload notifikasi.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HolidayStore } from "../lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, "cache");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const store = await new HolidayStore({ dataDir: DATA_DIR, cacheDir: CACHE_DIR }).init();
const state = await store.updater.readState();
const official = state?.lastRun?.results?.official ?? null;
const community = state?.lastRun?.results?.community ?? null;
const errors = state?.errors ?? [];

const lines = [];
lines.push("### Ringkasan pemutakhiran data");
lines.push("");
lines.push(`- Waktu refresh: ${state?.lastRun?.finishedAt ?? "tidak diketahui"}`);
lines.push(
  `- Status sumber resmi: ${state?.official?.ok ? "berhasil" : "gagal/tidak ada artikel baru"}`,
);
lines.push(`- Status sumber komunitas: ${state?.community?.ok ? "berhasil" : "gagal"}`);
lines.push("");

lines.push("| Tahun | Status | Sumber | Tanggal merah | SKB |");
lines.push("| --- | --- | --- | --- | --- |");
for (const item of store.listYears()) {
  const status = item.status === "draft" ? "draft (belum resmi)" : item.status;
  lines.push(
    `| ${item.year} | ${status} | ${item.sourceKind} | ${item.counts.tanggal_merah} | ${
      item.skb?.signedAt ?? "-"
    } |`,
  );
}
lines.push("");

if (official?.results?.length) {
  lines.push("#### Artikel resmi yang diperiksa");
  for (const result of official.results) {
    lines.push(
      `- ${result.year} — ${result.status} via ${result.via} (${result.sourceId}) ${JSON.stringify(
        result.counts ?? {},
      )}`,
    );
    for (const warning of result.warnings ?? []) lines.push(`  - peringatan: ${warning}`);
  }
  lines.push("");
}

if (errors.length) {
  lines.push(`#### Error sumber (${errors.length}, 5 terakhir)`);
  for (const error of errors.slice(-5)) lines.push(`- ${error.source ?? "?"}: ${error.error}`);
  lines.push("");
}

const ageDays = state?.lastRun?.finishedAt
  ? Math.round((Date.now() - Date.parse(state.lastRun.finishedAt)) / 86_400_000)
  : null;
lines.push(`_Usia data: ${ageDays === null ? "tidak diketahui" : `${ageDays} hari`}_`);

console.log(lines.join("\n"));
