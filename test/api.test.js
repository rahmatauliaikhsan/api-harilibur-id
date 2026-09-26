/**
 * Pengujian: dataset SKB, parser halaman resmi, dan endpoint HTTP.
 *   npm test
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractSkbMetadata,
  findSections,
  htmlToText,
  parseItemList,
  parseOfficialHolidayPage,
} from "../src/lib/parse-official.js";
import { HolidayStore, similarHolidayNames } from "../src/lib/store.js";
import { buildISO, dayNameID, isWeekendISO, todayISO } from "../src/lib/utils.js";
import { buildIcal, createServer } from "../src/server.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const FIXTURE_DIR = path.join(ROOT_DIR, "test", "fixtures");

/* --------------------------------- utils ---------------------------------- */

describe("utils tanggal", () => {
  it("memvalidasi tanggal ISO terhadap kalender", () => {
    assert.equal(buildISO(2026, 2, 30), null);
    assert.equal(buildISO(2024, 2, 29), "2024-02-29");
    assert.equal(buildISO(2026, 12, 25), "2026-12-25");
  });

  it("menghitung nama hari sesuai SKB", () => {
    assert.equal(dayNameID("2026-01-01"), "Kamis");
    assert.equal(dayNameID("2026-08-17"), "Senin");
    assert.equal(dayNameID("2026-12-25"), "Jumat");
    assert.equal(dayNameID("2027-01-01"), "Jumat");
    assert.equal(dayNameID("2027-05-20"), "Kamis");
    assert.equal(dayNameID("2027-12-26"), "Minggu");
  });

  it("mengenali akhir pekan dan tanggal hari ini di Asia/Jakarta", () => {
    assert.equal(isWeekendISO("2026-09-26"), true);
    assert.equal(isWeekendISO("2026-09-25"), false);
    assert.match(todayISO("Asia/Jakarta"), /^\d{4}-\d{2}-\d{2}$/);
  });
});

/* ------------------------------ dataset SKB ------------------------------- */

describe("dataset SKB terkurasi", () => {
  const expectations = {
    2024: { national_holiday: 17, joint_leave: 10, tanggal_merah: 27 },
    2025: { national_holiday: 17, joint_leave: 11, tanggal_merah: 28 },
    2026: { national_holiday: 17, joint_leave: 8, tanggal_merah: 25 },
    2027: { national_holiday: 18, joint_leave: 8, tanggal_merah: 26 },
  };

  let store;
  before(async () => {
    store = await new HolidayStore({
      dataDir: DATA_DIR,
      cacheDir: path.join(os.tmpdir(), "api-harilibur-id-test-cache"),
    }).init();
  });

  for (const [year, expected] of Object.entries(expectations)) {
    it(`jumlah hari libur/cuti bersama ${year} sesuai SKB`, () => {
      const data = store.yearData(Number(year));
      assert.equal(data.counts.national_holiday, expected.national_holiday, `libur nasional ${year}`);
      assert.equal(data.counts.joint_leave, expected.joint_leave, `cuti bersama ${year}`);
      assert.equal(data.counts.tanggal_merah, expected.tanggal_merah, `tanggal merah ${year}`);
    });
  }

  it("setiap entri valid, unik, dan berlabel", () => {
    for (const { year } of store.listYears()) {
      const data = store.yearData(year);
      const keys = new Set();
      for (const entry of data.entries) {
        assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `format tanggal ${entry.date}`);
        assert.ok(entry.name && entry.name.length > 3, `nama entri ${entry.date}`);
        assert.ok(["national_holiday", "joint_leave", "observance"].includes(entry.type), `tipe ${entry.type}`);
        assert.equal(entry.day, dayNameID(entry.date));
        const key = `${entry.date}|${entry.type}`;
        assert.ok(!keys.has(key), `duplikat ${key}`);
        keys.add(key);
      }
    }
  });

  it("mencatat amandemen SKB 2025 (18 Agustus 2025)", () => {
    const data = store.yearData(2025);
    const added = data.entries.find((entry) => entry.date === "2025-08-18");
    assert.ok(added, "entri 2025-08-18 harus ada");
    assert.equal(added.type, "joint_leave");
    assert.match(added.amendedBy ?? "", /933/);
    assert.equal(data.skb.amendments.length, 1);
  });

  it("tetap memberi jawaban untuk tahun di luar dataset terkurasi", () => {
    const merged = store.mergeYear(2030, { includeObservance: true });
    assert.ok(["none", "community", "curated-skb", "official-parsed"].includes(merged.sourceKind));
    assert.ok(Array.isArray(merged.entries));
  });
});

