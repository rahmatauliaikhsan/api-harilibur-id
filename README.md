# api-harilibur-id

API **hari libur nasional & cuti bersama Indonesia** berbasis **SKB 3 Menteri**
(Menteri Agama, Menteri Ketenagakerjaan, Menteri PANRB) yang **memantau dan
memperbarui datanya sendiri** dari sumber resmi — termasuk saat terbit SKB
perubahan (seperti penambahan cuti bersama 18 Agustus 2025).

Dibuat dengan **Node.js murni tanpa dependensi** (`node:http`, `fetch` bawaan,
`node:test`), jadi bisa dijalankan tanpa `npm install`.

## Kenapa perlu lapisan pemutakhiran?

SKB 3 Menteri terbit sekali setahun, tetapi **bisa diubah di tengah tahun**:

| Tahun | Dasar hukum | Isi |
| --- | --- | --- |
| 2024 | SKB No. 855/3/4 Tahun 2023 (12 Sep 2023) | 17 libur nasional + 10 cuti bersama |
| 2025 | SKB No. 1017/2/2 Tahun 2024 (14 Okt 2024) | 17 libur nasional + 10 cuti bersama |
| 2025 (perubahan) | SKB No. 933/1/3 Tahun 2025 (7 Agu 2025) | **+1 cuti bersama: 18 Agustus 2025** |
| 2026 | SKB No. 1497/2/5 Tahun 2025 (19 Sep 2025) | 17 libur nasional + 8 cuti bersama |
| 2027 | SKB No. 1205/3/2 Tahun 2026 (15 Sep 2026) | 18 libur nasional + 8 cuti bersama |

Service ini (a) menyimpan data SKB yang sudah diverifikasi sebagai baseline,
(b) **mem-parse ulang artikel resmi** secara berkala untuk memverifikasi dan
mendeteksi perubahan, lalu (c) otomatis menyajikan data terbaru bila SKB
perubahan muncul.

## Fitur

- **Tiga lapis sumber dengan prioritas jelas**: `official-parsed` (artikel resmi
  setkab/setneg/kemenkopmk hasil parse otomatis) → `curated-skb` (baseline
  terverifikasi di `data/skb/`) → `community` (feed komunitas sebagai pengisi
  celah & deteksi dini).
- **Deteksi otomatis**: RSS resmi (`setkab.go.id/feed/`, `kemenkopmk.go.id/rss.xml`),
  pola URL artikel SKB yang sudah diuji, dan halaman pencarian situs resmi.
- **Parser tahan format**: menangani `1 Januari (Kamis): ...`, daftar berderet
  (`20, 23, dan 24 Maret`), rentang (`10–11 Maret`), bahkan rentang antar bulan
  (`31 Maret-1 April`), sekaligus **memvalidasi nama hari** terhadap kalender.
- **Anti-duplikasi & deteksi konflik**: nama perayaan yang berbeda penulisan
  (mis. `Iduladha 1447 Hijriah` vs `Idul Adha (Lebaran Haji)`) tidak dianggap konflik.
- **Verifikasi silang (`verification`)**: setiap tahun bisa dicek apakah data SKB
  tersimpan masih sama dengan lampiran artikel resmi terbaru.
- **Cache HTTP**: `ETag`/`304`, `Cache-Control`, CORS, rate limit opsional.
- **Ekspor iCalendar** (`format=ics` / `/api/ical`) untuk Google Calendar/Outlook.
- **Scheduler internal** + CLI + endpoint admin untuk refresh.

## Struktur proyek

```
api-harilibur-id/
├── data/
│   ├── skb/2024.json … 2027.json   # baseline SKB terkurasi (sumber kebenaran manual)
│   └── cache/                      # dibuat otomatis: community.json, official.json, state.json
├── src/
│   ├── server.js                   # HTTP server, router, handler, iCalendar, scheduler
│   ├── lib/
│   │   ├── store.js                # penggabungan 3 lapis data + query + deteksi konflik
│   │   ├── updater.js              # orkestrasi pemutakhiran (official + community)
│   │   ├── sources.js              # definisi sumber, RSS/JSON fetcher, normalisasi
│   │   ├── parse-official.js       # parser halaman resmi SKB + metadata SKB
│   │   └── utils.js                # util tanggal (tanpa timezone server)
│   └── scripts/
│       ├── refresh.js              # CLI pemutakhiran + diff hasil parse
│       └── make-fixtures.js        # membuat fixture HTML asli untuk pengujian
└── test/
    ├── api.test.js                 # 33 test: dataset, parser, gabungan sumber, HTTP API
    └── fixtures/                   # potongan markup asli setneg/setkab/kemenkopmk
```

