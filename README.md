# CC-CIDICT Annotator

Anotasi teks Mandarin di web: **pinyin inline** di atas kata + **popup definisi Bahasa Indonesia** saat hover/klik/tap.

- Backend Node.js: Express + jieba + SQLite (`node:sqlite` bawaan — tanpa native module)
- Client: satu file JavaScript (`dist/cidict-annotator.min.js`, CSS di-inject otomatis)
- Demo: https://api.cidict.org/ · client: `https://api.cidict.org/static/cidict-annotator.min.js`

Versi: server `1.0.0` · client `2.0.2` · data kamus `v27` (125.626 entri).

## Mulai cepat

```bash
git clone https://github.com/pseudovin/cidict-annotator.git
cd cidict-annotator
npm install
mkdir -p data
curl -o data/cc-cidict.db https://cdn.cidict.org/annotator/cc-cidict.db
curl -o data/version.json https://cdn.cidict.org/annotator/version.json
cp .env.example .env   # opsional; env sistem selalu menang
npm run build           # hasilkan dist/cidict-annotator.min.js
npm start
```

Buka http://localhost:3100 — halaman demo langsung menganotasi contoh teks.

> Syarat: Node.js 22.5+.

## Cara kerja

1. `POST /api/annotate` menerima teks → server memecah kata dengan jieba (leksikon dari DB + `segment_overrides.txt`), mengambil definisi + pinyin per kata.
2. Client me-render `<ruby>` (pinyin inline) dan popup/dock definisi.
3. Pinyin dinormalisasi ke ortografi baku (`kě yǐ` → `kěyǐ`, `píng ān` → `píng'ān`) — DB tidak diubah.

## Konfigurasi

Hanya variabel berawalan `CIDICT_*` yang dibaca. File `.env` di direktori project dimuat otomatis (tanpa pustaka tambahan); variabel dari sistem selalu menang. Path relatif dihitung dari direktori project.

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3100` | Port listen |
| `CIDICT_DB` | `./data/fixture.db` | Path file SQLite kamus |
| `CIDICT_DB_VERSION_FILE` | _(kosong)_ | Path `version.json`; bila diset, update DB terdeteksi dari field `version`, kamus di-reload otomatis tanpa restart, integritas diverifikasi via `databaseMd5` |
| `CIDICT_DB_HASH_CHECK` | `true` | Verifikasi `databaseMd5` saat (re)load (`false` = skip) |
| `CIDICT_MIN_FREQ` | `1000` | Batas bawah frekuensi leksikon jieba |
| `CIDICT_HMM` | `false` | Model HMM jieba |
| `CIDICT_CACHE_SIZE` | `1000` | Entri cache memori, LRU (`0` = mati) |
| `CIDICT_CACHE_FILE` | `./data/annotate-cache.db` | Cache disk persisten (kosongkan = mati) |
| `CIDICT_CACHE_DISK_SIZE` | `10000` | Entri cache disk |
| `CIDICT_RELOAD_TOKEN` | _(kosong)_ | Token proteksi `POST /api/seg-reload` (lihat bawah) |

## API

| Endpoint | Keterangan |
|---|---|
| `GET /api/health` | `{ ok, version, db_version, entries, ... }` |
| `POST /api/annotate` | `{ text }` → `{ tokens, defs, v }` |
| `GET /api/lookup?text=..` | `{ word, def }` |
| `POST /api/seg-reload` | Reload `segment_overrides.txt` + `pinyin_priority.txt`, rebuild leksikon, purge cache — tanpa restart. Terproteksi token (lihat bawah) |
| `GET /static/cidict-annotator.min.js` | Client single-file |
| `GET /` | Halaman demo |

```jsonc
// POST /api/annotate  { "text": "这个特别好" }
{
  "tokens": ["这个", "特别", "好"],
  "defs": {
    "这个": { "r": [{ "y": "zhège", "d": ["ini"] }], "t": "這個" },
    "好":   { "r": [{ "y": "hǎo", "d": ["bagus; baik"] },
                    { "y": "hào", "d": ["suka"] }], "t": null }
  },
  "v": "1791109522067.4575:0"   // versi data — kunci cache client
}
```

- `r`: daftar bacaan terurut skor prioritas (`y` = pinyin bernada, `d` = definisi).
- `t`: bentuk tradisional (`null` bila sama dengan simplified).
- Header `X-Cache: HIT/MISS`, `X-Cache-Tier: memory/disk/miss`.
- Teks panjang dipecah per `chunkSize` (default 2000) dan di-fetch paralel (`maxConcurrency`, default 3).

### Proteksi `POST /api/seg-reload`

Endpoint ini mengubah state server, jadi tidak terbuka bebas:

- Koneksi **TCP langsung dari localhost** (mis. `curl` via SSH ke
  `http://127.0.0.1:3100/api/seg-reload`) → bebas token.