/* --------------------------------- parser --------------------------------- */

describe("parser halaman resmi SKB", () => {
  it("mengubah HTML menjadi teks dengan batas blok", () => {
    const text = htmlToText("<p>1. 1 Januari 2026:</p><ul><li>Hari Libur</li></ul>");
    assert.match(text, /1\. 1 Januari 2026:/);
    assert.match(text, /Hari Libur/);
  });

  it("menggabungkan rentang antar bulan (31 Maret-1 April)", () => {
    const entries = parseItemList(
      "1. 31 Maret-1 April (Senin-Selasa) Idulfitri 1446 Hijriah 2. 18 April (Jumat) Wafat Yesus Kristus",
      { year: 2025, type: "national_holiday" },
    );
    assert.deepEqual(
      entries.map((entry) => entry.date),
      ["2025-03-31", "2025-04-01", "2025-04-18"],
    );
    assert.equal(entries[0].name, "Idulfitri 1446 Hijriah");
    assert.equal(entries[2].name, "Wafat Yesus Kristus");
  });

  it("mengurai daftar tanggal berderet tanpa pengulangan bulan", () => {
    const entries = parseItemList("20, 23, dan 24 Maret (Jumat, Senin, dan Selasa): Idulfitri 1447 Hijriah", {
      year: 2026,
      type: "joint_leave",
    });
    assert.deepEqual(
      entries.map((entry) => entry.date),
      ["2026-03-20", "2026-03-23", "2026-03-24"],
    );
    assert.ok(entries.every((entry) => entry.name === "Idulfitri 1447 Hijriah"));
    assert.ok(entries.every((entry) => entry.warnings.length === 0), `warnings: ${JSON.stringify(entries[0].warnings)}`);
  });

  it("menandai peringatan bila nama hari tidak cocok dengan kalender", () => {
    const entries = parseItemList("17 Agustus (Senin): Proklamasi Kemerdekaan", {
      year: 2027,
      type: "national_holiday",
    });
    assert.equal(entries.length, 1);
    assert.ok(
      entries[0].warnings.some((warning) => warning.startsWith("hari_tidak_cocok")),
      "harus memunculkan peringatan hari_tidak_cocok",
    );
  });

  it("menemukan section libur nasional dan cuti bersama", () => {
    const text =
      "Berikut daftar lengkap hari libur nasional 2027: 1 Januari (Jumat): Tahun Baru 2027 Masehi " +
      "6 Februari (Sabtu): Tahun Baru Imlek 2578 Kongzili " +
      "Sementara daftar hari cuti bersama 2027 yaitu: 5 Februari (Jumat): Tahun Baru Imlek 2578 Kongzili";
    const sections = findSections(text, { expectedYear: 2027 });
    assert.equal(sections.length, 2);
    assert.equal(sections[0].type, "national_holiday");
    assert.equal(sections[1].type, "joint_leave");
  });

  it("mengambil tanggal SKB dari area artikel, bukan dari berita di sidebar", () => {
    // Tanggal sidebar muncul lebih dulu secara tekstual pada beberapa situs;
    // bila dipakai, artikel dianggap "lebih baru" dan menimpa data terkurasi.
    const withSidebar = extractSkbMetadata(
      "SKB Nomor: 1497 Tahun 2025 tentang Hari Libur Nasional dan Cuti Bersama Tahun 2026. " +
        "1 Januari (Kamis): Tahun Baru 2026 Masehi. Berita Terbaru: 26 September 2026",
      2026,
    );
    assert.equal(withSidebar.signedAt, null);
    assert.equal(withSidebar.declaredYear, 2026);
  });

  it("menerima tanggal SKB yang masuk akal di semua posisi penulisan", () => {
    assert.equal(
      extractSkbMetadata(
        "Jakarta, 19 September 2025 SKB Nomor: 1497 Tahun 2025 tentang Hari Libur Nasional " +
          "dan Cuti Bersama Tahun 2026. 1 Januari (Kamis): Tahun Baru 2026 Masehi",
        2026,
      ).signedAt,
      "2025-09-19",
    );
    assert.equal(
      extractSkbMetadata(
        "Surat Nomor: 2 Tahun 2026 tentang Hari Libur Nasional dan Cuti Bersama Tahun 2027 " +
          "pada 15 September 2026",
        2027,
      ).signedAt,
      "2026-09-15",
    );
    assert.equal(
      extractSkbMetadata(
        "SKB (19/09/2025) Nomor: 1497 Tahun 2025 tentang Hari Libur Nasional " +
          "dan Cuti Bersama Tahun 2026",
        2026,
      ).signedAt,
      "2025-09-19",
    );
  });

  for (const fixture of [
    { file: "setneg-2026.html", year: 2026, expected: { national_holiday: 17, joint_leave: 8 } },
    { file: "kemenkopmk-2027.html", year: 2027, expected: { national_holiday: 18, joint_leave: 8 } },
    { file: "setkab-2025.html", year: 2025, expected: { national_holiday: 17, joint_leave: 10 } },
  ]) {
    it(`hasil parse markup asli ${fixture.file} sama dengan data SKB`, async () => {
      let html;
      try {
        html = await fs.readFile(path.join(FIXTURE_DIR, fixture.file), "utf8");
      } catch {
        return; // fixture belum dibuat: jalankan `npm run fixtures`
      }
      const parsed = parseOfficialHolidayPage(html, { year: fixture.year, url: `https://example.test/${fixture.file}` });
      const counts = parsed.entries.reduce((acc, entry) => {
        acc[entry.type] = (acc[entry.type] ?? 0) + 1;
        return acc;
      }, {});
      assert.ok(parsed.year >= 2025 && parsed.year <= 2027, `tahun hasil parse: ${parsed.year}`);
      assert.equal(counts.national_holiday ?? 0, fixture.expected.national_holiday, "jumlah libur nasional");
      assert.equal(counts.joint_leave ?? 0, fixture.expected.joint_leave, "jumlah cuti bersama");
      assert.ok(!parsed.warnings.some((warning) => warning.startsWith("jumlah_")), `warnings: ${parsed.warnings}`);
      assert.ok(!parsed.entries.some((entry) => entry.warnings.includes("nama_kosong")), "tidak boleh ada nama kosong");
    });
  }
});

