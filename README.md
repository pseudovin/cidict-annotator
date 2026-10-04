# CC-CIDICT Annotator — Node.js

Backend + client web untuk anotasi teks Mandarin: pinyin inline di atas
kata (elemen `<ruby>` bawaan browser) dan popup definisi bahasa Indonesia
saat hover (tap pada perangkat sentuh).

Port 1:1 dari implementasi Rust ke Node.js:

| Komponen | Rust | Node.js |
|---|---|---|
| HTTP server | axum | express |
| Segmentasi | jieba-rs | @node-rs/jieba (binding resmi; algoritma identik) |
| SQLite | rusqlite | `node:sqlite` (bawaan Node 22.5+, tanpa dependensi native) |
| Frontend | vanilla JS | sama (single-file build) |

## Syarat

- Node.js 22.5+ (butuh `node:sqlite` bawaan; disarankan 22 LTS)
- npm atau pnpm

## Menjalankan

```bash
npm install
npm run build   # menghasilkan dist/cidict-annotator.min.js
npm start
```

Buka http://localhost:3100 untuk halaman demo.

Server membaca file `.env` di direktori project secara otomatis (tanpa
paket tambahan). Salin `.env.example` menjadi `.env` lalu sesuaikan.
Environment variable dari sistem (misalnya panel hosting) selalu menang
atas nilai di `.env`. Path relatif dihitung dari direktori project.

## Environment variable

| Nama | Default | Keterangan |
|---|---|---|
| `PORT` | `3100` | Port listen |
| `CIDICT_DB` | `./data/fixture.db` | Path file SQLite kamus |
| `CIDICT_DB_VERSION_FILE` | _(kosong)_ | Path file JSON manifest (`{"version": int, "databaseMd5": hex, ...}`); bila diset, update DB terdeteksi dari field `version`, kamus di-reload otomatis tanpa restart, dan integritas file diverifikasi via `databaseMd5` |
| `CIDICT_DB_HASH_CHECK` | `true` | Verifikasi `databaseMd5` saat (re)load DB (`false` = skip) |
| `CIDICT_MIN_FREQ` | `1000` | Batas bawah frekuensi leksikon segmentasi |
| `CIDICT_HMM` | `false` | Model HMM jieba (`true`/`false`) |
| `CIDICT_CACHE_SIZE` | `1000` | Jumlah maksimum entri cache annotate di memori (`0` = cache nonaktif) |
| `CIDICT_CACHE_FILE` | `./data/annotate-cache.db` | File SQLite cache persisten (survive restart); kosongkan untuk menonaktifkan |
| `CIDICT_CACHE_DISK_SIZE` | `10000` | Jumlah maksimum entri cache di disk |

## API

| Endpoint | Keterangan |
|---|---|
| `GET /api/health` | `{ ok, version, db_version, entries, hmm, split_words }` (`db_version`: integer dari `CIDICT_DB_VERSION_FILE`, `null` bila tak dikonfigurasi) |
| `POST /api/annotate` | Body `{ text }` → `{ tokens, defs, v }` |
| `GET /api/lookup?text=..` | → `{ word, def }` |
| `POST /api/seg-reload` | Muat ulang `segment_overrides.txt` dan `pinyin_priority.txt`, bangun ulang leksikon, kosongkan cache — tanpa restart |
| `GET /static/cidict-annotator.min.js` | Client single-file (termasuk CSS) |
| `GET /` | Halaman demo |

`POST /api/annotate` (key pendek, definisi ter-dedup):

```json
{
  "tokens": ["这个", "特别", "好", "今天"],
  "defs": {
    "这个": { "r": [{ "y": "zhège", "d": ["ini"] }], "t": "這個" },
    "好":   { "r": [{ "y": "hǎo", "d": ["bagus; baik"] },
                    { "y": "hào", "d": ["suka"] }], "t": null }
  },
  "v": "1791109522067.4575:0"
}
```

- `tokens`: token ber-hanzi hasil segmentasi, berurutan. Tanda baca dan
  spasi tidak dikirim (kecuali token tersebut memiliki definisi) untuk
  memperkecil response; client merekonstruksi teks utuh dari urutannya.
- `defs`: key = surface kata; kata yang berulang hanya dikirim sekali.
- `r`: daftar bacaan, diurutkan berdasarkan skor prioritas —
  `y` = pinyin bertanda nada, `d` = daftar definisi. Satu section popup
  per bacaan.