- Dari **luar** → wajib token: header `Authorization: Bearer <token>`
  atau query `?token=<token>`, dengan `<token>` = isi
  `CIDICT_RELOAD_TOKEN`. Tanpa token yang cocok → `403`.
- Request via reverse proxy selalu membawa `X-Forwarded-For` sehingga
  tidak dihitung sebagai localhost — token tetap wajib walau nginx-nya
  sekota dengan Node.
- Bila `CIDICT_RELOAD_TOKEN` kosong, non-localhost selalu `403`.

```bash
# via SSH (tanpa token)
curl -X POST http://127.0.0.1:3100/api/seg-reload

# dari luar (dengan token)
curl -X POST -H "Authorization: Bearer $TOKEN" https://api.cidict.org/api/seg-reload
# atau: curl -X POST "https://api.cidict.org/api/seg-reload?token=$TOKEN"
```

Tetap `POST` (bukan `GET`): endpoint berefek samping, dan token di URL
rentan nyangkut di log — header lebih bersih.

## Client

```html
<script src="https://api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
<script>
  cidict.annotate('.artikel', { theme: 'light' });
</script>
```

`apiBase` default = origin tempat script dimuat. Untuk API di domain lain:

```js
cidict.configure({ apiBase: 'https://api.example.org' });
```

### Opsi

| Opsi | Default | Keterangan |
|---|---|---|
| `theme` | `'light'` | `'light'` \| `'dark'` |
| `showInline` | `true` | Pinyin inline di atas kata |
| `showPopups` | `true` | UI definisi (`false` = mati total) |
| `displayMode` | `'popup'` | `'popup'` \| `'docked'` \| `'both'` |
| `dockAlign` | `'right'` | Posisi dock di desktop (mobile selalu bottom) |
| `chunkSize` | `2000` | Pecah teks panjang per N karakter (`0` = mati) |
| `maxConcurrency` | `3` | Fetch paralel per annotate |
| `loading` | `null` | Selector / `{ target, show }` indikator loading |

### Mode tampilan

- **`popup`** (default): hover (desktop) → popup transien berisi 1 bacaan + maks 4 definisi; popup langsung tertutup saat pointer keluar hanzi. Klik/tap → popup terpin (semua bacaan, bisa scroll).
- **`docked`**: panel definisi — mobile jadi bottom sheet, desktop di kiri/kanan. Navigasi kata « » dan bacaan ‹ ›, auto-scroll ke hanzi aktif.
- **`both`**: desktop = hover popup + klik dock bersamaan; mobile = tap popup + tombol ⇄ untuk pindah mode.

Preferensi pengunjung (`displayMode`, tema, dll) tersimpan di `localStorage`
(`cidict_prefs`); mobile dan desktop punya simpanan mode terpisah
(`displayModeMobile`), dan nilai tersimpan selalu menang atas opsi
`annotate()`. Footer "cidict.org" di popup/dock adalah link ke
`https://cidict.org/kamus/?q=<hanzi>`.

### Fungsi