/* ---------------------------------- API ----------------------------------- */

describe("HTTP API", () => {
  let server;
  let baseUrl;

  before(async () => {
    const store = await new HolidayStore({
      dataDir: DATA_DIR,
      cacheDir: path.join(os.tmpdir(), `api-harilibur-id-test-${Date.now()}`),
    }).init();
    server = await createServer({ store, log: { info() {}, warn() {}, error() {} } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("GET /api/holidays/2026 mengembalikan 17 libur nasional + 8 cuti bersama", async () => {
    const response = await fetch(`${baseUrl}/api/holidays/2026`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.ok(response.headers.get("etag"));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.year, 2026);
    assert.equal(body.data.counts.national_holiday, 17);
    assert.equal(body.data.counts.joint_leave, 8);
    assert.equal(body.data.holidays.length, 25);
    assert.equal(body.data.skb.numbers[0].number, "1497");
    const paskah = body.data.holidays.find((entry) => entry.date === "2026-04-05");
    assert.equal(paskah.is_libur_nasional, true);
    assert.equal(paskah.is_weekend, true);
  });

  it("mendukung ETag/304", async () => {
    const first = await fetch(`${baseUrl}/api/holidays/2027`);
    const etag = first.headers.get("etag");
    const second = await fetch(`${baseUrl}/api/holidays/2027`, { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304);
  });

  it("GET /api/check/2026-08-17 mengenali hari kemerdekaan", async () => {
    const body = await (await fetch(`${baseUrl}/api/check/2026-08-17`)).json();
    assert.equal(body.data.is_libur_nasional, true);
    assert.equal(body.data.is_tanggal_merah, true);
    assert.equal(body.data.is_workday, false);
    assert.equal(body.data.day, "Senin");
    assert.equal(body.data.next_workday, "2026-08-18");
  });

  it("GET /api/check membedakan cuti bersama dengan hari kerja biasa", async () => {
    const cuti = await (await fetch(`${baseUrl}/api/check?date=2026-03-23`)).json();
    assert.equal(cuti.data.is_cuti_bersama, true);
    assert.equal(cuti.data.is_workday, false);

    const kerja = await (await fetch(`${baseUrl}/api/check?date=2026-03-25`)).json();
    assert.equal(kerja.data.is_tanggal_merah, false);
    assert.equal(kerja.data.is_workday, true);
  });

  it("GET /api/years memuat tahun 2024-2027", async () => {
    const body = await (await fetch(`${baseUrl}/api/years`)).json();
    const years = body.data.years.map((item) => item.year);
    for (const year of [2024, 2025, 2026, 2027]) assert.ok(years.includes(year), `tahun ${year}`);
  });

  it("GET /api/next mengambil tanggal merah berikutnya", async () => {
    const body = await (await fetch(`${baseUrl}/api/next?from=2026-09-26&limit=3`)).json();
    assert.deepEqual(
      body.data.holidays.map((entry) => entry.date),
      ["2026-12-24", "2026-12-25", "2027-01-01"],
    );
    assert.equal(body.data.holidays[0].days_until, 89);
  });

  it("GET /api/upcoming?days=2 menyertakan hari ini", async () => {
    const body = await (await fetch(`${baseUrl}/api/upcoming?from=2026-12-25&days=2`)).json();
    assert.deepEqual(
      body.data.holidays.map((entry) => entry.date),
      ["2026-12-25"],
    );
  });

  it("GET /api/holidays?format=ics mengembalikan kalender", async () => {
    const response = await fetch(`${baseUrl}/api/holidays?year=2026&format=ics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/calendar/);
    const body = await response.text();
    assert.match(body, /BEGIN:VCALENDAR/);
    assert.match(body, /SUMMARY:Tahun Baru 2026 Masehi/);
    assert.equal((body.match(/BEGIN:VEVENT/g) ?? []).length, 25);
    assert.match(body, /END:VCALENDAR/);
  });

  it("menolak parameter tidak valid dan tahun tanpa data", async () => {
    const invalidYear = await fetch(`${baseUrl}/api/holidays?year=abc`);
    assert.equal(invalidYear.status, 400);
    assert.equal((await invalidYear.json()).error.code, "invalid_parameter");

    const invalidDate = await fetch(`${baseUrl}/api/check?date=17-08-2026`);
    assert.equal(invalidDate.status, 400);

    const empty = await fetch(`${baseUrl}/api/holidays/2030`);
    assert.equal(empty.status, 404);
    assert.equal((await empty.json()).error.code, "data_not_found");

    const missing = await fetch(`${baseUrl}/api/entah`);
    assert.equal(missing.status, 404);
  });

  it("GET /api/meta melaporkan sumber dan jadwal pemutakhiran", async () => {
    const body = await (await fetch(`${baseUrl}/api/meta`)).json();
    assert.equal(body.ok, true);
    assert.ok(body.data.sources.officialProviders.length >= 3);
    assert.ok(body.data.sources.officialFeeds.some((feed) => feed.id === "setkab-feed"));
    assert.equal(body.data.schedule.autoRefresh, true);
    assert.equal(typeof body.data.conflicts, "object");
  });

  it("GET /api/meta melaporkan kesegaran data untuk monitoring mandiri", async () => {
    const body = await (await fetch(`${baseUrl}/api/meta`)).json();
    const freshness = body.data.freshness;
    assert.ok(freshness, "blok freshness harus ada");
    // dataAgeDays boleh null saat cache refresh belum pernah terisi.
    assert.ok(freshness.dataAgeDays === null || typeof freshness.dataAgeDays === "number");
    assert.equal(typeof freshness.ttlDays, "number");
    assert.ok(Array.isArray(freshness.draftYears));
    // staleWarning boleh null (data segar) atau string berisi pesan.
    assert.ok(freshness.staleWarning === null || typeof freshness.staleWarning === "string");
  });

  it("menandai tahun berstatus draft sebagai belum pasti", async () => {
    const body = await (await fetch(`${baseUrl}/api/holidays/2028`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.data.status, "draft");
    assert.ok(body.data.holidays.length > 0);
    // Semua entri draft wajib tentative: konsumen tidak boleh menganggapnya final.
    for (const entry of body.data.holidays) {
      assert.equal(entry.tentative, true, `entri ${entry.date} harus tentative`);
    }
    // Draft tidak boleh mengklaim cuti bersama (feed komunitas tidak memuatnya).
    assert.equal(body.data.counts.joint_leave, 0);
  });

  it("GET /api/years menandai tahun draft lewat isDraft", async () => {
    const body = await (await fetch(`${baseUrl}/api/years`)).json();
    const draft = body.data.years.find((item) => item.year === 2028);
    assert.ok(draft, "tahun 2028 harus terdaftar");
    assert.equal(draft.status, "draft");
    assert.equal(draft.isDraft, true);
    const official = body.data.years.find((item) => item.year === 2026);
    assert.equal(official.isDraft, false);
  });

  it("membangun iCalendar yang valid", () => {
    const ics = buildIcal(
      [
        {
          date: "2026-01-01",
          name: "Tahun Baru 2026 Masehi",
          type: "national_holiday",
          type_label: "Hari Libur Nasional",
          tentative: false,
        },
      ],
      { year: 2026 },
    );
    assert.match(ics, /DTSTART;VALUE=DATE:20260101/);
    assert.match(ics, /DTEND;VALUE=DATE:20260102/);
    assert.ok(ics.endsWith("\r\n"));
  });
});

/* ---------------------- penggabungan data multi-sumber --------------------- */

describe("penggabungan data multi-sumber", () => {
  let store;
  let cacheDir;

  before(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-harilibur-id-merge-"));
    await fs.writeFile(
      path.join(cacheDir, "community.json"),
      JSON.stringify(
        {
          fetchedAt: "2026-09-26T00:00:00.000Z",
          sources: [{ id: "guangrei-calendar", label: "uji", url: "-", ok: true, count: 3 }],
          errors: [],
          entries: [
            {
              date: "2026-05-28",
              name: "Idul Adha (Lebaran Haji)",
              type: "national_holiday",
              tentative: false,
              sourceId: "guangrei-calendar",
            },
            {
              date: "2026-02-19",
              name: "1 Ramadan 1447 Hijriah",
              type: "observance",
              tentative: false,
              sourceId: "guangrei-calendar",
            },
            {
              date: "2030-01-01",
              name: "Tahun Baru 2030 Masehi",
              type: "national_holiday",
              tentative: true,
              sourceId: "guangrei-calendar",
            },
          ],
        },
        null,
        2,
      ),
    );
    store = await new HolidayStore({ dataDir: DATA_DIR, cacheDir }).init();
  });

  after(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("tidak menduplikasi tanggal resmi dengan tipe berbeda dari feed komunitas", () => {
    const data = store.yearData(2026);
    assert.equal(data.counts.national_holiday, 17);
    assert.equal(data.counts.joint_leave, 8);
    assert.equal(data.entries.filter((entry) => entry.date === "2026-05-28").length, 1);
    assert.equal(data.sourceKind, "curated-skb");
  });

  it("menyertakan perayaan komunitas hanya bila diminta", () => {
    assert.equal(
      store.yearData(2026).entries.some((entry) => entry.type === "observance"),
      false,
    );
    const withObservance = store.yearData(2026, { includeObservance: true });
    assert.ok(withObservance.entries.some((entry) => entry.date === "2026-02-19"));
  });

  it("memakai data komunitas untuk tahun yang belum punya SKB terkurasi", () => {
    const data = store.yearData(2030);
    assert.equal(data.sourceKind, "community");
    const entry = data.entries.find((item) => item.date === "2030-01-01");
    assert.ok(entry, "entri komunitas 2030-01-01 harus tersedia");
    assert.equal(entry.tentative, true);
    assert.equal(entry.sourceKind, "community");
  });

  it("menganggap penulisan nama berbeda tetapi perayaan sama bukan konflik", () => {
    assert.equal(store.yearData(2026).conflicts.filter((conflict) => conflict.date === "2026-05-28").length, 0);
    assert.equal(similarHolidayNames("Iduladha 1447 Hijriah", "Idul Adha (Lebaran Haji)"), true);
    assert.equal(similarHolidayNames("Tahun Baru Imlek 2578 Kongzili", "Tahun Baru 2027 Masehi"), false);
  });
});



