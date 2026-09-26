/**
 * Parser halaman resmi SKB 3 Menteri (setkab.go.id, setneg.go.id, kemenkopmk.go.id).
 *
 * Strategi:
 *  1. HTML -> teks (batas blok jadi newline).
 *  2. Temukan "section": header yang memuat "hari libur nasional" / "cuti bersama"
 *     diikuti ":" dan isi yang padat nama bulan.
 *  3. Tokenisasi item: <angka>[, angka][-angka] <Nama Bulan> [(Hari)]: <nama>;
 *     nama diambil dari teks di antara 2 item (aman untuk format `1.`, `-`, `•`,
 *     maupun daftar berderet dalam satu paragraf).
 *  4. Validasi nama hari di dalam tanda kurung terhadap hitungan kalender.
 */

import { buildISO, dayNameID, monthNumberFromName } from "./utils.js";

const MONTH_NAMES =
  "Januari|Pebruari|Februari|Febuari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|Nopember|November|Desember";

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&ndash;": "–",
  "&mdash;": "—",
  "&minus;": "−",
  "&hellip;": "…",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&lt;": "<",
  "&gt;": ">",
  "&raquo;": "»",
  "&laquo;": "«",
};

/** Frasa yang menandakan daftar sudah berakhir (junk navigasi/penutup artikel). */
const STOP_PHRASES = [
  "Sementara",
  "Selanjutnya",
  "Link Download",
  "Long Weekend",
  "Berikut ketentuan",
  "Baca juga",
  "Baca Juga",
  "Adapun",
  "Kontributor",
  "Reporter",
  "Humas",
  "Dokumen SKB",
  "SCROLL",
  "ADVERTISEMENT",
  "Bagaimana pendapat",
  "Kendati",
  "Simak",
  "Ketentuan cuti bersama",
];

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, code) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const num = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : raw;
    }
    return ENTITIES[`&${code.toLowerCase()};`] ?? raw;
  });
}

/** HTML -> teks dengan batas blok sebagai newline. */
export function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|li|div|h[1-6]|tr|table|ul|ol|section|article|blockquote)\s*>/gi, "\n");
  text = text.replace(/<(p|li|div|h[1-6]|tr|ul|ol|section|article|blockquote)\b[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/[ \t]*\n[ \t]*/g, "\n");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
}

function stripListMarkers(line) {
  return line.replace(/^\s*(?:[-–—•*·]|\d{1,3}[.)])\s+/, "").trim();
}

function countMonthNames(text) {
  const matches = text.match(new RegExp(`\\b(?:${MONTH_NAMES})\\b`, "gi"));
  return matches ? matches.length : 0;
}

/** Bersihkan teks nama kegiatan dari penanda daftar/heading/junk. */
export function cleanEntryName(raw, { maxLength = 120 } = {}) {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/\r/g, "");
  for (const phrase of STOP_PHRASES) {
    const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (idx > 0) text = text.slice(0, idx);
  }
  text = stripListMarkers(text.split("\n")[0] ?? "");
  text = text.replace(/\s+/g, " ").trim();
  // buang sisa penanda daftar dari item berikutnya, mis. "Idulfitri 1446 H 2."
  text = text.replace(/\s*\d{1,3}\s*[.)]$/, "");
  text = text.replace(/^[-–—:;,.\s]+/, "").replace(/[-–—:;,.\s]+$/, "");
  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text.length ? text : null;
}

function isContinuationText(text) {
  if (text === null) return false;
  return text.length <= 4 && /^[-–—,dan\s.)]*$/i.test(text);
}

const ITEM_RE = () =>
  new RegExp(
    String.raw`(\d{1,2}(?:\s*[–—\-]\s*\d{1,2})?(?:\s*(?:,\s*(?:dan\s+)?|dan\s+)\d{1,2}(?:\s*[–—\-]\s*\d{1,2})?)*)` +
      String.raw`\s+(${MONTH_NAMES})\b(?:\s+(\d{4}))?` +
      String.raw`\s*(?:\(([^)]*)\))?\s*[:.]?`,
    "gi",
  );

/**
 * Pecah satu blok daftar menjadi entri:
 * { date, name, type, warnings }
 */
