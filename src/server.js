/**
 * api-harilibur-id — server HTTP tanpa dependensi eksternal.
 *
 * Endpoint tersedia di /api/*, dokumentasi lengkap di /api.
 */

import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { HOLIDAY_TYPES, HolidayStore } from "./lib/store.js";
import { COMMUNITY_SOURCES, OFFICIAL_FEEDS, OFFICIAL_PROVIDERS } from "./lib/sources.js";
import { DEFAULT_REFRESH_TTL_MS } from "./lib/updater.js";
import {
  REFERENCE_TIMEZONE,
  addDaysISO,
  escapeICS,
  normalizeDateString,
  nowISO,
  todayISO,
} from "./lib/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  dataDir: process.env.DATA_DIR || path.join(ROOT_DIR, "data"),
  cacheDir: process.env.CACHE_DIR || path.join(ROOT_DIR, "data", "cache"),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 21600),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  adminToken: process.env.ADMIN_TOKEN || "",
  autoRefresh: (process.env.AUTO_REFRESH ?? "true") !== "false",
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS || 12 * 60 * 60 * 1000),
  refreshTtlMs: Number(process.env.REFRESH_TTL_MS || DEFAULT_REFRESH_TTL_MS),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 0),
  timezone: REFERENCE_TIMEZONE,
};

const SERVER_VERSION = "1.0.0";

/* --------------------------------- helper --------------------------------- */

function parseQuery(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  return { url, query: url.searchParams };
}

function hashBody(body) {
  return `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
}

function send(req, res, status, body, { contentType = "application/json; charset=utf-8", ttl = null } = {}) {
  const headers = {
    "content-type": contentType,
    "access-control-allow-origin": config.corsOrigin,
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key",
    "x-server": `api-harilibur-id/${SERVER_VERSION}`,
  };
  if (ttl) {
    headers["cache-control"] = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 2}`;
    // ETag dihitung tanpa kolom volatil (generatedAt) supaya cache tetap valid antar permintaan.
    headers.etag = hashBody(body.replace(/"generatedAt":\s*"[^"]+",?/, ""));
    if (req.headers["if-none-match"] === headers.etag || req.headers["if-none-match"] === "*") {
      res.writeHead(304, {
        "content-type": headers["content-type"],
        "cache-control": headers["cache-control"],
        etag: headers.etag,
        "access-control-allow-origin": headers["access-control-allow-origin"],
        "x-server": headers["x-server"],
      });
      res.end();
      return;
    }
  } else {
    headers["cache-control"] = "no-store";
  }
  headers["content-length"] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendJson(req, res, status, payload, { ttl = config.cacheTtlSeconds } = {}) {
  send(req, res, status, `${JSON.stringify(payload, null, 2)}\n`, { ttl: status === 200 ? ttl : 0 });
}

function sendError(req, res, status, code, message, extra = {}) {
  sendJson(req, res, status, { ok: false, error: { code, message, ...extra } }, { ttl: 0 });
}

function envelope(data, extraMeta = {}) {
  return {
    ok: true,
    data,
    meta: {
      generatedAt: nowISO(),
      referenceTimezone: config.timezone,
      cacheTtlSeconds: config.cacheTtlSeconds,
      ...extraMeta,
    },
  };
}

function badRequest(message, code = "invalid_parameter") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function parseTypesParam(value) {
  if (!value) return null;
  const types = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) =>
      item === "libur_nasional" ? "national_holiday" : item === "cuti_bersama" ? "joint_leave" : item,
    );
  for (const type of types) {
    if (!HOLIDAY_TYPES.includes(type)) {
      throw badRequest(`type tidak dikenal: ${type}. Pilihan: ${HOLIDAY_TYPES.join(", ")}`);
    }
  }
  return types;
}

function parseDateParam(value, { field = "date", fallback = null } = {}) {
  if (!value) return fallback;
  const normalized = normalizeDateString(value);
  if (!normalized) throw badRequest(`format ${field} harus YYYY-MM-DD, diterima: ${value}`);
  return normalized;
}