| Fungsi | Keterangan |
|---|---|
| `cidict.annotate(sel?, opt?)` | Anotasi elemen (Promise) |
| `cidict.annotateText(text, opt?)` | Promise<string> HTML hasil anotasi |
| `cidict.setDisplayMode(m)` | `'popup'` \| `'docked'` \| `'both'` |
| `cidict.toggleDisplayMode()` | Toggle `popup` <> `docked` (tombol ⇄ di mobile) |
| `cidict.togglePinyin()` / `toggleHanzi()` / `toggleTheme()` | Toggle tampilan (lihat `scripts/test_buttons.md`) |
| `cidict.showPopups(b)` | Master switch UI definisi |
| `cidict.showInline(b)` | Pinyin inline on/off |
| `cidict.lookup(w)` / `cidict.health()` | Promise ke API langsung |
| `cidict.unannotate(sel?)` / `cidict.destroy()` | Bersihkan anotasi |
| `cidict.version` | Versi client |

## Data kamus

File data tidak ikut di repo (77 MB), diunduh terpisah dari CDN:

- https://cdn.cidict.org/annotator/cc-cidict.db — database SQLite kamus
- https://cdn.cidict.org/annotator/version.json — manifest (`version`, `databaseMd5`, `databaseSha256`, jumlah entri)

Set `CIDICT_DB` ke path file `.db`, dan `CIDICT_DB_VERSION_FILE` ke
`version.json` untuk mengaktifkan **hot reload**: setiap ada `version`
baru, kamus + leksikon + prioritas pinyin dibangun ulang otomatis tanpa
restart (DB korup/ditolak → versi lama tetap diserve). Prosedur update
yang aman: upload `.db` baru dengan nama sementara lalu rename atomik,
kemudian naikkan `version` di manifest.

Dua file teks ikut mengatur perilaku kamus (reload via `POST /api/seg-reload`):

- `segment_overrides.txt` — satu kata per baris = force-split (kata
  di-demote, bukan dihapus, sehingga segmenter hampir selalu memecahnya).
- `pinyin_priority.txt` — `<kata> = <pinyin>` memaksa urutan bacaan
  (mis. `喝 = hē`); selain itu skor otomatis: partikel +10, marga −10,
  kapital −4, arkais −3, varian −1, huruf kecil +1, sense + frekuensi.

## Deploy VPS

```bash
# di server
git clone https://github.com/pseudovin/cidict-annotator.git /opt/cidict
cd /opt/cidict && npm install --omit=dev && npm run build
mkdir -p /opt/cidict-data
curl -o /opt/cidict-data/cc-cidict.db https://cdn.cidict.org/annotator/cc-cidict.db
curl -o /opt/cidict-data/version.json https://cdn.cidict.org/annotator/version.json
```

`/etc/systemd/system/cidict.service`:

```ini
[Unit]
Description=CC-CIDICT Annotator
After=network.target

[Service]
WorkingDirectory=/opt/cidict
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3100
Environment=CIDICT_DB=/opt/cidict-data/cc-cidict.db
Environment=CIDICT_DB_VERSION_FILE=/opt/cidict-data/version.json

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now cidict
```

Di depan pasang reverse proxy (nginx/Caddy) untuk TLS dan arahkan ke
`http://127.0.0.1:3100`. Simpan file data **di luar** direktori aplikasi
(mis. `/opt/cidict-data/`) agar tidak ikut ter-reset saat redeploy.

## Struktur repo

```
├── server.js                 # backend: API + static file server
├── pinyin.js                 # normalisasi pinyin + skor prioritas bacaan
├── segment_overrides.txt     # kata force-split (satu per baris)
├── pinyin_priority.txt       # override prioritas bacaan
├── src/cidict-annotator.js   # source client (single-file; CSS di dalam)
├── dist/cidict-annotator.min.js  # hasil `npm run build` → /static/
├── public/index.html         # halaman demo
├── scripts/test_buttons.md   # contoh tombol toggle untuk frontend
└── .env.example              # contoh konfigurasi
```

Pengembangan client: edit `src/cidict-annotator.js` → `npm run build` →
halaman demo memakai hasil build via `/static/`.