export function parseItemList(sectionText, { year, type, sourceUrl, sourceKind = "official-parsed" } = {}) {
  const text = sectionText.replace(/\r/g, "");
  const re = ITEM_RE();
  const matches = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      numbers: match[1],
      monthName: match[2],
      year: match[3] ? Number(match[3]) : null,
      weekdayText: match[4] ?? "",
    });
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }

  const items = [];
  let pending = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    pending.push(current);
    const tailEnd = i + 1 < matches.length ? matches[i + 1].start : Math.min(text.length, current.end + 200);
    const between = cleanEntryName(text.slice(current.end, tailEnd));
    if (between === null) continue;
    if (isContinuationText(between) && i + 1 < matches.length) continue;
    items.push({ parts: pending, name: isContinuationText(between) ? null : between });
    pending = [];
  }
  if (pending.length) items.push({ parts: pending, name: null });

  const entries = [];
  for (const item of items) {
    const warnings = [];
    const dates = [];
    const weekdayTokens = [];
    for (const part of item.parts) {
      const monthNumber = monthNumberFromName(part.monthName);
      const itemYear = part.year ?? year;
      if (!monthNumber || !itemYear) {
        warnings.push("bulan_atau_tahun_tidak_dikenal");
        continue;
      }
      const numbers = [...part.numbers.matchAll(/\d{1,2}/g)].map((n) => Number(n[0]));
      for (const day of numbers) {
        const iso = buildISO(itemYear, monthNumber, day);
        if (!iso) warnings.push(`tanggal_tidak_valid:${itemYear}-${part.monthName}-${day}`);
        else dates.push(iso);
      }
      weekdayTokens.push(
        ...part.weekdayText
          .split(/,|\bdan\b|&/i)
          .map((token) => token.trim())
          .filter(Boolean),
      );
    }

    if (weekdayTokens.length && weekdayTokens.length === dates.length) {
      dates.forEach((iso, index) => {
        const computed = dayNameID(iso);
        const written = weekdayTokens[index];
        if (computed && written && !computed.toLowerCase().startsWith(written.slice(0, 3).toLowerCase())) {
          warnings.push(`hari_tidak_cocok:${iso}:${written}!=${computed}`);
        }
      });
    } else if (weekdayTokens.length) {
      warnings.push("jumlah_nama_hari_tidak_sesuai");
    }

    if (!dates.length) continue;
    const name = item.name ?? "";
    if (!name) warnings.push("nama_kosong");
    for (const date of dates) {
      entries.push({
        date,
        name: name || null,
        type,
        sourceKind,
        sourceUrl: sourceUrl ?? null,
        warnings,
      });
    }
  }
  return entries;
}

/** Metadata SKB (nomor surat, tanggal tanda tangan) — best effort. */
export function extractSkbMetadata(text, year) {
  const flat = text.replace(/\s+/g, " ");
  const numbers = [];
  const numberRe = /Nomor\s*:?\s*(\d{1,5})\s*(?:Tahun\s*(\d{4}))?/gi;
  let m;
  while ((m = numberRe.exec(flat)) !== null) {
    numbers.push({ number: m[1], year: m[2] ? Number(m[2]) : null });
  }

  let signedAt = null;
  const numericDate = flat.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
  const wordDate = flat.match(/(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})/);
  if (numericDate) {
    signedAt = buildISO(Number(numericDate[3]), Number(numericDate[2]), Number(numericDate[1]));
  } else if (wordDate) {
    const monthNumber = monthNumberFromName(wordDate[2]);
    if (monthNumber) signedAt = buildISO(Number(wordDate[3]), monthNumber, Number(wordDate[1]));
  }

  const titleMatch = flat.match(/tentang\s+Hari\s+Libur\s+Nasional\s+dan\s+Cuti\s+Bersama\s+Tahun\s+(20\d{2})/i);
  const counts = flat.match(
    /hari\s+libur\s+nasional\s+(?:adalah\s+)?sebanyak\s+(\d{1,3})\s+hari\s+dan\s+(?:hari\s+)?cuti\s+bersama\s+(?:sebanyak\s+)?(\d{1,3})\s+hari/i,
  );
  return {
    title: titleMatch ? `Hari Libur Nasional dan Cuti Bersama Tahun ${titleMatch[1]}` : null,
    declaredYear: titleMatch ? Number(titleMatch[1]) : year ?? null,
    numbers: numbers.slice(0, 4),
    signedAt,
    declaredCounts: counts
      ? { national_holiday: Number(counts[1]), joint_leave: Number(counts[2]) }
      : null,
    isAmendment: /tentang\s+Perubahan\s+Atas/i.test(flat),
  };
}