function parseBooleanParam(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function parseIntParam(value, { fallback, min, max, field }) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} harus berupa angka`);
  if (min !== undefined && parsed < min) throw badRequest(`${field} minimal ${min}`);
  if (max !== undefined && parsed > max) throw badRequest(`${field} maksimal ${max}`);
  return parsed;
}

function storeMeta(store) {
  return {
    dataVersion: store.version,
    dataLoadedAt: store.loadedAt,
    curatedYears: store.curatedYears(),
    communityFetchedAt: store.community?.fetchedAt ?? null,
    officialFetchedAt: store.official?.fetchedAt ?? null,
  };
}

/* ------------------------------- dokumentasi ------------------------------- */

function apiDocs() {
  return {
    name: "api-harilibur-id",
    version: SERVER_VERSION,
    description:
      "API hari libur nasional dan cuti bersama Indonesia berdasarkan SKB 3 Menteri (Menag, Menaker, PANRB) yang dipantau otomatis dari sumber resmi.",
    referenceTimezone: config.timezone,
    endpoints: [
      { method: "GET", path: "/api/holidays?year=2026", description: "Daftar hari libur + cuti bersama satu tahun" },
      { method: "GET", path: "/api/holidays/2026", description: "Sama seperti di atas (path langsung)" },
      { method: "GET", path: "/api/holidays?year=2026&format=ics", description: "Ekspor kalender iCalendar" },
      { method: "GET", path: "/api/years", description: "Tahun-tahun tersedia beserta jumlahnya" },
      { method: "GET", path: "/api/today", description: "Status tanggal hari ini (Asia/Jakarta)" },
      { method: "GET", path: "/api/check?date=2026-08-17", description: "Cek satu tanggal" },
      { method: "GET", path: "/api/check/2026-08-17", description: "Sama seperti di atas (path langsung)" },
      { method: "GET", path: "/api/next?from=2026-09-26&limit=5", description: "Tanggal merah berikutnya" },
      { method: "GET", path: "/api/upcoming?days=45", description: "Tanggal merah dalam rentang hari ke depan" },
      { method: "GET", path: "/api/meta", description: "Sumber data, versi SKB, konflik, riwayat refresh" },
      { method: "GET", path: "/api/ical?year=2026", description: "Ekspor iCalendar satu tahun" },
      {
        method: "POST",
        path: "/api/refresh",
        description: "Paksa pemutakhiran data (butuh X-API-Key bila ADMIN_TOKEN diset)",
      },
      { method: "GET", path: "/health", description: "Health check" },
    ],
    queryParameters: {
      year: "tahun 4 digit (2024-2030)",
      type: `filter tipe: ${HOLIDAY_TYPES.join(" | ")} (bisa dipisah koma)`,
      include: "tambahkan 'observance' untuk menyertakan hari perayaan dari feed komunitas",
      from: "YYYY-MM-DD (batas bawah)",
      to: "YYYY-MM-DD (batas atas)",
      format: "json (default) | ics",
    },
    dataSources: [
      "data/skb/<tahun>.json — data SKB 3 Menteri terkurasi (baseline terverifikasi)",
      "Artikel resmi setkab.go.id / setneg.go.id / kemenkopmk.go.id (hasil parse otomatis)",
      "Feed komunitas (guangrei/APIHariLibur_V2, nager.date) sebagai pelengkap & deteksi dini",
    ],
    disclaimer:
      "Selalu rujuk lampiran SKB 3 Menteri terbaru. Cuti bersama bersifat fakultatif bagi pekerja swasta dan mengurangi hak cuti tahunan.",
  };
}

/* ---------------------------------- router ---------------------------------- */

const routes = [
  { method: "GET", pattern: /^\/$/, handler: (ctx) => sendJson(ctx.req, ctx.res, 200, apiDocs()) },
  { method: "GET", pattern: /^\/api$/, handler: (ctx) => sendJson(ctx.req, ctx.res, 200, apiDocs()) },
  { method: "GET", pattern: /^\/health$/, handler: (ctx) => ctx.handleHealth() },
  { method: "GET", pattern: /^\/api\/holidays$/, handler: (ctx) => ctx.handleHolidays() },
  { method: "GET", pattern: /^\/api\/holidays\/(\d{4})$/, handler: (ctx) => ctx.handleHolidays(ctx.params[0]) },
  { method: "GET", pattern: /^\/api\/years$/, handler: (ctx) => ctx.handleYears() },
  { method: "GET", pattern: /^\/api\/meta$/, handler: (ctx) => ctx.handleMeta() },
  { method: "GET", pattern: /^\/api\/today$/, handler: (ctx) => ctx.handleCheck(todayISO(config.timezone)) },
  { method: "GET", pattern: /^\/api\/check$/, handler: (ctx) => ctx.handleCheck() },
  {
    method: "GET",
    pattern: /^\/api\/check\/(\d{4}-\d{2}-\d{2})$/,
    handler: (ctx) => ctx.handleCheck(ctx.params[0]),
  },
  { method: "GET", pattern: /^\/api\/next$/, handler: (ctx) => ctx.handleNext() },
  { method: "GET", pattern: /^\/api\/upcoming$/, handler: (ctx) => ctx.handleUpcoming() },
  { method: "GET", pattern: /^\/api\/ical$/, handler: (ctx) => ctx.handleIcal() },
  { method: "POST", pattern: /^\/api\/refresh$/, handler: (ctx) => ctx.handleRefresh() },
];

/* ---------------------------------- handler ---------------------------------- */

function includeObservance(ctx) {
  const raw = ctx.query.get("include") ?? ctx.query.get("include_observance");
  if (raw && raw.toLowerCase().includes("observance")) return true;
  return parseBooleanParam(ctx.query.get("include_observance"), false);
}

async function handleHealth(ctx) {
  const years = ctx.store.listYears();
  sendJson(
    ctx.req,
    ctx.res,
    200,
    {
      ok: true,
      status: "up",
      service: "api-harilibur-id",
      version: SERVER_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      referenceTimezone: config.timezone,
      dataVersion: ctx.store.version,
      curatedYears: ctx.store.curatedYears(),
      availableYears: years.map((item) => item.year),
      lastRefresh: { community: ctx.store.community?.fetchedAt ?? null, official: ctx.store.official?.fetchedAt ?? null },
    },
    { ttl: 0 },
  );
}

async function handleHolidays(ctx, yearFromPath) {
  const currentYear = Number(todayISO(config.timezone).slice(0, 4));
  const yearRaw = yearFromPath ?? ctx.query.get("year") ?? String(currentYear);
  const year = parseIntParam(yearRaw, { field: "year", min: 2000, max: 2100 });
  const types = parseTypesParam(ctx.query.get("type"));
  const from = parseDateParam(ctx.query.get("from"), { field: "from" });
  const to = parseDateParam(ctx.query.get("to"), { field: "to" });
  const data = ctx.store.yearData(year, { includeObservance: includeObservance(ctx), types, from, to });
  const format = String(ctx.query.get("format") ?? "json").toLowerCase();

  if (format === "ics" || format === "ical") {
    const body = buildIcal(data.entries, { year });
    send(ctx.req, ctx.res, 200, body, { contentType: "text/calendar; charset=utf-8", ttl: config.cacheTtlSeconds });
    return;
  }
  if (format !== "json") throw badRequest(`format tidak dikenal: ${format}. Pilihan: json, ics`);

  if (!data.entries.length && data.sourceKind === "none") {
    return sendError(
      ctx.req,
      ctx.res,
      404,
      "data_not_found",
      `Data SKB 3 Menteri untuk tahun ${year} belum tersedia. Tahun tersedia: ${ctx.store
        .listYears()
        .map((item) => item.year)
        .join(", ")}`,
    );
  }

  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope(
      {
        year,
        status: data.status,
        sourceKind: data.sourceKind,
        skb: data.skb,
        verification: data.verification,
        counts: data.counts,
        holidays: data.entries,
        conflicts: data.conflicts,
      },
      storeMeta(ctx.store),
    ),
  );
}

async function handleYears(ctx) {
  const years = ctx.store.listYears().filter((item) => item.sourceKind !== "none");
  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope(
      {
        currentYear: Number(todayISO(config.timezone).slice(0, 4)),
        count: years.length,
        years,
      },
      storeMeta(ctx.store),
    ),
  );
}

async function handleMeta(ctx) {
  const state = await ctx.store.updater.readState();
  const years = ctx.store.listYears().filter((item) => item.sourceKind !== "none");
  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope(
      {
        years: years.map(({ year, status, sourceKind, counts, skb }) => ({
          year,
          status,
          sourceKind,
          counts,
          skbNumbers: skb?.numbers ?? [],
          skbSignedAt: skb?.signedAt ?? null,
          skbSourceUrl: skb?.sourceUrl ?? null,
          amendments: skb?.amendments ?? [],
        })),
        sources: {
          officialProviders: OFFICIAL_PROVIDERS,
          officialFeeds: OFFICIAL_FEEDS.map((feed) => ({ id: feed.id, label: feed.label, url: feed.url })),
          community: COMMUNITY_SOURCES.map((source) => ({
            id: source.id,
            label: source.label,
            homepage: source.homepage,
          })),
        },
        officialArticles: (ctx.store.official.articles ?? []).map((article) => ({
          url: article.url,
          year: article.year,
          status: article.status,
          via: article.via,
          fetchedAt: article.fetchedAt,
          isAmendment: Boolean(article.isAmendment),
          counts: article.counts,
          warnings: article.warnings ?? [],
        })),
        rejectedArticles: (ctx.store.official.rejected ?? []).map((article) => ({
          url: article.url,
          year: article.year,
          status: article.status,
          warnings: article.warnings ?? [],
        })),
        communitySources: ctx.store.community?.sources ?? [],
        conflicts: ctx.store.conflictReport(),
        refreshState: {
          community: state.community ?? null,
          official: state.official ?? null,
          lastRun: state.lastRun ?? null,
          errors: (state.errors ?? []).slice(0, 10),
        },
        schedule: {
          autoRefresh: config.autoRefresh,
          intervalMs: config.refreshIntervalMs,
          ttlMs: config.refreshTtlMs,
        },
        disclaimer:
          "Data komunitas hanya pelengkap. Untuk keputusan resmi, rujuk lampiran SKB 3 Menteri terbaru.",
      },
      storeMeta(ctx.store),
    ),
  );
}

async function handleCheck(ctx, dateFromPath) {
  const raw = dateFromPath ?? ctx.query.get("date") ?? todayISO(config.timezone);
  const date = parseDateParam(raw, { field: "date" });
  if (!date) throw badRequest("parameter date wajib diisi, contoh: /api/check?date=2026-08-17");
  const info = ctx.store.checkDate(date);
  if (!info) throw badRequest(`tanggal tidak valid: ${raw}`);
  sendJson(ctx.req, ctx.res, 200, envelope(info, storeMeta(ctx.store)));
}

async function handleNext(ctx) {
  const from = parseDateParam(ctx.query.get("from"), { field: "from", fallback: todayISO(config.timezone) });
  const limit = parseIntParam(ctx.query.get("limit"), { field: "limit", fallback: 1, min: 1, max: 100 });
  const days = parseIntParam(ctx.query.get("days"), { field: "days", fallback: null, min: 1, max: 800 });
  const types = parseTypesParam(ctx.query.get("type"));
  const holidays = ctx.store.findUpcoming({
    from,
    limit,
    days,
    types,
    includeObservance: includeObservance(ctx),
  });
  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope(
      { from, count: holidays.length, holidays },
      storeMeta(ctx.store),
    ),
  );
}

async function handleUpcoming(ctx) {
  const from = parseDateParam(ctx.query.get("from"), { field: "from", fallback: todayISO(config.timezone) });
  const days = parseIntParam(ctx.query.get("days"), { field: "days", fallback: 30, min: 1, max: 800 });
  const limit = parseIntParam(ctx.query.get("limit"), { field: "limit", fallback: null, min: 1, max: 200 });
  const types = parseTypesParam(ctx.query.get("type"));
  const holidays = ctx.store.findUpcoming({
    from,
    days,
    limit,
    types,
    includeObservance: includeObservance(ctx),
    inclusive: parseBooleanParam(ctx.query.get("inclusive"), true),
  });
  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope({ from, days, count: holidays.length, holidays }, storeMeta(ctx.store)),
  );
}

async function handleIcal(ctx) {
  const currentYear = Number(todayISO(config.timezone).slice(0, 4));
  const year = parseIntParam(ctx.query.get("year") ?? String(currentYear), { field: "year", min: 2000, max: 2100 });
  const types = parseTypesParam(ctx.query.get("type"));
  const data = ctx.store.yearData(year, { includeObservance: includeObservance(ctx), types });
  if (!data.entries.length) {
    return sendError(ctx.req, ctx.res, 404, "data_not_found", `Belum ada data untuk tahun ${year}`);
  }
  const body = buildIcal(data.entries, { year });
  send(ctx.req, ctx.res, 200, body, { contentType: "text/calendar; charset=utf-8", ttl: config.cacheTtlSeconds });
}

async function handleRefresh(ctx) {
  if (config.adminToken) {
    const token = ctx.req.headers["x-api-key"] ?? ctx.query.get("token");
    if (token !== config.adminToken) {
      return sendError(ctx.req, ctx.res, 401, "unauthorized", "Header X-API-Key tidak valid.");
    }
  } else {
    const remote = ctx.req.socket.remoteAddress ?? "";
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    if (!isLocal) {
      return sendError(
        ctx.req,
        ctx.res,
        403,
        "forbidden",
        "Set variabel ADMIN_TOKEN untuk mengizinkan refresh dari luar localhost.",
      );
    }
  }
  const force = parseBooleanParam(ctx.query.get("force"), true);
  const sources = String(ctx.query.get("sources") ?? "official,community")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => ["official", "community"].includes(item));
  const summary = await ctx.store.updater.run({
    force,
    sources: sources.length ? sources : ["official", "community"],
    ttlMs: force ? 0 : config.refreshTtlMs,
  });
  await ctx.store.reloadCaches();
  sendJson(
    ctx.req,
    ctx.res,
    200,
    envelope({ refresh: summary, years: ctx.store.listYears().filter((item) => item.sourceKind !== "none") }, storeMeta(ctx.store)),
    { ttl: 0 },
  );
}

/* -------------------------------- iCalendar -------------------------------- */

function foldIcalLine(line, limit = 74) {
  if (Buffer.byteLength(line, "utf8") <= limit) return [line];
  const parts = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > limit) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`));
}

