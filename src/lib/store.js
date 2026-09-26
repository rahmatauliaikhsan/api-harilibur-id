/**
 * HolidayStore: menyatukan 3 lapis data menjadi satu view yang konsisten.
 *
 * Prioritas per tahun:
 *   1. hasil parse artikel resmi terbaru (official-parsed) -> menang jika lebih baru
 *      dari SKB di data/skb/<tahun>.json (mis. saat terbit SKB perubahan)
 *   2. data SKB terkurasi (curated-skb)                    -> baseline terverifikasi
 *   3. feed komunitas (community)                          -> pengisi celah + deteksi dini
 *
 * Entri komunitas yang ditandai "(belum pasti)" tetap berflag tentative dan tidak
 * pernah menimpa data resmi.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { Updater } from "./updater.js";
import { addDaysISO, dayNameID, isWeekendISO, sortByDate, todayISO, uniqueBy, yearOf } from "./utils.js";

export const HOLIDAY_TYPES = ["national_holiday", "joint_leave", "observance"];
export const SOURCE_KINDS = ["curated-skb", "official-parsed", "community"];

const TYPE_LABEL = {
  national_holiday: "Hari Libur Nasional",
  joint_leave: "Cuti Bersama",
  observance: "Perayaan",
};

/**
 * Kata kunci perayaan hari besar: dipakai untuk menilai apakah dua nama hari libur
 * merujuk ke perayaan yang sama meski penulisannya berbeda antar sumber.
 */
const EVENT_KEYWORDS = [
  ["imlek", /imlek|chinese new year/i],
  ["nyepi", /nyepi/i],
  ["idul fitri", /idul\s*fitri/i],
  ["idul adha", /idul\s*adha/i],
  ["isra mikraj", /isra\s*mikraj|mikraj/i],
  ["wafat isa almasih", /wafat|good friday/i],
  ["paskah", /paskah|kebangkitan|easter/i],
  ["hari buruh", /buruh|labour|labour day|labor day/i],
  ["kenaikan isa almasih", /kenaikan|ascension/i],
  ["waisak", /waisak|vesak/i],
  ["pancasila", /pancasila/i],
  ["tahun baru hijriah", /muharam|muharram|tahun baru islam/i],
  ["maulid", /maulid|maulud/i],
  ["kemerdekaan", /kemerdekaan|proklamasi|independence/i],
  ["natal", /natal|christmas|kelahiran yesus/i],
  ["tahun baru masehi", /tahun baru(?!\s+imlek)/i],
];

function eventKeyword(name) {
  for (const [key, pattern] of EVENT_KEYWORDS) {
    if (pattern.test(name)) return key;
  }
  return null;
}

/** True bila dua nama hari libur merujuk perayaan yang sama. */
export function similarHolidayNames(a, b) {
  if (!a || !b) return false;
  const keyA = eventKeyword(a);
  const keyB = eventKeyword(b);
  if (keyA && keyA === keyB) return true;

  const compactA = a.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const compactB = b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compactA || !compactB) return false;
  const [shorter, longer] = compactA.length <= compactB.length ? [compactA, compactB] : [compactB, compactA];
  if (shorter.length >= 8 && longer.includes(shorter)) return true;

  // Kemiripan token (mis. "Hari Raya Waisak 2570 BE" vs "Waisak 2570").
  const tokensA = new Set(compactA.match(/[a-z]{3,}/g) ?? []);
  const tokensB = new Set(compactB.match(/[a-z]{3,}/g) ?? []);
  if (!tokensA.size || !tokensB.size) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / Math.min(tokensA.size, tokensB.size) >= 0.5;
}

export class HolidayStore {
  constructor({ dataDir, cacheDir, log = console, autoRefresh = true, refreshTtlMs } = {}) {
    this.dataDir = dataDir;
    this.skbDir = path.join(dataDir, "skb");
    this.cacheDir = cacheDir;
    this.log = log;
    this.autoRefresh = autoRefresh;
    this.refreshTtlMs = refreshTtlMs;
    this.updater = new Updater({ cacheDir, curatedYears: [], log });
    this.curated = new Map();
    this.community = { fetchedAt: null, entries: [], sources: [], errors: [] };
    this.official = { fetchedAt: null, articles: [], rejected: [], errors: [] };
    this.version = 0;
    this.loadedAt = null;
  }

  /* -------------------------------- pemuatan -------------------------------- */

