/**
 * Updater: menjaga data tetap sinkron dengan SKB 3 Menteri terbaru.
 *
 * Sumber dan prioritas:
 *   1. official  -> artikel resmi setkab/setneg/kemenkopmk (hasil parse otomatis)
 *   2. community -> feed komunitas (deteksi dini, pelengkap, penanda "belum pasti")
 *
 * Deteksi artikel resmi:
 *   a. RSS resmi (setkab.go.id/feed/, kemenkopmk.go.id/rss.xml)
 *   b. pola URL artikel SKB yang sudah terverifikasi (untuk tahun baru)
 *   c. halaman hasil pencarian situs resmi (fallback)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  COMMUNITY_SOURCES,
  FETCH_DELAY_MS,
  OFFICIAL_FEEDS,
  OFFICIAL_SEARCHES,
  OFFICIAL_SLUG_TEMPLATES,
  extractCandidateArticleUrls,
  fetchJson,
  fetchText,
  normalizeGuangreiCalendar,
  normalizeNagerDate,
  parseRssItems,
  selectSkbFeedItems,
  sleep,
} from "./sources.js";
import { parseOfficialHolidayPage } from "./parse-official.js";
import { sortByDate, todayISO, uniqueBy } from "./utils.js";

const CACHE_FILES = {
  community: "community.json",
  official: "official.json",
  state: "state.json",
};

export const DEFAULT_REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS || 6 * 60 * 60 * 1000);
const MIN_ACCEPTED_ENTRIES = 4;

function hashId(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

export class Updater {
  constructor({ cacheDir, curatedYears = [], log = console }) {
    this.cacheDir = cacheDir;
    this.curatedYears = [...curatedYears].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    this.log = log;
  }

  /* ---------------------------- cache helpers ---------------------------- */

  async ensureCacheDir() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async readCache(name, fallback) {
    try {
      const raw = await fs.readFile(path.join(this.cacheDir, CACHE_FILES[name]), "utf8");
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async writeCache(name, data) {
    await this.ensureCacheDir();
    const target = path.join(this.cacheDir, CACHE_FILES[name]);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
    return target;
  }

  async readCommunity() {
    return this.readCache("community", { fetchedAt: null, entries: [], sources: [] });
  }

  async readOfficial() {
    return this.readCache("official", { fetchedAt: null, articles: [], rejected: [], errors: [] });
  }

  async readState() {
    return this.readCache("state", {
      community: { refreshedAt: null, ok: false },
      official: { refreshedAt: null, ok: false },
      errors: [],
    });
  }

  async isStale(kind, { ttlMs = DEFAULT_REFRESH_TTL_MS, now = Date.now() } = {}) {
    const state = await this.readState();
    const refreshedAt = state?.[kind]?.refreshedAt;
    if (!refreshedAt) return true;
    const age = now - Date.parse(refreshedAt);
    return !Number.isFinite(age) || age > ttlMs;
  }

  defaultYears() {
    const currentYear = Number(todayISO().slice(0, 4));
    // Jendela 3 tahun ke depan: SKB biasanya terbit sekitar Sep-Nov tahun
    // sebelumnya, jadi tahun berikutnya perlu dipantau lebih awal.
    const years = new Set([
      currentYear,
      currentYear + 1,
      currentYear + 2,
      currentYear + 3,
      ...this.curatedYears,
    ]);
    return [...years].filter((y) => y >= 2020 && y <= currentYear + 3).sort((a, b) => a - b);
  }

  /* ---------------------------- sumber komunitas ---------------------------- */

  async refreshCommunity({ years = null, only = null } = {}) {
    const targetYears = years ?? this.defaultYears();
    const entries = [];
    const sources = [];
    const errors = [];

    for (const source of COMMUNITY_SOURCES) {
      if (only && !only.includes(source.id)) continue;
      const urls =
        source.id === "nager-date-id"
          ? targetYears.map((year) => ({ year, url: source.url(year) }))
          : [{ year: null, url: source.url() }];
      for (const target of urls) {
        try {
          const { json } = await fetchJson(target.url);
          const normalized =
            source.id === "guangrei-calendar"
              ? normalizeGuangreiCalendar(json)
              : normalizeNagerDate(json);
          entries.push(...normalized);
          sources.push({
            id: source.id,
            label: source.label,
            url: target.url,
            ok: true,
            count: normalized.length,
            upstreamUpdated: normalized.find((e) => e.metadata?.upstreamUpdated)?.metadata
              ?.upstreamUpdated ?? null,
          });
        } catch (error) {
          errors.push({ source: source.id, url: target.url, error: error.message });
          sources.push({ id: source.id, label: source.label, url: target.url, ok: false, error: error.message });
        }
      }
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      entries: uniqueBy(sortByDate(entries), (entry) => `${entry.date}|${entry.type}|${entry.name}`),
      sources,
      errors,
    };
    await this.writeCache("community", payload);
    await this.mergeState({
      community: { refreshedAt: payload.fetchedAt, ok: errors.length < sources.length },
      errors: errors.map((error) => ({ at: payload.fetchedAt, ...error })),
    });
    return payload;
  }
  /* ---------------------------- sumber resmi (SKB) ---------------------------- */

  /** Kumpulkan kandidat URL artikel resmi: RSS, pola slug tahun baru, dan pencarian. */
  async collectOfficialDetections({ years, cachedArticles, includeSearch = true }) {
    const detections = [];
    const errors = [];

    for (const feed of OFFICIAL_FEEDS) {
      try {
        await sleep(FETCH_DELAY_MS);
        const { text } = await fetchText(feed.url);
        const items = selectSkbFeedItems(parseRssItems(text)).slice(0, 40);
        for (const item of items) {
          detections.push({
            url: item.link,
            sourceId: feed.sourceId,
            via: feed.id,
            title: item.title,
            pubDate: item.pubDate,
            year: item.year,
            isAmendment: item.isAmendment,
          });
        }
      } catch (error) {
        errors.push({ source: feed.sourceId, url: feed.url, error: error.message });
      }
    }

    for (const year of years) {
      for (const template of OFFICIAL_SLUG_TEMPLATES) {
        detections.push({ url: template.url(year), sourceId: template.sourceId, via: "slug", year });
      }
    }

    const yearsWithData = new Set(
      cachedArticles.filter((a) => a.status === "accepted").map((a) => Number(a.year)),
    );
    if (includeSearch) {
      for (const year of years) {
        if (yearsWithData.has(year)) continue;
        for (const search of OFFICIAL_SEARCHES) {
          try {
            await sleep(FETCH_DELAY_MS);
            const { text, url } = await fetchText(search.url(year));
            for (const candidate of extractCandidateArticleUrls(text, url).slice(0, 5)) {
              detections.push({ url: candidate, sourceId: search.sourceId, via: "search", year });
            }
          } catch (error) {
            errors.push({ source: search.sourceId, url: search.url(year), error: error.message });
          }
        }
      }
    }

    return { detections: uniqueBy(detections, (d) => d.url), errors };
  }

  /** Ambil + parse satu artikel resmi, lalu tentukan diterima/ditolak. */
  async fetchAndParseArticle(detection) {
    const { text, url } = await fetchText(detection.url);
    const parsed = parseOfficialHolidayPage(text, { year: detection.year ?? null, url });
    const entries = parsed.entries.filter((entry) => entry.name);
    const counts = entries.reduce((acc, entry) => {
      acc[entry.type] = (acc[entry.type] ?? 0) + 1;
      return acc;
    }, {});
    const warnings = [...parsed.warnings];
    let status = "accepted";

    if (entries.length < MIN_ACCEPTED_ENTRIES) status = "rejected";
    const declared = parsed.metadata.declaredCounts;
    if (declared) {
      for (const [type, declaredCount] of Object.entries(declared)) {
        if ((counts[type] ?? 0) !== declaredCount) status = "rejected";
      }
    }
    if (entries.some((entry) => entry.warnings.some((w) => w.startsWith("hari_tidak_cocok")))) {
      status = "rejected";
    }
    if (!parsed.year) status = "rejected";

    return {
      id: hashId(url),
      url,
      sourceId: detection.sourceId,
      via: detection.via,
      title: detection.title ?? parsed.metadata.title ?? null,
      year: Number(detection.year ?? parsed.year),
      pubDate: detection.pubDate ?? null,
      fetchedAt: new Date().toISOString(),
      status,
      isAmendment: Boolean(parsed.metadata.isAmendment || detection.isAmendment),
      counts,
      warnings: uniqueBy(warnings, (w) => w),
      metadata: parsed.metadata,
      entries: entries.map(({ date, name, type }) => ({ date, name, type })),
    };
  }

  /** Orkestrasi pemutakhiran dari artikel resmi: deteksi -> parse -> simpan. */
  async refreshOfficial({ years = null, force = false, maxArticles = 12 } = {}) {
    const allYears = years ?? this.defaultYears();
    const currentYear = Number(todayISO().slice(0, 4));
    // Tahun tanpa data terkurasi + jendela verifikasi (tahun lalu s/d dua tahun ke depan).
    const verifyWindow = [currentYear - 1, currentYear, currentYear + 1, currentYear + 2];
    const slugYears = [...new Set([...allYears.filter((year) => !this.curatedYears.includes(Number(year))), ...verifyWindow])]
      .filter((year) => year >= 2020 && year <= currentYear + 3)
      .sort((a, b) => a - b);
    const cache = await this.readOfficial();
    const cachedByUrl = new Map((cache.articles ?? []).map((article) => [article.url, article]));

    const collected = await this.collectOfficialDetections({
      years: slugYears,
      cachedArticles: cache.articles ?? [],
    });
    const errors = [...collected.errors];

    const pending = collected.detections
      .filter((detection) => {
        const cached = cachedByUrl.get(detection.url);
        if (!cached) return true;
        if (force) return true;
        return Date.now() - Date.parse(cached.fetchedAt ?? 0) > DEFAULT_REFRESH_TTL_MS;
      })
      .slice(0, maxArticles);

    const articles = [...(cache.articles ?? [])];
    const rejected = [...(cache.rejected ?? [])];
    const results = [];

    for (const detection of pending) {
      try {
        await sleep(FETCH_DELAY_MS);
        const article = await this.fetchAndParseArticle(detection);
        const index = articles.findIndex((item) => item.url === article.url);
        if (article.status === "accepted") {
          if (index >= 0) articles[index] = article;
          else articles.push(article);
        } else {
          if (index >= 0) articles.splice(index, 1);
          rejected.unshift(article);
        }
        results.push({
          url: article.url,
          sourceId: article.sourceId,
          via: article.via,
          year: article.year,
          status: article.status,
          counts: article.counts,
          warnings: article.warnings,
        });
      } catch (error) {
        // 404 pada pola URL kandidat adalah hal normal (slug berubah tiap tahun).
        if (!(detection.via === "slug" && error.status === 404)) {
          errors.push({ source: detection.sourceId, url: detection.url, error: error.message });
        }
      }
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      articles,
      rejected: rejected.slice(0, 20),
      errors: errors.slice(-20),
    };
    await this.writeCache("official", payload);
    await this.mergeState({
      official: { refreshedAt: payload.fetchedAt, ok: results.some((r) => r.status === "accepted") },
      errors: errors.map((error) => ({ at: payload.fetchedAt, ...error })),
    });
    return { ...payload, results };
  }

  async mergeState(patch = {}) {
    const state = await this.readState();
    const next = {
      ...state,
      ...patch,
      community: { ...state.community, ...(patch.community ?? {}) },
      official: { ...state.official, ...(patch.official ?? {}) },
    };
    if (patch.errors) next.errors = [...patch.errors, ...(state.errors ?? [])].slice(0, 30);
    await this.writeCache("state", next);
    return next;
  }

  /** Jalankan pemutakhiran lengkap (dipakai scheduler, CLI, dan endpoint admin). */
  async run({
    years = null,
    sources = ["official", "community"],
    force = false,
    ttlMs = DEFAULT_REFRESH_TTL_MS,
  } = {}) {
    const summary = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      skipped: [],
      results: {},
      errors: [],
    };

    if (sources.includes("community")) {
      if (force || (await this.isStale("community", { ttlMs }))) {
        const community = await this.refreshCommunity({ years });
        summary.results.community = {
          fetchedAt: community.fetchedAt,
          entryCount: community.entries.length,
          sources: community.sources,
          errors: community.errors,
        };
        summary.errors.push(...community.errors);
      } else {
        summary.skipped.push("community");
      }
    }

    if (sources.includes("official")) {
      if (force || (await this.isStale("official", { ttlMs }))) {
        const official = await this.refreshOfficial({ years, force });
        summary.results.official = {
          fetchedAt: official.fetchedAt,
          articleCount: official.articles.length,
          results: official.results,
          errors: official.errors,
        };
        summary.errors.push(...official.errors);
      } else {
        summary.skipped.push("official");
      }
    }

    summary.finishedAt = new Date().toISOString();
    await this.mergeState({ lastRun: summary });
    return summary;
  }
}

