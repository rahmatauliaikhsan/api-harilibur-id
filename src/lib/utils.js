/**
 * Util tanggal (zero-dependency).
 * Semua perhitungan hari memakai UTC murni pada string ISO "YYYY-MM-DD"
 * supaya tidak terpengaruh timezone mesin/server.
 */

export const REFERENCE_TIMEZONE = process.env.REFERENCE_TIMEZONE || "Asia/Jakarta";

export const ID_DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

export const ID_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** Alias ejaan bulan yang muncul di dokumen/berita resmi. */
const MONTH_ALIASES = {
  januari: 1,
  pebruari: 2,
  februari: 2,
  febuari: 2,
  maret: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  september: 9,
  oktober: 10,
  nopember: 11,
  november: 11,
  desember: 12,
};

const MONTH_PAD = (n) => String(n).padStart(2, "0");

/** "2026-1-5" / "2026/01/05" -> "2026-01-05" atau null. */
export function normalizeDateString(input) {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  return buildISO(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Bangun string ISO dan validasi kalender (menolak 2026-02-30). */
export function buildISO(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${MONTH_PAD(month)}-${MONTH_PAD(day)}`;
}

/** Nomor bulan (1-12) dari nama bulan Indonesia/alias, null bila tidak dikenal. */
export function monthNumberFromName(name) {
  if (typeof name !== "string") return null;
  return MONTH_ALIASES[name.trim().toLowerCase()] ?? null;
}

/** Epoch ms pada 00:00 UTC untuk tanggal ISO. */
export function toEpochUTC(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isValidISODate(isoDate) {
  return normalizeDateString(isoDate) === isoDate;
}

export function addDaysISO(isoDate, amount) {
  const epoch = toEpochUTC(isoDate);
  if (Number.isNaN(epoch)) return null;
  return new Date(epoch + amount * 86400000).toISOString().slice(0, 10);
}

/** 0 = Minggu ... 6 = Sabtu. */
export function dayOfWeek(isoDate) {
  const epoch = toEpochUTC(isoDate);
  if (Number.isNaN(epoch)) return null;
  return new Date(epoch).getUTCDay();
}

export function dayNameID(isoDate) {
  const dow = dayOfWeek(isoDate);
  return dow === null ? null : ID_DAYS[dow];
}

export function isWeekendISO(isoDate) {
  const dow = dayOfWeek(isoDate);
  return dow === 6 || dow === 0;
}

export function yearOf(isoDate) {
  return isValidISODate(isoDate) ? Number(isoDate.slice(0, 4)) : null;
}

/** Tanggal "hari ini" menurut timezone referensi (default Asia/Jakarta). */
export function todayISO(timeZone = REFERENCE_TIMEZONE, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

/** Waktu sekarang (ISO string) di timezone referensi, lengkap offset. */
export function nowISO(now = new Date()) {
  return now.toISOString();
}

export function uniqueBy(array, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of array) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function sortByDate(entries) {
  return [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Escape karakter khusus iCalendar. */
export function escapeICS(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
