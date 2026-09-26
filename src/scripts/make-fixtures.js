#!/usr/bin/env node
/**
 * Ambil potongan HTML asli dari halaman resmi SKB dan simpan sebagai fixture
 * pengujian parser (test/fixtures/*.html).
 *
 *   node src/scripts/make-fixtures.js
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "test", "fixtures");

const TARGETS = [
  {
    file: "setneg-2026.html",
    url: "https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026",
    start: /Berikut daftar lengkap hari libur nasional/i,
    stop: /Bagaimana pendapat anda|Baca juga|Berita\/Artikel Terkait/i,
  },
  {
    file: "kemenkopmk-2027.html",
    url: "https://www.kemenkopmk.go.id/index.php/pemerintah-tetapkan-18-hari-libur-nasional-dan-8-cuti-bersama-tahun-2027",
    start: /Hari Libur Nasional Tahun\s+20\d{2}\s*:/i,
    stop: /Kontributor Foto|Reporter:|Berita dan Artikel Terkait/i,
  },
  {
    file: "setkab-2025.html",
    url: "https://setkab.go.id/pemerintah-tetapkan-hari-libur-nasional-dan-cuti-bersama-tahun-2025/",
    start: /Berikut daftar lengkap hari libur nasional/i,
    stop: /Humas Kemenko PMK|Berita Terbaru|Dipublikasikan/i,
  },
];

async function grab(target) {
  const response = await fetch(target.url, {
    headers: { "user-agent": "api-harilibur-id/1.0 (fixture generator)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} untuk ${target.url}`);
  const html = await response.text();
  const startMatch = target.start.exec(html);
  if (!startMatch) throw new Error(`penanda awal tidak ditemukan di ${target.url}`);
  const tail = html.slice(startMatch.index);
  const stopMatch = target.stop.exec(tail);
  const snippet = tail.slice(0, stopMatch ? stopMatch.index : Math.min(tail.length, 20000));
  const wrapped = `<!doctype html>\n<html lang="id">\n<body>\n<article>\n${snippet}\n</article>\n</body>\n</html>\n`;
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(path.join(FIXTURE_DIR, target.file), wrapped, "utf8");
  return { file: target.file, bytes: Buffer.byteLength(wrapped), url: target.url };
}

const results = [];
for (const target of TARGETS) {
  try {
    results.push(await grab(target));
  } catch (error) {
    console.error(`[fixtures] gagal ${target.file}: ${error.message}`);
  }
}
for (const result of results) {
  console.log(`[fixtures] ${result.file} — ${result.bytes} bytes dari ${result.url}`);
}