- `t`: bentuk tradisional dash-encoded (`-書`), `null` bila identik
  dengan simplified. Client menampilkannya sebagai `[-書]`.
- `v`: versi data (untuk cache). Response menyertakan header
  `X-Cache: HIT`/`MISS`.

## Segmentasi dan force-split

Leksikon segmenter dibangun dari tabel `entries` (simplified +
traditional) dengan batas bawah frekuensi `CIDICT_MIN_FREQ`.

`segment_overrides.txt` — satu kata per baris — memaksa kata tersebut
dipecah oleh segmenter. Kata override tidak dihapus dari leksikon,
melainkan di-**demote** (frekuensinya dibuat 1) sehingga segmenter hampir
selalu memecahnya (misalnya 想来 → 想 | 来), tetapi tetap graceful bila
alternatif pecahan justru lebih buruk. Baris `//` atau `#` dinonaktifkan.
Padanan tradisional/simplified ikut terkena otomatis.
Berlaku ulang tanpa restart via `POST /api/seg-reload`.

## Normalisasi pinyin

Database menulis spasi di antara semua suku kata (`kě yǐ`,
`Běi jīng Dà xué`). Saat disajikan via API, pinyin dinormalisasi ke
ortografi baku — data di database tidak diubah:

1. Spasi dihilangkan: `kě yǐ` → `kěyǐ`.
2. Suku kata berawalan huruf kapital (kecuali yang pertama) menandai awal
   kata baru: `Běi jīng Dà xué` → `Běijīng Dàxué`.
3. Suku kata berawalan a/o/e disambung apostrof: `píng ān` → `píng'ān`.

## Prioritas bacaan

Urutan bacaan untuk kata dengan beberapa pinyin ditentukan oleh skor
tunggal (diadaptasi dari `score_variant()` plugin WordPress CC-CIDICT;
dihitung sekali per bacaan):

| Komponen | Skor |
|---|---|
| Override cocok persis (`喝 = hē` vs `hē`) | +1000 |
| Override cocok normalisasi (`了 = le` vs `le`) | +900 |
| Definisi mengandung kata partikel | +10 |
| Definisi "marga" / "nama keluarga" | −10 |
| Pinyin kapital (nama diri) | −4 |
| "varian lama", "(kuno)", "(dialek)" | −3 |
| "(sastra)", "varian dari", "kata serapan", "singkatan dari", dll. | −1 |
| Pinyin huruf kecil (bentuk umum) | +1 |
| Jumlah sense definisi (diminishing, maks) | +6 |
| Frekuensi entry (skala log, tidak mendominasi) | +0–7 |

Seri diputus oleh `pinyin_marks` (deterministik). Override eksplisit
ditulis di `pinyin_priority.txt` dengan format `<kata> = <pinyin>`
(nilai boleh beberapa, dipisah koma — misalnya `得 = de, děi`).
Nilai default: `了=le`, `着=zhe`, `地=de`, `没=méi`, `喝=hē`.
Baris tak valid diabaikan dengan peringatan di log server; padanan
tradisional/simplified ikut otomatis. Muat ulang tanpa restart via
`POST /api/seg-reload`.

## Cache, chunking, loading

- **Cache server**: dua tier. Tier 1 memori per sha1 teks
  (`CIDICT_CACHE_SIZE`, LRU sederhana). Tier 2 SQLite persisten
  (`CIDICT_CACHE_FILE`, default `./data/annotate-cache.db`,
  `CIDICT_CACHE_DISK_SIZE` default 10000) sehingga cache survive
  restart; tulis ke disk async dan tidak memblokir respons.
  Kedua tier di-purge saat versi data berubah — yaitu saat file
  database diganti (mtime dicek maksimal sekali per detik) atau
  `POST /api/seg-reload` dipanggil. Header respons:
  `X-Cache: HIT/MISS` dan `X-Cache-Tier: memory/disk/miss`.
- **Cache client**: hasil per chunk teks di-cache di memori, dikunci
  oleh versi data `v` dari server.
- **Chunking**: teks panjang dipecah per `chunkSize` karakter (default
  2000; `0` menonaktifkan), diutamakan pada `\n` lalu `。！？；…`, dan
  di-fetch secara paralel (`maxConcurrency`, default 3, fail-fast).
