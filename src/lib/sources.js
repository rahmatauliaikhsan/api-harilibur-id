/**
 * Definisi sumber data.
 *
 * kind:
 *  - "official"  : halaman resmi pemerintah (SKB 3 Menteri) -> prioritas tertinggi
 *  - "community" : feed komunitas yang ikut ter-update (pelengkap + deteksi dini)
 */

export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25000);

/** Jeda sopan antar permintaan (situs pemerintah bisa membatasi burst request). */
export const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS || 300);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const FETCH_HEADERS = {
  "user-agent":
    process.env.HTTP_USER_AGENT ||
    "api-harilibur-id/1.0 (+https://github.com/; pemantau SKB 3 Menteri hari libur nasional)",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

export async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, headers = FETCH_HEADERS } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

export async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} untuk ${url}`);
    error.status = response.status;
    throw error;
  }
  return { text: await response.text(), url: response.url, status: response.status };
}

export async function fetchJson(url, options = {}) {
  const { text, url: finalUrl } = await fetchText(url, options);
  return { json: JSON.parse(text), url: finalUrl, raw: text };
}

/* ------------------------------------------------------------------ *
 * Sumber komunitas
 * ------------------------------------------------------------------ */

export const COMMUNITY_SOURCES = [
  {
    id: "guangrei-calendar",
    label: "APIHariLibur_V2 (guangrei) — calendar.json",
    homepage: "https://github.com/guangrei/APIHariLibur_V2",
    url: () => "https://raw.githubusercontent.com/guangrei/APIHariLibur_V2/main/calendar.json",
    type: "json",
  },
  {
    id: "nager-date-id",
    label: "Nager.Date — PublicHolidays (ID)",
    homepage: "https://date.nager.at",
    url: (year) => `https://date.nager.at/api/v3/PublicHolidays/${year}/ID`,
    type: "json",
  },
];

/** Normalisasi calendar.json guangrei -> entri standar. */
export function normalizeGuangreiCalendar(json) {
  const entries = [];
  const info = json && typeof json === "object" ? json.info ?? {} : {};
  for (const [key, value] of Object.entries(json ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== "object") continue;
    const summaries = Array.isArray(value.summary) ? value.summary : [value.summary].filter(Boolean);
    const descriptions = Array.isArray(value.description) ? value.description : [value.description ?? ""];
    const name = summaries.join(" / ").trim() || null;
    const isHoliday = value.holiday === true;
    const isJoint = /^\s*(cuti bersama|joint holiday)/i.test(String(name ?? ""));
    const type = isHoliday ? (isJoint ? "joint_leave" : "national_holiday") : "observance";
    entries.push({
      date: key,
      name,
      type,
      tentative: /belum pasti|unconfirmed|tentative/i.test(String(name)),
      sourceId: "guangrei-calendar",
      metadata: { descriptions, upstreamUpdated: info.updated ?? null },
    });
  }
  return entries;
}

/** Normalisasi Nager.Date -> entri standar (hanya libur nasional). */
export function normalizeNagerDate(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((item) => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date ?? ""))
    .map((item) => ({
      date: item.date,
      name: item.localName || item.name || null,
      type: "national_holiday",
      tentative: false,
      sourceId: "nager-date-id",
      metadata: { englishName: item.name ?? null },
    }));
}

/* ------------------------------------------------------------------ *
 * Sumber resmi (SKB 3 Menteri)
 * ------------------------------------------------------------------ */

export const OFFICIAL_PROVIDERS = [
  {
    id: "setkab",
    label: "Sekretariat Kabinet RI — setkab.go.id",
    homepage: "https://setkab.go.id",
  },
  {
    id: "setneg",
    label: "Kementerian Sekretariat Negara — setneg.go.id",
    homepage: "https://www.setneg.go.id",
  },
  {
    id: "kemenkopmk",
    label: "Kemenko PMK — kemenkopmk.go.id",
    homepage: "https://www.kemenkopmk.go.id",
  },
];

/** Feed RSS resmi: deteksi cepat artikel SKB baru / perubahan SKB. */
export const OFFICIAL_FEEDS = [
  {
    id: "setkab-feed",
    sourceId: "setkab",
    label: "RSS Sekretariat Kabinet",
    url: "https://setkab.go.id/feed/",
  },
  {
    id: "kemenkopmk-feed",
    sourceId: "kemenkopmk",
    label: "RSS Kemenko PMK",
    url: "https://www.kemenkopmk.go.id/rss.xml",
  },
];

