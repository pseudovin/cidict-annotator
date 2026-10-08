# CC-CIDICT Annotator

Annotasi teks Mandarin langsung di halaman web dengan **pinyin inline** di atas hanzi dan **definisi Bahasa Indonesia** melalui popup atau panel.

CC-CIDICT Annotator menggunakan:

- **Node.js** untuk backend
- **Express** untuk HTTP API dan static file server
- **`@node-rs/jieba`** untuk segmentasi teks Mandarin
- **SQLite** untuk database kamus
- **JavaScript single-file** untuk client/browser
- **CC-CIDICT** sebagai sumber data kamus dari [cidict.org](https://cidict.org/)

> **Persyaratan:** Node.js **22.5+**

## Penggunaan

### Gunakan API Publik yang Sudah Tersedia

Anda tidak perlu deploy backend sendiri. Untuk menggunakan annotator di website, cukup muat client dari server CC-CIDICT:

```html
<script src="//api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
<script>
  cidict.annotate('.artikel', { theme: 'light' });
</script>
```

Contoh:

```html
<p class="artikel">
  这个故事特别有意思。
</p>

<script src="//api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
<script>
  cidict.annotate('.artikel');
</script>
```

`'.artikel'` adalah selector CSS untuk elemen yang ingin dianotasi.

Secara default, client menggunakan **origin tempat file JavaScript dimuat** sebagai `apiBase`. Dengan contoh di atas, request API otomatis diarahkan ke `api.cidict.org`.

### Konfigurasi

```js
cidict.configure({
  apiBase: 'https://api.example.org'
});

cidict.annotate('.artikel', {
  theme: 'light',
  displayMode: 'popup'
});
```

Opsi yang tersedia:

| Opsi | Default | Keterangan |
|---|---|---|
| `theme` | `'light'` | `'light'` atau `'dark'` |
| `showInline` | `true` | Tampilkan pinyin inline |
| `showPopups` | `true` | Tampilkan popup/panel definisi |
| `displayMode` | `'popup'` | `'popup'`, `'docked'`, atau `'both'` |
| `dockAlign` | `'right'` | Posisi dock desktop: `'left'` atau `'right'` |
| `chunkSize` | `2000` | Ukuran chunk untuk teks panjang; `0` untuk menonaktifkan |
| `maxConcurrency` | `3` | Jumlah request anotasi paralel |
| `loading` | `null` | Selector atau `{ target, show }` untuk indikator loading |

### Mode Tampilan

**`popup`** — mode default. Di desktop, hover menampilkan pinyin utama dan hingga 4 definisi; klik membuka informasi lengkap. Pada perangkat tanpa hover, interaksi dilakukan dengan tap.

**`docked`** — definisi ditampilkan dalam panel. Di desktop panel berada di kiri/kanan; di mobile menjadi bottom sheet.

**`both`** — popup dan dock tersedia bersama dengan perilaku yang menyesuaikan perangkat.

Preferensi pengunjung seperti tema, pinyin, hanzi tradisional, dan mode tampilan disimpan di `localStorage` menggunakan key `cidict_prefs`.

### API Client

```js
cidict.annotate('.artikel');
cidict.annotateText('这个故事特别有意思。');

cidict.lookup('喝');
cidict.health();

cidict.setDisplayMode('docked');
cidict.toggleDisplayMode();

cidict.togglePinyin();
cidict.toggleHanzi();
cidict.toggleTheme();

cidict.showInline(false);
cidict.showPopups(false);

cidict.unannotate('.artikel');
cidict.destroy();
```

`annotate()` dan `annotateText()` mengembalikan `Promise`.

`annotateText()` mengembalikan HTML hasil anotasi tanpa langsung memasukkannya ke halaman:

```js
const html = await cidict.annotateText('你好世界');
document.querySelector('#hasil').innerHTML = html;
```

## Self-Hosting di VPS

Backend dapat dijalankan sendiri pada VPS atau server Linux yang dapat menjalankan Node.js 22.5+.

> Deployment serverless seperti Vercel belum menjadi target atau konfigurasi resmi project ini. README ini hanya mendokumentasikan deployment pada server/VPS dengan proses Node.js yang berjalan terus-menerus.

### 1. Clone dan Install

```bash
git clone https://github.com/pseudovin/cidict-annotator.git /opt/cidict
cd /opt/cidict

npm install
npm run build
```

### 2. Download Database CC-CIDICT

Database **tidak disertakan di repository**.

Download **database CC-CIDICT dan `version.json` terbaru** dari halaman download resmi:

**https://cidict.org/download/**

Setelah diunduh, letakkan kedua file tersebut di server, misalnya:

```text
/opt/cidict-data/
├── cc-cidict.db
└── version.json
```

Nama file dapat disesuaikan dengan file yang tersedia pada halaman download.

### 3. Konfigurasi

Buat file `.env` di direktori project:

```env
PORT=3100

CIDICT_DB=/opt/cidict-data/cc-cidict.db
CIDICT_DB_VERSION_FILE=/opt/cidict-data/version.json

CIDICT_DB_HASH_CHECK=true

CIDICT_MIN_FREQ=1000
CIDICT_HMM=false

CIDICT_CACHE_SIZE=1000
CIDICT_CACHE_FILE=/opt/cidict-data/annotate-cache.db
CIDICT_CACHE_DISK_SIZE=10000
```

Variabel utama:

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3100` | Port HTTP server |
| `CIDICT_DB` | path database lokal | Path database SQLite |
| `CIDICT_DB_VERSION_FILE` | kosong | Path `version.json`; jika diaktifkan, versi database dapat dipantau untuk hot reload |
| `CIDICT_DB_HASH_CHECK` | `true` | Verifikasi `databaseMd5` dari `version.json` |
| `CIDICT_MIN_FREQ` | `1000` | Minimum frekuensi kata pada leksikon jieba |
| `CIDICT_HMM` | `false` | Aktif/nonaktif model HMM jieba |
| `CIDICT_CACHE_SIZE` | `1000` | Cache memori LRU; `0` untuk menonaktifkan |
| `CIDICT_CACHE_FILE` | path cache lokal | Cache SQLite persisten; kosongkan untuk menonaktifkan |
| `CIDICT_CACHE_DISK_SIZE` | `10000` | Jumlah maksimum entri cache disk |

### 4. Jalankan

```bash
npm start
```

Secara default server menggunakan port `3100`.

Untuk production, gunakan process manager seperti **systemd** dan reverse proxy seperti **nginx** atau **Caddy** untuk HTTPS.

### Contoh systemd

Buat:

```text
/etc/systemd/system/cidict.service
```

```ini
[Unit]
Description=CC-CIDICT Annotator
After=network.target

[Service]
WorkingDirectory=/opt/cidict
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
systemctl daemon-reload
systemctl enable --now cidict
```

Periksa service:

```bash
systemctl status cidict
curl http://127.0.0.1:3100/api/health
```

Kemudian arahkan reverse proxy ke:

```text
http://127.0.0.1:3100
```

### Simpan Database di Luar Direktori Aplikasi

Disarankan menyimpan database dan cache di luar repository, misalnya:

```text
/opt/cidict-data/
```

Dengan begitu, file data tidak ikut tertimpa ketika aplikasi di-update atau di-deploy ulang.

## Update Database

Self-hosting **tidak mengunduh database baru secara otomatis dari repository GitHub**.

Untuk memperoleh data terbaru, download kembali **database CC-CIDICT dan `version.json` terbaru** dari:

**https://cidict.org/download/**

Backend mendukung hot reload ketika `CIDICT_DB_VERSION_FILE` digunakan. Saat versi pada `version.json` berubah, server dapat memuat ulang database dan membangun ulang artefak turunannya tanpa restart.

Untuk keamanan, database baru diverifikasi menggunakan `databaseMd5`. Jika database tidak cocok atau gagal dimuat, database yang sedang aktif tetap digunakan.

Urutan update yang disarankan:

```text
download file terbaru
       ↓
upload database ke server
       ↓
pastikan upload selesai
       ↓
update version.json
       ↓
backend mendeteksi versi baru
       ↓
database di-reload
```

Jangan memperbarui `version.json` sebelum database baru tersedia sepenuhnya.

## API Backend

Backend menyediakan API untuk annotasi dan lookup:

| Endpoint | Keterangan |
|---|---|
| `GET /api/health` | Status service dan metadata database |
| `POST /api/annotate` | Segmentasi + pinyin + definisi |
| `GET /api/lookup?text=喝` | Lookup satu kata |
| `POST /api/seg-reload` | Reload aturan segmentasi dan prioritas pinyin |
| `GET /static/cidict-annotator.min.js` | Client JavaScript |
| `GET /` | Halaman demo |

### Contoh `POST /api/annotate`

Request:

```json
{
  "text": "这个特别好"
}
```

Response:

```json
{
  "tokens": ["这个", "特别", "好"],
  "defs": {
    "这个": {
      "r": [
        { "y": "zhège", "d": ["ini"] }
      ],
      "t": "這個"
    },
    "好": {
      "r": [
        { "y": "hǎo", "d": ["bagus; baik"] },
        { "y": "hào", "d": ["suka"] }
      ],
      "t": null
    }
  },
  "v": "1791109522067.4575:0"
}
```

Keterangan:

- `tokens` — hasil segmentasi jieba.
- `defs` — data kamus yang ditemukan.
- `r` — daftar bacaan; `y` = pinyin bertanda nada, `d` = definisi.
- `t` — bentuk tradisional; `null` bila sama dengan simplified.
- `v` — versi data yang digunakan sebagai bagian dari cache client.

Pinyin dinormalisasi ke bentuk ortografi yang lebih natural, misalnya:

```text
kě yǐ             → kěyǐ
píng ān           → píng'ān
Běi jīng Dà xué   → Běijīng Dàxué
```

Teks yang dikirim ke endpoint anotasi dibatasi hingga **20.000 karakter**. Client dapat memecah teks panjang menjadi beberapa chunk dan menjalankan request secara paralel.

## Kustomisasi Segmentasi dan Pinyin

### `segment_overrides.txt`

Daftar kata yang perlu diperlakukan sebagai **force-split** oleh segmenter.

Satu kata per baris. Komentar dapat diawali `#` atau `//`.

Perubahan dapat diterapkan tanpa restart:

```http
POST /api/seg-reload
```

### `pinyin_priority.txt`

Digunakan untuk memprioritaskan bacaan pinyin tertentu.

Format:

```text
<kata> = <pinyin>
```

Contoh:

```text
喝 = hē
```

Override ini berguna ketika sebuah kata memiliki beberapa kemungkinan bacaan dan urutan default tidak sesuai konteks yang diinginkan.

## Pengembangan

Source client:

```text
src/cidict-annotator.js
```

Build client:

```bash
npm run build
```

Output:

```text
dist/cidict-annotator.min.js
```

Backend:

```text
server.js
```

Normalisasi dan prioritas pinyin:

```text
pinyin.js
```

Aturan segmentasi:

```text
segment_overrides.txt
```

Prioritas bacaan:

```text
pinyin_priority.txt
```

## Lisensi & Sumber Data

CC-CIDICT Annotator menggunakan database dari **CC-CEDICT (© CC-CEDICT Contributors)**.
Versi Bahasa Indonesia awal dikembangkan oleh [Harmony Mandarin](https://harmonymandarin.com/), dan diteruskan secara mandiri sebagai proyek CC-CIDICT.
Didistribusikan di bawah lisensi Creative Commons Attribution–ShareAlike 4.0 International (CC BY-SA 4.0).