/**
 * Parse penuh satu halaman resmi SKB.
 * @returns {{ year:number|null, sections:Array, entries:Array, metadata:object, warnings:string[] }}
 */
export function parseOfficialHolidayPage(html, { year = null, url = null } = {}) {
  const text = htmlToText(html);
  const warnings = [];
  let targetYear = year;
  if (!targetYear) {
    const yearMatch = text.match(/Cuti\s+Bersama\s+Tahun\s+(20\d{2})/i) ?? text.match(/\b(20\d{2})\b/);
    targetYear = yearMatch ? Number(yearMatch[1]) : null;
  }

  const sections = findSections(text, { expectedYear: targetYear });
  const entries = [];
  for (const section of sections) {
    const parsed = parseItemList(section.text, {
      year: section.year ?? targetYear,
      type: section.type,
      sourceUrl: url,
    });
    if (!parsed.length) warnings.push(`section_kosong:${section.type}`);
    entries.push(...parsed);
  }
  if (!entries.length) warnings.push("tidak_ada_entri_terparse");

  const metadata = extractSkbMetadata(text, targetYear);
  if (metadata.declaredCounts) {
    const counts = {};
    for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    for (const [type, declared] of Object.entries(metadata.declaredCounts)) {
      const parsedCount = counts[type] ?? 0;
      if (declared !== parsedCount) warnings.push(`jumlah_${type}_berbeda:${parsedCount}!=${declared}`);
    }
  }
  return { year: targetYear ?? metadata.declaredYear ?? null, sections, entries, metadata, warnings };
}

/** Frasa penutup section: daftar SKB tidak pernah melewati penanda ini. */
const SECTION_STOP_RE =
  /(Berita\/Artikel Terkait|Berita Terkait|Berita Terbaru|Baca [Jj]uga|Bagaimana pendapat|Daftar Long Weekend|Link Download|Kontributor|Reporter|Humas|SCROLL|ADVERTISEMENT|Artikel Terkait|Dipublikasikan pada|Kategori:)/i;

/** Temukan section daftar libur nasional / cuti bersama di dalam teks artikel. */
export function findSections(text, { expectedYear } = {}) {
  const headerRe = new RegExp(
    String.raw`(hari\s+libur\s+nasional|hari\s+cuti\s+bersama|cuti\s+bersama)\b[^\n:]{0,70}?[:：]`,
    "gi",
  );
  const candidates = [];
  let header;
  while ((header = headerRe.exec(text)) !== null) {
    const start = header.index + header[0].length;
    const probe = text.slice(start, start + 700);
    const monthCount = countMonthNames(probe);
    const looksLikeListHeader = /daftar|berikut|yaitu|yakni|rincian/i.test(header[0]);
    if (monthCount < 3 && !(monthCount >= 1 && looksLikeListHeader)) continue;
    const headerText = header[0].toLowerCase();
    const isJoint = headerText.includes("cuti bersama") && !headerText.includes("hari libur nasional");
    candidates.push({
      start,
      headerIndex: header.index,
      type: isJoint ? "joint_leave" : "national_holiday",
      headerText: header[0],
    });
  }

  return candidates.map((candidate, index) => {
    const endOfSection = index + 1 < candidates.length ? candidates[index + 1].headerIndex : text.length;
    let raw = text.slice(candidate.start, endOfSection);
    // Buang ekor artikel (berita terkait, penutup, dsb.) agar tidak masuk ke daftar.
    const stop = SECTION_STOP_RE.exec(raw);
    if (stop && stop.index > 40) raw = raw.slice(0, stop.index);
    if (raw.length > 8000) raw = raw.slice(0, 8000);
    const yearInText = Number((raw.match(/\b(20\d{2})\b/) ?? [])[1] ?? expectedYear ?? 0);
    return {
      type: candidate.type,
      headerText: candidate.headerText,
      year: yearInText || expectedYear || null,
      text: raw,
    };
  });
}