export function buildIcal(entries, { year = null, calendarName = null } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const title = calendarName ?? `Hari Libur Nasional dan Cuti Bersama Indonesia${year ? ` ${year}` : ""}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//api-harilibur-id//Hari Libur Indonesia//ID",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeICS(title)}`,
    `X-WR-TIMEZONE:${config.timezone}`,
  ];
  for (const entry of entries) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${entry.date}-${entry.type}@api-harilibur-id`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${entry.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${(addDaysISO(entry.date, 1) ?? entry.date).replace(/-/g, "")}`,
      `SUMMARY:${escapeICS(entry.name ?? "Hari Libur")}`,
      `DESCRIPTION:${escapeICS(
        `${entry.type_label ?? entry.type}${entry.tentative ? " (belum pasti)" : ""} — sumber: SKB 3 Menteri`,
      )}`,
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap((line) => foldIcalLine(line)).join("\r\n")}\r\n`;
}

/* ------------------------------ rate limiter ------------------------------- */

function createRateLimiter(limitPerMinute) {
  if (!limitPerMinute) return null;
  const buckets = new Map();
  return (req) => {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limitPerMinute;
  };
}

/* ---------------------------------- server ---------------------------------- */

function createContext(req, res, query, url, store, params) {
  const ctx = { req, res, query, url, store, params };
  Object.assign(ctx, {
    handleHealth: () => handleHealth(ctx),
    handleHolidays: (yearFromPath) => handleHolidays(ctx, yearFromPath),
    handleYears: () => handleYears(ctx),
    handleMeta: () => handleMeta(ctx),
    handleCheck: (dateFromPath) => handleCheck(ctx, dateFromPath),
    handleNext: () => handleNext(ctx),
    handleUpcoming: () => handleUpcoming(ctx),
    handleIcal: () => handleIcal(ctx),
    handleRefresh: () => handleRefresh(ctx),
  });
  return ctx;
}

export async function createServer({ store: providedStore = null, log = console } = {}) {
  const store =
    providedStore ??
    (await new HolidayStore({
      dataDir: config.dataDir,
      cacheDir: config.cacheDir,
      refreshTtlMs: config.refreshTtlMs,
      log,
    }).init());
  const rateLimiter = createRateLimiter(config.rateLimitPerMinute);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const { url, query } = parseQuery(req.url ?? "/");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "OPTIONS") {
        send(req, res, 204, "", { ttl: 0 });
        return;
      }
      const route = routes.find(
        (candidate) =>
          candidate.pattern.test(pathname) &&
          (candidate.method === req.method || (req.method === "HEAD" && candidate.method === "GET")),
      );
      if (!route) {
        sendError(
          req,
          res,
          404,
          "not_found",
          `Endpoint ${req.method} ${pathname} tidak ditemukan. Daftar endpoint ada di /api.`,
        );
        return;
      }
      if (rateLimiter && !rateLimiter(req)) {
        sendError(req, res, 429, "rate_limited", "Terlalu banyak permintaan, coba lagi sebentar lagi.");
        return;
      }
      const match = route.pattern.exec(pathname);
      const ctx = createContext(req, res, query, url, store, match ? match.slice(1) : []);
      await route.handler(ctx);
    } catch (error) {
      const status = error?.status ?? 500;
      if (status >= 500) log.error?.("[api] error:", error);
      sendError(req, res, status, error?.code ?? "internal_error", error?.message ?? "Terjadi kesalahan");
    } finally {
      log.info?.(`[api] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  server.keepAliveTimeout = 65000;
  server.store = store;
  return server;
}