- **Loading**: opsi `loading` menampilkan indikator selama request
  berlangsung (lihat referensi client di bawah).

## Referensi client

```html
<script src="//api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
<script>cidict.annotate('.artikel', { theme: 'light' });</script>
```

`apiBase` default adalah origin tempat script dimuat, sehingga contoh di
atas langsung berfungsi. Untuk API di domain lain:

```js
cidict.configure({ apiBase: 'https://api.example.org' });
```

### Opsi

Opsi dapat diberikan per pemanggilan (`annotate`, `annotateText`) atau
global via `configure`. Opsi per pemanggilan menimpa opsi global.

| Opsi | Default | Keterangan |
|---|---|---|
| `apiBase` | `null` | Base URL API. `null` = origin script ini; `''` = origin halaman |
| `theme` | `'light'` | Tema popup: `'light'` \| `'dark'` |
| `showPopups` | `true` | Tampilkan popup definisi (hover/tap/keyboard) |
| `showInline` | `true` | Tampilkan pinyin inline di atas kata |
| `chunkSize` | `2000` | Pecah teks panjang per N karakter (`0` = nonaktif) |
| `maxConcurrency` | `3` | Jumlah maksimum fetch paralel per annotate |
| `loading` | `null` | Selector atau `{ target, show }` untuk indikator loading (lihat bawah) |

Opsi `loading`: selama request berlangsung, elemen target ditampilkan
dengan `display: <show>` (default `'block'`) dan diberi class
`cidict-loading` (dapat dipakai untuk animasi via CSS). Elemen
disembunyikan otomatis saat opsi dipasang, sehingga tidak perlu
`display: none` manual; display asal dipulihkan setelah selesai.
Aman untuk beberapa pemanggilan bersamaan (ref-count).

```js
cidict.annotate('.artikel', { loading: '#loader' });
// atau dengan display kustom:
cidict.annotate('.artikel', { loading: { target: '#loader', show: 'flex' } });
```

### Fungsi

| Fungsi | Keterangan |
|---|---|
| `cidict.annotate(selector?, options?)` | Anotasi elemen (default seluruh `body`). Mengembalikan Promise. Menganotasi per text-node sehingga struktur DOM tetap utuh; node tanpa karakter Hanzi dilewati |
| `cidict.annotateText(text, options?)` | Mengembalikan Promise berisi string HTML hasil anotasi (tanpa inject ke DOM) |
| `cidict.annotateElement(container, text, options?)` | Render hasil `annotateText` ke dalam container |
| `cidict.unannotate(selector?)` | Kembalikan elemen ke teks biasa. Mengembalikan `this` |
| `cidict.lookup(word)` | Mengembalikan Promise `{ word, def }` dari `/api/lookup` |
| `cidict.health()` | Mengembalikan Promise `{ ok, version, entries, ... }` dari `/api/health` |
| `cidict.showPopups(bool)` | Nyalakan/matikan popup. Mengembalikan `this` |
| `cidict.showInline(bool)` | Nyalakan/matikan pinyin inline. Mengembalikan `this` |
| `cidict.togglePinyin(bool?)` | Toggle pinyin inline. Tanpa argumen = balik status; dengan boolean = set eksplisit. Mengembalikan `this` |
| `cidict.theme(name)` | `'light'` \| `'dark'`. Mengembalikan `this` |
| `cidict.toggleTheme(name?)` | Toggle theme popup light ↔ dark. Tanpa argumen = balik status; dengan `'light'`/`'dark'` = set eksplisit. Mengembalikan `this` |
| `cidict.toggleHanzi(bool?)` | Toggle Simplified ↔ Traditional. Tanpa argumen = balik status; dengan boolean = set eksplisit. Instan (tanpa request) karena bentuk tradisional sudah di-render sebagai atribut `data-trad` pada tiap `<ruby>`. Mengembalikan `this` |
| `cidict.configure(options)` | Set opsi global. Mengembalikan `this` |
| `cidict.supported()` | `true` bila `window.fetch` tersedia |
| `cidict.destroy()` | Bersihkan anotasi, listener, popup, dan CSS. Mengembalikan `this` |
| `cidict.version` | Versi client, misalnya `'2.3.0'` |

`window.CidictAnnotator` tersedia sebagai alias.

### Preferensi tersimpan (localStorage)