/** Pola URL artikel SKB yang sudah terverifikasi (diuji langsung terhadap sumbernya). */
export const OFFICIAL_SLUG_TEMPLATES = [
  {
    sourceId: "setneg",
    label: "setneg — Inilah SKB 3 Menteri (paling andal)",
    url: (year) => `https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_${year}`,
  },
  {
    sourceId: "setkab",
    label: "setkab — Pemerintah Tetapkan Hari Libur Nasional",
    url: (year) => `https://setkab.go.id/pemerintah-tetapkan-hari-libur-nasional-dan-cuti-bersama-tahun-${year}/`,
  },
  {
    sourceId: "setkab",
    label: "setkab — Inilah SKB 3 Menteri Libur Nasional",
    url: (year) => `https://setkab.go.id/inilah-skb-3-menteri-libur-nasional-dan-cuti-bersama-${year}/`,
  },
  {
    sourceId: "setneg",
    label: "setneg — Pemerintah Tetapkan Hari Libur Nasional",
    url: (year) =>
      `https://www.setneg.go.id/baca/index/pemerintah_tetapkan_hari_libur_nasional_dan_cuti_bersama_tahun_${year}`,
  },
];

/** Halaman hasil pencarian situs resmi (fallback terakhir, markup bisa berubah). */
export const OFFICIAL_SEARCHES = [
  {
    sourceId: "setkab",
    label: "pencarian setkab.go.id",
    url: (year) => `https://setkab.go.id/?s=${encodeURIComponent(`SKB tiga menteri hari libur nasional dan cuti bersama ${year}`)}`,
  },
  {
    sourceId: "kemenkopmk",
    label: "pencarian kemenkopmk.go.id",
    url: (year) => `https://www.kemenkopmk.go.id/search?keys=${encodeURIComponent(`hari libur nasional cuti bersama tahun ${year}`)}`,
  },
];

/**
 * Ambil item dari dokumen RSS/Atom (title, link, pubDate).
 * @returns {Array<{title:string, link:string, pubDate:string|null}>}
 */
export function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const blocks = String(xml).match(itemRe) ?? [];
  for (const block of blocks) {
    const title = decodeXml(firstTag(block, "title"));
    const link = decodeXml(firstTag(block, "link")) || decodeXml(attrOf(block, "link", "href"));
    if (!link) continue;
    items.push({ title: title ?? "", link: link.trim(), pubDate: decodeXml(firstTag(block, "pubDate")) });
  }
  return items;
}

function firstTag(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : null;
}

function attrOf(block, tag, attribute) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, "i").exec(block);
  return m ? m[1] : null;
}

function decodeXml(value) {
  if (!value) return value;
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Filter item feed yang relevan dengan SKB hari libur/cuti bersama.
 * @returns {Array<{title, link, pubDate, year:number|null, isAmendment:boolean}>}
 */
export function selectSkbFeedItems(items) {
  const out = [];
  for (const item of items) {
    const haystack = `${item.title} ${item.link}`.toLowerCase();
    if (!/(hari[\s-]?libur[\s-]?nasional|cuti[\s-]?bersama|skb)/.test(haystack)) continue;
    const yearMatch =
      item.title.match(/tahun\s+(20\d{2})/i) ??
      item.link.match(/tahun[-_]?(20\d{2})/i) ??
      item.link.match(/[-_](20\d{2})\b/) ??
      item.title.match(/\b(20\d{2})\b/);
    out.push({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate ?? null,
      year: yearMatch ? Number(yearMatch[1]) : null,
      isAmendment: /perubahan|revisi|diubah|hapus|penambahan/i.test(item.title),
    });
  }
  return out;
}


/** Ambil semua URL artikel kandidat dari HTML halaman hasil pencarian. */
export function extractCandidateArticleUrls(html, baseUrl) {
  const urls = new Set();
  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const label = match[2].replace(/<[^>]+>/g, " ").toLowerCase();
    const haystack = `${href.toLowerCase()} ${label}`;
    if (!/libur|cuti|skb/.test(haystack)) continue;
    if (!/setkab\.go\.id|setneg\.go\.id|kemenkopmk\.go\.id/.test(new URL(href, baseUrl).href)) continue;
    try {
      urls.add(new URL(href, baseUrl).href.split("#")[0]);
    } catch {
      /* abaikan URL tidak valid */
    }
  }
  return [...urls];
}