## Menjalankan

```bash
node src/server.js          # atau: npm start
npm run dev                 # mode watch
npm test                    # jalankan seluruh pengujian
npm run refresh             # perbarui data dari sumber resmi + feed komunitas
npm run refresh -- --force  # paksa ambil ulang semua sumber
```

Tanpa argumen pun `npm start` sudah menjalankan pemutakhiran awal di latar
belakang dan mengulanginya setiap `REFRESH_INTERVAL_MS` (default 12 jam).

### Variabel lingkungan

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Lokasi dataset SKB & cache |
| `CACHE_DIR` | `./data/cache` | Lokasi cache hasil pemutakhiran |
| `CACHE_TTL_SECONDS` | `21600` | `Cache-Control: max-age` respons API |
| `CORS_ORIGIN` | `*` | Origin yang diizinkan |
| `ADMIN_TOKEN` | *(kosong)* | Bila diisi, `POST /api/refresh` wajib `X-API-Key` |
| `AUTO_REFRESH` | `true` | Matikan dengan `false` (mis. untuk CI) |
| `REFRESH_INTERVAL_MS` | `43200000` | Interval pemutakhiran (12 jam) |
| `REFRESH_TTL_MS` | `21600000` | Cache internal sebelum sumber diambil ulang (6 jam) |
| `RATE_LIMIT_PER_MINUTE` | `0` | `0` = tanpa batas |
| `REFERENCE_TIMEZONE` | `Asia/Jakarta` | Zona waktu acuan `/api/today` |
| `FETCH_TIMEOUT_MS` | `25000` | Timeout request ke sumber |
| `FETCH_DELAY_MS` | `300` | Jeda sopan antar permintaan |

## Endpoint