/* --------------------------------- startup --------------------------------- */

async function refreshAndReload(store, log = console) {
  try {
    const summary = await store.updater.run({ force: false, ttlMs: config.refreshTtlMs });
    await store.reloadCaches();
    const official = summary.results.official;
    log.info?.(
      `[api] pemutakhiran selesai: artikel resmi tersimpan=${official?.articleCount ?? 0}, entri komunitas=${
        summary.results.community?.entryCount ?? 0
      }`,
    );
    return summary;
  } catch (error) {
    log.warn?.(`[api] pemutakhiran gagal (tetap memakai data SKB terkurasi): ${error.message}`);
    return null;
  }
}

export async function start({ port = config.port, host = config.host, log = console } = {}) {
  const store = await new HolidayStore({
    dataDir: config.dataDir,
    cacheDir: config.cacheDir,
    refreshTtlMs: config.refreshTtlMs,
    log,
  }).init();
  const server = await createServer({ store, log });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log.info?.(
    `[api] api-harilibur-id v${SERVER_VERSION} berjalan di http://localhost:${port} (timezone referensi ${config.timezone})`,
  );
  log.info?.(`[api] tahun tersedia: ${store.curatedYears().join(", ") || "(belum ada data terkurasi)"}`);

  let timer = null;
  if (config.autoRefresh) {
    refreshAndReload(store, log);
    timer = setInterval(() => refreshAndReload(store, log), config.refreshIntervalMs);
    timer.unref?.();
  }

  const shutdown = (signal) => {
    log.info?.(`[api] menerima ${signal}, menutup server...`);
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(signal));

  return { server, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((error) => {
    console.error("[api] gagal start:", error);
    process.exit(1);
  });
}