`showInline`, `showPopups`, `theme`, dan status Simplified/Traditional
disimpan otomatis ke `localStorage` (satu objek JSON di kunci
`cidict_prefs`) setiap kali diubah lewat `showInline()`, `showPopups()`,
`theme()`, atau `toggleHanzi()`, lalu dipulihkan saat script di-load.
Opsi eksplisit yang diberikan ke `annotate()`/`annotateText()` tetap
menang atas nilai tersimpan untuk pemanggilan tersebut, tetapi tidak
menimpa simpanan.

Interaksi popup: hover membuka popup secara instan di desktop; popup
langsung tertutup begitu pointer keluar dari hanzi (hover pada popup
tidak mempertahankannya, agar hanzi di belakang popup tetap terjangkau);
tap/klik toggle di perangkat sentuh; `Enter`/`Space` pada kata yang
difokuskan membuka popup, `Escape` menutupnya.

## Deploy ke Hostinger Node.js Web App

1. Upload seluruh folder project (atau hubungkan repo git). Jalankan
   `npm run build` terlebih dahulu (atau pastikan `dist/` ikut ter-upload).
2. Di panel: startup file = `server.js` (atau `npm start`); `npm install`
   berjalan otomatis.
3. Set `CIDICT_DB` di panel ke path file SQLite kamus di hosting
   (atau tulis di file `.env`), lalu upload file `.db` via File Manager.
4. Restart aplikasi. Halaman demo ada di `/`, API di `/api/*`, client di
   `/static/cidict-annotator.min.js`.

SQLite memakai `node:sqlite` bawaan Node.js (tanpa native module, tanpa
kompilasi). `@node-rs/jieba` menyediakan prebuilt binary untuk Linux x64
sehingga tidak memerlukan toolchain kompilasi di server.

## Update database kamus (tanpa restart)

Backend mendeteksi pergantian `cc-cidict.db` dan me-reload kamus secara
otomatis (hot reload): handle DB, leksikon jieba, prepared statements,
dan prioritas pinyin dibangun ulang; kedua tier cache di-purge. Request
pertama setelah update menanggung biaya rebuild (sekali saja).

Dua mode deteksi (lihat `CIDICT_DB_VERSION_FILE`):

- **Manifest** (disarankan bila ada): set `CIDICT_DB_VERSION_FILE` ke
  file `version.json` — boleh file manifest yang sama dipakai updater
  APK; backend hanya membaca field `version` (integer, wajib) dan
  `databaseMd5` (untuk cek integritas: hash file harus cocok, bila
  tidak update ditolak dan DB lama tetap diserve; cek md5 ~0,2 detik
  untuk 77MB, bisa dimatikan via `CIDICT_DB_HASH_CHECK=false`).
- **mtime** (default): perubahan terdeteksi dari mtime file DB.

Prosedur upload yang aman:

1. Upload `cc-cidict.db` baru dengan nama sementara
   (mis. `cc-cidict.db.tmp`), lalu rename menjadi `cc-cidict.db`
   (rename atomik, menghindari DB setengah tertulis).
2. Bila memakai manifest: tulis `version.json` baru (naikkan `version`)
   dengan cara yang sama, **setelah** DB selesai di-rename.
3. Backend pickup otomatis dalam ~1 detik. Verifikasi via
   `GET /api/health` → field `db_version`.

Catatan: DB yang gagal divalidasi (tak bisa dibuka / `databaseMd5`
tak cocok) tidak akan dipakai — server tetap serve DB lama dan
mencoba lagi 30 detik kemudian. Log server mencatat setiap
reload sukses/gagal.

## Struktur

```
├── server.js                 # backend: API + static file server
├── pinyin.js                 # normalisasi pinyin + skor prioritas bacaan
├── segment_overrides.txt     # kata force-split (satu per baris)
├── pinyin_priority.txt       # override prioritas bacaan (<kata> = <pinyin>)
├── package.json
├── .env.example
├── src/
│   └── cidict-annotator.js   # source client (single-file; CSS di dalam)
├── dist/
│   └── cidict-annotator.min.js  # hasil `npm run build` → /static/
├── public/
│   └── index.html            # halaman demo
└── data/
    └── fixture.db            # database kecil untuk testing
```

## Pengembangan client

Edit `src/cidict-annotator.js`, lalu `npm run build`. Halaman demo
memakai `/static/cidict-annotator.min.js` hasil build.