Base URL contoh: `http://localhost:3000`

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/api` | Dokumentasi mesin (JSON) |
| GET | `/api/holidays?year=2026` | Semua hari libur + cuti bersama satu tahun |
| GET | `/api/holidays/2026` | Versi path langsung |
| GET | `/api/holidays?year=2026&format=ics` | Ekspor iCalendar |
| GET | `/api/holidays?year=2026&type=joint_leave` | Filter tipe (`national_holiday`, `joint_leave`, `observance`) |
| GET | `/api/holidays?from=2026-03-01&to=2026-04-30` | Filter rentang tanggal |
| GET | `/api/years` | Daftar tahun tersedia + jumlahnya |
| GET | `/api/today` | Status tanggal hari ini (zona `Asia/Jakarta`) |
| GET | `/api/check?date=2026-08-17` | Cek satu tanggal |
| GET | `/api/check/2026-08-17` | Versi path langsung |
| GET | `/api/next?from=2026-09-26&limit=3` | Tanggal merah berikutnya |
| GET | `/api/upcoming?days=45` | Tanggal merah dalam N hari ke depan |
| GET | `/api/meta` | Sumber, SKB, verifikasi, konflik, riwayat refresh |
| GET | `/api/ical?year=2026` | Ekspor iCalendar |
| POST | `/api/refresh` | Paksa pemutakhiran (`?force=true`, opsional `?sources=official`) |
| GET | `/health` | Health check |

### Contoh

```bash
curl "http://localhost:3000/api/holidays/2026?type=joint_leave"
```

```json
{
  "ok": true,
  "data": {
    "year": 2026,
    "status": "official",
    "sourceKind": "curated-skb",
    "skb": {
      "title": "Hari Libur Nasional dan Cuti Bersama Tahun 2026",
      "numbers": [
        { "ministry": "Kementerian Agama", "number": "1497", "year": 2025 },
        { "ministry": "Kementerian Ketenagakerjaan", "number": "2", "year": 2025 },
        { "ministry": "Kementerian PANRB", "number": "5", "year": 2025 }
      ],
      "signedAt": "2025-09-19",
      "sourceUrl": "https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026"
    },
    "verification": {
      "matchesOfficial": true,
      "signedAtCurated": "2025-09-19",
      "signedAtOfficial": "2025-09-19",
      "missingInOfficial": [],
      "extraInOfficial": []
    },
    "counts": { "national_holiday": 8, "joint_leave": 8, "tanggal_merah": 16 },
    "holidays": [
      {
        "date": "2026-02-16",
        "day": "Senin",
        "name": "Tahun Baru Imlek 2577 Kongzili",
        "type": "joint_leave",
        "type_label": "Cuti Bersama",
        "is_libur_nasional": false,
        "is_cuti_bersama": true,
        "is_tanggal_merah": true,
        "is_weekend": false,
        "tentative": false,
        "sourceKind": "curated-skb"
      }
    ]
  },
  "meta": { "generatedAt": "…", "referenceTimezone": "Asia/Jakarta", "cacheTtlSeconds": 21600 }
}
```

```bash
curl "http://localhost:3000/api/check/2026-08-17"
```

```json
{
  "ok": true,
  "data": {
    "date": "2026-08-17",
    "day": "Senin",
    "is_weekend": false,
    "is_libur_nasional": true,
    "is_cuti_bersama": false,
    "is_tanggal_merah": true,
    "is_workday": false,
    "name": "Proklamasi Kemerdekaan",
    "next_workday": "2026-08-18"
  }
}
```

Pemakaian iCalendar:

```
https://host/api/holidays?year=2026&format=ics
```

## Bagaimana data selalu ter-update

1. **Scheduler** (default 12 jam) atau `POST /api/refresh` menjalankan
   `Updater.run()`.
2. **Pemindaian artikel resmi** (`refreshOfficial`):
   - RSS resmi setkab.go.id & kemenkopmk.go.id → deteksi berita SKB baru/perubahan.
   - Pola URL artikel SKB teruji per tahun (`setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_<tahun>`, dsb.).
   - Halaman pencarian situs resmi sebagai cadangan.
   - Setiap artikel di-parse, lalu **hanya diterima** bila jumlah tanggalnya
     cocok dengan jumlah yang dinyatakan artikel itu sendiri ("sebanyak 17 hari
     dan 8 hari") dan tidak ada nama hari yang bertentangan dengan kalender.
3. **Feed komunitas** (`refreshCommunity`): `guangrei/APIHariLibur_V2` dan
   `nager.date` dipakai untuk mengisi tahun yang belum punya SKB terkurasi,
   serta menandai tanggal yang "belum pasti".
4. **Pemilihan sumber per tahun** (`store.resolveYearSource`):
   - artikel resmi dipakai bila tanggal tanda tangannya **lebih baru** dari
     baseline (mis. SKB perubahan) → API otomatis menyajikan versi terbaru;
   - jika tidak, baseline `data/skb/<tahun>.json` yang dipakai, dan hasil
     perbandingan dilaporkan di `verification` serta `/api/meta`.
5. **Cache internal** (`REFRESH_TTL_MS`, default 6 jam) mencegah request berulang
   ke situs pemerintah; ada jeda sopan 300 ms antar permintaan.

### Memperbarui baseline SKB secara manual

Saat SKB tahun baru terbit (biasanya September–Oktober untuk tahun berikutnya):

1. Jalankan `npm run refresh -- --force` dan lihat blok
   `perbandingan hasil parse vs data tersimpan`.
2. Buat `data/skb/<tahun>.json` (contoh struktur di bawah), atau
   **cukup andalkan `official-parsed`**: bila artikel resmi tahun itu berhasil
   diparse dan tanggal tanda tangannya lebih baru, API sudah menyajikan datanya
   tanpa perubahan berkas apa pun.
3. Tambahkan entri tahun baru + `skb.numbers`, `skb.signedAt`, `skb.sourceUrl`
   agar sumbernya terekam.

```json
{
  "year": 2028,
  "status": "official",
  "skb": {
    "title": "Hari Libur Nasional dan Cuti Bersama Tahun 2028",
    "numbers": [
      { "ministry": "Kementerian Agama", "number": "…", "year": 2027 },
      { "ministry": "Kementerian Ketenagakerjaan", "number": "…", "year": 2027 },
      { "ministry": "Kementerian PANRB", "number": "…", "year": 2027 }
    ],
    "signedAt": "2027-09-…",
    "sourceUrl": "…",
    "amendments": []
  },
  "entries": [
    { "date": "2028-01-01", "name": "Tahun Baru 2028 Masehi", "type": "national_holiday" }
  ]
}
```

Nilai `type`: `national_holiday` (hari libur nasional) atau `joint_leave`
(cuti bersama). Entri hasil SKB perubahan boleh menambahkan
`"amendedBy": "SKB Nomor … "`.

## Pengujian

```bash
npm test              # 33 test: util tanggal, dataset SKB, parser, gabungan sumber, HTTP API
npm run fixtures      # ambil ulang potongan markup asli dari situs resmi (butuh internet)
```

Pengujian parser memakai **markup asli** yang disimpan di `test/fixtures/`
(setneg 2026, kemenkopmk 2027, setkab 2025) dan memverifikasi bahwa hasil parse
menghasilkan jumlah tanggal yang persis sama dengan SKB.

## Deployment

### Docker

```bash
docker build -t api-harilibur-id .
docker run -p 3000:3000 -e ADMIN_TOKEN=rahasia -v data-cache:/app/data/cache api-harilibur-id
```

### VPS / PM2

```bash
npm install -g pm2
pm2 start src/server.js --name api-harilibur-id --time
```

### Cron pemutakhiran mandiri (tanpa proses server menjerumus)

```cron
# perbarui data 4x sehari
0 */6 * * * cd /srv/api-harilibur-id && /usr/bin/node src/scripts/refresh.js --force >> /var/log/harilibur.log 2>&1
```

### Platform serverless (Vercel/Netlify/Cloudflare)

Filesystem biasanya read-only, jadi pemutakhiran di dalam fungsi tidak persisten.
Pola yang disarankan: jalankan `node src/scripts/refresh.js --force` lewat
**cron/GitHub Actions**, commit folder `data/cache/`, lalu deploy; server membaca
cache tersebut. Scheduler internal tinggal dimatikan (`AUTO_REFRESH=false`).

#### Vercel (sudah dikonfigurasi di repo)

Deploy otomatis lewat integrasi GitHub — cukup hubungkan repositori di
[Vercel](https://vercel.com), tanpa build command dan tanpa dependensi.

| Berkas | Fungsi |
| --- | --- |
| `api/index.js` | Serverless function yang menginstans `HolidayStore` sekali (warm start) lalu meneruskan request ke router HTTP yang sama dengan mode lokal |
| `vercel.json` | `rewrites` semua path ke fungsi tersebut, sekaligus memakai wildcard `$1` yang diteruskan sebagai query `__path` supaya routing internal tetap berjalan; `includeFiles: data/**` memastikan dataset ikut ter-bundle |
| `src/server.js` | Default export handler agar Vercel mendeteksi entrypoint Node.js |

Contoh request yang sudah terverifikasi pada URL produksi:

```bash
curl https://api-harilibur-id-chi.vercel.app/api/today
curl https://api-harilibur-id-chi.vercel.app/api/holidays/2026
curl https://api-harilibur-id-chi.vercel.app/api/check/2026-08-17
curl https://api-harilibur-id-chi.vercel.app/api/ical?year=2026
curl https://api-harilibur-id-chi.vercel.app/api/meta
```

Endpoint `POST /api/refresh` sengaja dibalas `501 read_only_environment` di
lingkungan serverless. Pemutakhiran tetap dilakukan GitHub Actions setiap hari
(08:15 WIB) yang meng-commit `data/cache/`, lalu Vercel auto-deploy ulang —
jadi data di URL produksi tetap fresk tanpa perlu server hidup permanen.

### GitHub Actions

Berkas `.github/workflows/refresh.yml` sudah tersedia: menjalankan pengujian,
memperbarui data harian dari sumber resmi, dan meng-commit perubahan
`data/cache/` serta `data/skb/` bila ada.

## Catatan & batasan

- **Cuti bersama bersifat fakultatif bagi pekerja swasta** dan mengurangi hak
  cuti tahunan; ASN mengikuti ketentuan pemerintah. Rujuk lampiran SKB resmi
  untuk keputusan formal.
- Data `community` (mis. `nager.date`) hanya mencakup sebagian hari libur
  nasional dan **tidak memuat cuti bersama** — selalu laporkan `sourceKind`
  pada setiap entri bila aplikasi Anda sensitif terhadap ketepatan.
- Nama kegiatan disusun mengikuti frasa pada artikel resmi; penulisan bisa
  berbeda tipis antar tahun (mis. `Idulfitri` vs `Hari Raya Idul Fitri`).
- Tanggal berbasis kalender Hijriah dapat berubah bila Kementerian Agama
  menetapkan hasil sidang isbat yang berbeda; itulah alasan service ini
  memantau artikel resmi secara berkala, bukan sekadar menghitung kalender.
- Service ini bukan produk resmi pemerintah; selalu tautkan sumber resmi
  (setkab.go.id / setneg.go.id / kemenkopmk.go.id) pada aplikasi Anda.

## Lisensi

MIT. Data hari libur bersumber dari dokumen/artikel resmi pemerintah Indonesia
dan feed komunitas; hak cipta naskah tetap milik pemiliknya.