  async loadCurated() {
    const curated = new Map();
    let files = [];
    try {
      files = await fs.readdir(this.skbDir);
    } catch (error) {
      this.log.warn?.(`[store] folder data/skb tidak ditemukan: ${error.message}`);
      return curated;
    }
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      const fullPath = path.join(this.skbDir, file);
      try {
        const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
        const year = Number(parsed.year ?? file.replace(/\.json$/, ""));
        if (!Number.isFinite(year)) throw new Error("field year tidak valid");
        curated.set(year, {
          year,
          status: parsed.status ?? "official",
          skb: parsed.skb ?? null,
          entries: (parsed.entries ?? []).map((entry) => ({
            date: entry.date,
            name: entry.name,
            type: entry.type,
            tentative: Boolean(entry.tentative),
            amendedBy: entry.amendedBy ?? null,
            sourceKind: "curated-skb",
            sourceUrl: parsed.skb?.sourceUrl ?? null,
          })),
        });
      } catch (error) {
        this.log.warn?.(`[store] gagal membaca ${file}: ${error.message}`);
      }
    }
    return curated;
  }

  async init() {
    this.curated = await this.loadCurated();
    this.updater.curatedYears = [...this.curated.keys()];
    await this.reloadCaches();
    return this;
  }

  async reloadCaches() {
    this.community = await this.updater.readCommunity();
    this.official = await this.updater.readOfficial();
    this.loadedAt = new Date().toISOString();
    this.version += 1;
    return this;
  }

  async reload() {
    this.curated = await this.loadCurated();
    this.updater.curatedYears = [...this.curated.keys()];
    await this.reloadCaches();
    return this;
  }

  curatedYears() {
    return [...this.curated.keys()].sort((a, b) => a - b);
  }

  /* --------------------------- penggabungan data --------------------------- */

  acceptedOfficialArticles() {
    return (this.official.articles ?? [])
      .filter((article) => article.status === "accepted" && Number.isFinite(Number(article.year)))
      .map((article) => ({
        ...article,
        year: Number(article.year),
        effectiveAt:
          article.metadata?.signedAt ??
          (article.pubDate ? new Date(article.pubDate).toISOString().slice(0, 10) : null) ??
          (article.fetchedAt ? article.fetchedAt.slice(0, 10) : null),
      }));
  }

  /** Pilih basis data satu tahun: official-parsed, curated-skb, atau community. */
  resolveYearSource(year) {
    const curated = this.curated.get(year) ?? null;
    const officialForYear = this.acceptedOfficialArticles()
      .filter((article) => article.year === year)
      .sort((a, b) => String(b.effectiveAt ?? "").localeCompare(String(a.effectiveAt ?? "")));

    const newestOfficial = officialForYear[0] ?? null;
    const curatedSignedAt = curated?.skb?.signedAt ?? null;
    const officialIsNewer =
      Boolean(newestOfficial) &&
      (!curated || !curatedSignedAt || String(newestOfficial.effectiveAt ?? "") > String(curatedSignedAt));

    if (officialIsNewer) {
      const entries = [];
      const usedArticles = [];
      for (const article of officialForYear) {
        for (const entry of article.entries ?? []) {
          if (entries.some((item) => item.date === entry.date && item.type === entry.type)) continue;
          entries.push({
            date: entry.date,
            name: entry.name,
            type: entry.type,
            tentative: false,
            sourceKind: "official-parsed",
            sourceUrl: article.url,
            sourceTitle: article.title ?? article.metadata?.title ?? null,
            amendedBy: article.isAmendment ? article.title ?? "SKB Perubahan" : null,
          });
        }
        usedArticles.push(article);
      }
      return {
        year,
        status: "official",
        sourceKind: "official-parsed",
        skb: {
          title: newestOfficial.metadata?.title ?? newestOfficial.title ?? null,
          numbers: newestOfficial.metadata?.numbers ?? [],
          signedAt: newestOfficial.metadata?.signedAt ?? null,
          sourceUrl: newestOfficial.url,
          amendments: usedArticles
            .filter((article) => article.isAmendment)
            .map((article) => ({ title: article.title, sourceUrl: article.url })),
        },
        entries,
      };
    }

    if (curated) {
      return {
        year,
        status: curated.status,
        sourceKind: "curated-skb",
        skb: curated.skb,
        entries: curated.entries,
        verification: this.buildVerification(curated, officialForYear),
      };
    }

    const communityEntries = (this.community.entries ?? []).filter((entry) => yearOf(entry.date) === year);
    return {
      year,
      status: "community",
      sourceKind: communityEntries.length ? "community" : "none",
      skb: null,
      entries: communityEntries.map((entry) => ({
        date: entry.date,
        name: entry.name,
        type: entry.type,
        tentative: Boolean(entry.tentative),
        sourceKind: "community",
        sourceUrl: entry.sourceId ?? null,
      })),
    };
  }

  /**
   * Bandingkan data terkurasi dengan hasil parse artikel resmi.
   * Berguna untuk mendeteksi SKB perubahan yang belum dipromosikan ke data/skb.
   */
  buildVerification(curated, articles) {
    if (!articles?.length) return null;
    const relevant = articles.filter((article) => (article.entries ?? []).length);
    if (!relevant.length) return null;
    const curatedDates = new Set(
      curated.entries.filter((entry) => entry.type !== "observance").map((entry) => entry.date),
    );
    const officialDates = new Set(
      relevant.flatMap((article) =>
        (article.entries ?? []).filter((entry) => entry.type !== "observance").map((entry) => entry.date),
      ),
    );
    const missingInOfficial = [...curatedDates].filter((date) => !officialDates.has(date)).sort();
    const extraInOfficial = [...officialDates].filter((date) => !curatedDates.has(date)).sort();
    const newest = relevant[0];
    return {
      checkedAt: newest.fetchedAt ?? null,
      signedAtCurated: curated.skb?.signedAt ?? null,
      signedAtOfficial: newest.metadata?.signedAt ?? null,
      matchesOfficial: missingInOfficial.length === 0 && extraInOfficial.length === 0,
      missingInOfficial,
      extraInOfficial,
      articles: relevant.map((article) => ({
        url: article.url,
        sourceId: article.sourceId,
        via: article.via,
        signedAt: article.metadata?.signedAt ?? null,
        isAmendment: Boolean(article.isAmendment),
        counts: article.counts,
      })),
      note: "Perbandingan otomatis terhadap lampiran SKB pada artikel resmi yang diparse.",
    };
  }

  /** Lengkapi basis data dengan entri komunitas yang belum ada + catat konflik. */
  mergeYear(year, { includeObservance = false } = {}) {
    const base = this.resolveYearSource(year);
    const communityEntries = (this.community.entries ?? []).filter(
      (entry) => yearOf(entry.date) === year && (includeObservance || entry.type !== "observance"),
    );

    const entries = [...base.entries];
    const conflicts = [];
    const byKey = new Map(entries.map((entry) => [`${entry.date}|${entry.type}`, entry]));
    const datesInBase = new Set(base.entries.map((entry) => entry.date));

    for (const communityEntry of communityEntries) {
      const key = `${communityEntry.date}|${communityEntry.type}`;
      if (byKey.has(key)) continue;
      if (base.sourceKind === "community") continue;
      // Tanggal yang sudah ada dari sumber resmi tidak boleh diduplikasi beda tipe
      // (mis. feed komunitas menandai 28 Mei sebagai libur nasional, SKB menyebut cuti bersama).
      if (datesInBase.has(communityEntry.date) && base.sourceKind !== "community") continue;
      const entry = {
        date: communityEntry.date,
        name: communityEntry.name,
        type: communityEntry.type,
        tentative: Boolean(communityEntry.tentative),
        sourceKind: "community",
        sourceUrl: communityEntry.sourceId ?? null,
      };
      entries.push(entry);
      byKey.set(key, entry);
    }

    for (const communityEntry of communityEntries) {
      const official = entries.find(
        (entry) => entry.date === communityEntry.date && entry.sourceKind !== "community" && entry.name,
      );
      if (!official || !communityEntry.name) continue;
      if (!similarHolidayNames(official.name, communityEntry.name)) {
        conflicts.push({
          date: communityEntry.date,
          kept: { sourceKind: official.sourceKind, name: official.name },
          other: { sourceKind: "community", name: communityEntry.name },
        });
      }
    }

    const decorated = uniqueBy(sortByDate(entries), (entry) => `${entry.date}|${entry.type}`).map((entry) =>
      this.decorate(entry),
    );
    return {
      year,
      status: base.status,
      sourceKind: base.sourceKind,
      skb: base.skb,
      verification: base.verification ?? null,
      entries: decorated,
      conflicts: uniqueBy(conflicts, (c) => `${c.date}|${c.other.name}`),
      counts: this.countByType(decorated),
    };
  }

  countByType(entries) {
    const counts = { national_holiday: 0, joint_leave: 0, observance: 0 };
    for (const entry of entries) {
      if (counts[entry.type] === undefined) counts[entry.type] = 0;
      counts[entry.type] += 1;
    }
    counts.tanggal_merah = counts.national_holiday + counts.joint_leave;
    return counts;
  }

  decorate(entry) {
    return {
      date: entry.date,
      day: dayNameID(entry.date),
      name: entry.name,
      type: entry.type,
      type_label: TYPE_LABEL[entry.type] ?? entry.type,
      is_libur_nasional: entry.type === "national_holiday",
      is_cuti_bersama: entry.type === "joint_leave",
      is_tanggal_merah: entry.type === "national_holiday" || entry.type === "joint_leave",
      is_weekend: isWeekendISO(entry.date),
      tentative: Boolean(entry.tentative),
      amendedBy: entry.amendedBy ?? null,
      sourceKind: entry.sourceKind,
      sourceUrl: entry.sourceUrl ?? null,
    };
  }

  /* --------------------------------- query --------------------------------- */

  listYears() {
    const years = new Set([
      ...this.curated.keys(),
      ...this.acceptedOfficialArticles().map((article) => article.year),
      ...(this.community.entries ?? []).map((entry) => yearOf(entry.date)),
    ]);
    return [...years]
      .filter((year) => Number.isFinite(year))
      .sort((a, b) => a - b)
      .map((year) => {
        const merged = this.mergeYear(year);
        return {
          year,
          status: merged.status,
          sourceKind: merged.sourceKind,
          counts: merged.counts,
          skb: merged.skb,
        };
      });
  }

  yearData(year, { includeObservance = false, types = null, from = null, to = null } = {}) {
    const merged = this.mergeYear(year, { includeObservance });
    let entries = merged.entries;
    if (types?.length) entries = entries.filter((entry) => types.includes(entry.type));
    if (from) entries = entries.filter((entry) => entry.date >= from);
    if (to) entries = entries.filter((entry) => entry.date <= to);
    return { ...merged, entries, counts: this.countByType(entries) };
  }

  checkDate(isoDate, { withNextWorkday = true } = {}) {
    const year = yearOf(isoDate);
    if (!year) return null;
    const merged = this.mergeYear(year, { includeObservance: true });
    const entries = merged.entries.filter((entry) => entry.date === isoDate);
    const isTanggalMerah = entries.some((entry) => entry.is_tanggal_merah);
    const isWeekend = isWeekendISO(isoDate);
    const primary = entries.find((entry) => entry.is_tanggal_merah) ?? entries[0] ?? null;
    return {
      date: isoDate,
      day: dayNameID(isoDate),
      year,
      is_weekend: isWeekend,
      is_libur_nasional: entries.some((entry) => entry.is_libur_nasional),
      is_cuti_bersama: entries.some((entry) => entry.is_cuti_bersama),
      is_tanggal_merah: isTanggalMerah,
      is_workday: !isWeekend && !isTanggalMerah,
      name: primary ? primary.name : null,
      type: primary ? primary.type : null,
      tentative: Boolean(primary?.tentative),
      entries,
      sourceKind: merged.sourceKind,
      next_workday: withNextWorkday ? this.nextWorkday(isoDate) : null,
    };
  }

  nextWorkday(isoDate, maxLookahead = 30) {
    for (let offset = 1; offset <= maxLookahead; offset += 1) {
      const candidate = addDaysISO(isoDate, offset);
      if (!candidate) return null;
      const info = this.checkDate(candidate, { withNextWorkday: false });
      if (info?.is_workday) return candidate;
    }
    return null;
  }

  findUpcoming({
    from = todayISO(),
    days = null,
    limit = null,
    types = null,
    includeObservance = false,
    inclusive = false,
  } = {}) {
    const endISO = days ? addDaysISO(from, days) : addDaysISO(from, 400);
    const startYear = yearOf(from);
    const endYear = yearOf(endISO) ?? startYear;
    const collected = [];
    for (let year = startYear; year <= endYear; year += 1) {
      const merged = this.mergeYear(year, { includeObservance });
      for (const entry of merged.entries) {
        if (inclusive ? entry.date < from : entry.date <= from) continue;
        if (entry.date > endISO) continue;
        if (types?.length && !types.includes(entry.type)) continue;
        collected.push({ ...entry, days_until: this.daysUntil(from, entry.date) });
      }
    }
    const sorted = sortByDate(collected);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  daysUntil(fromISO, toISO) {
    const fromEpoch = Date.parse(`${fromISO}T00:00:00Z`);
    const toEpoch = Date.parse(`${toISO}T00:00:00Z`);
    if (Number.isNaN(fromEpoch) || Number.isNaN(toEpoch)) return null;
    return Math.round((toEpoch - fromEpoch) / 86400000);
  }

  conflictReport() {
    const report = {};
    for (const year of this.listYears().map((item) => item.year)) {
      const merged = this.mergeYear(year);
      if (merged.conflicts.length) report[year] = merged.conflicts;
    }
    return report;
  }
}
