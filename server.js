/**
 * CC-CIDICT annotator backend (Node.js): HTTP API + static file server.
 * Segmentasi @node-rs/jieba, kamus SQLite (node:sqlite bawaan Node).
 * Dokumentasi lengkap: README.md.
 */

import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { Jieba } from '@node-rs/jieba';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizePinyin, sortReadings, normPinyin } from './pinyin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- .env ----------
// Parser .env minimal bawaan (tanpa dependensi): `KEY=value`, kutip
// tunggal/ganda, komentar `#`, dan prefix `export `. Environment asli
// selalu menang atas isi file.
function loadDotenv() {
  let text;
  try {
    text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return; // tidak ada .env → pakai environment biasa
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let val = m[2].trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length > 1 && val[val.length - 1] === q) {
      val = val.slice(1, -1);
      if (q === '"') {
        val = val.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      const ci = val.search(/\s#/);
      val = (ci >= 0 ? val.slice(0, ci) : val).trim();
    }
    process.env[m[1]] = val;
  }
}
loadDotenv();

// Baca env dengan nama CIDICT_*.
function env(key, dflt) {
  return process.env[key] !== undefined ? process.env[key] : dflt;
}

const VERSION = '1.0.0';
const PORT = Number.parseInt(env('PORT', '3100'), 10) || 3100;
// Path relatif dihitung dari direktori project (bukan cwd), agar stabil
// dijalankan dari mana pun.
const DB_PATH = path.resolve(__dirname, env('CIDICT_DB', path.join('data', 'fixture.db')));
const MIN_FREQ = Number.parseInt(env('CIDICT_MIN_FREQ', '1000'), 10) || 1000;
const HMM = /^true$/i.test(env('CIDICT_HMM', 'false'));
const OVERRIDES_FILE = path.join(__dirname, 'segment_overrides.txt');
// Frekuensi untuk kata override: cukup kecil agar hampir selalu kalah
// bersaing (terpecah), tapi tidak nol agar tetap graceful.
const DEMOTE_FREQ = 1; // override force-split: frekuensi sangat kecil, bukan 0
const MAX_CHARS = 20000;

// ---------- segment overrides ----------

// ./segment_overrides.txt: satu kata per baris; baris kosong dan
// komentar (// atau #) diabaikan.
function loadSplitWords() {
  const words = new Set();
  try {
    const text = fs.readFileSync(OVERRIDES_FILE, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) continue;
      words.add(line.split(/\s+/)[0]);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[cidict] gagal baca overrides: ${err.message}`);
  }
  return words;
}

// ---------- prioritas bacaan pinyin ----------

const PRIO_FILE = path.join(__dirname, 'pinyin_priority.txt');

// ./pinyin_priority.txt: "<kata> = <pinyin>[, ...]" per baris.
// Padanan tradisional/simplified ikut terisi otomatis dari DB.
function loadPinyinPriority(dbh = db) {
  const map = new Map();
  try {
    const text = fs.readFileSync(PRIO_FILE, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) continue;
      const m = line.match(/^(\S+)\s*=\s*(.+?)\s*$/);
      if (!m) {
        console.error(`[cidict] baris pinyin_priority.txt diabaikan: ${line}`);
        continue;
      }
      const specs = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      if (!specs.length) {
        console.error(`[cidict] baris pinyin_priority.txt diabaikan: ${line}`);
        continue;
      }
      map.set(m[1], { raws: specs, norms: specs.map(normPinyin) });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[cidict] gagal baca pinyin_priority: ${err.message}`);
  }
  const keys = [...map.keys()];
  if (keys.length) {
    const ph = keys.map(() => '?').join(',');
    const rows = dbh
      .prepare(
        `SELECT simplified, traditional FROM entries
         WHERE simplified IN (${ph}) OR traditional IN (${ph})`
      )
      .all(...keys, ...keys);
    for (const r of rows) {
      const spec = map.get(r.simplified) ?? map.get(r.traditional);
      for (const w of [r.simplified, r.traditional]) {
        if (w && w.trim() && !map.has(w) && spec) map.set(w, spec);
      }
    }
  }
  return map;
}

// ---------- dictionary loading ----------
// Kamus bisa di-reload tanpa restart saat file DB diganti. Deteksi perubahan:
// - bila CIDICT_DB_VERSION_FILE diset: field `version` (integer) di file JSON
//   tersebut (mis. manifest version.json updater APK; field lain diabaikan);
// - bila tidak diset: mtime file DB (fallback).
// Integritas file dipastikan via `databaseMd5` dari manifest (bila ada):
// hash tak cocok -> DB ditolak (tanda file bukan yang dideskripsikan
// manifest / korup saat upload). Cek bisa dimatikan via CIDICT_DB_HASH_CHECK.
const DB_VERSION_FILE = env('CIDICT_DB_VERSION_FILE', '');
const DB_VERSION_PATH = DB_VERSION_FILE ? path.resolve(__dirname, DB_VERSION_FILE) : null;
const HASH_CHECK = /^true$/i.test(env('CIDICT_DB_HASH_CHECK', 'true'));

let db = null;           // handle SQLite kamus aktif (readonly)
let jieba = null;        // segmenter dari leksikon aktif
let splitWords = [];     // daftar force-split aktif
let pinyinPrio = new Map();
let lookupStmt = null;
let countStmt = null;
let manifestVer = null;        // version integer dari version.json (null = tak ada)
let manifestMd5 = null;        // databaseMd5 dari version.json (null = tak dicek)
let activeManifestVer = null;  // versi manifest DB yang sedang diserve
let lastManifestMtime = -1;
let lastMtime = -1;
let lastVerCheck = 0;
let activeDbSignal = null;   // sinyal DB yang sedang aktif
let reloadCooldownUntil = 0; // backoff bila reload gagal

const COUNT_SQL = `SELECT COUNT(*) AS n FROM entries WHERE status = 'active' AND merged_into IS NULL`;
const LOOKUP_SQL =
  `SELECT e.traditional AS trad, e.simplified AS simp, e.pinyin,
          e.pinyin_toneless AS pinyin_toneless,
          COALESCE(e.frequency, 0) AS frequency,
          COALESCE(e.pinyin_marks, e.pinyin) AS pinyin_marks, d.text AS def
   FROM entries e
   JOIN definitions d ON d.entry_id = e.id
   WHERE e.status = 'active' AND e.merged_into IS NULL
     AND (e.simplified = ? OR e.traditional = ?)
   ORDER BY pinyin_marks, e.id, d.sort_order`;

// Sinyal perubahan DB, di-throttle 1 detik. Berubah -> kandidat reload.
function dbSignal() {
  const now = Date.now();
  if (now - lastVerCheck > 1000) {
    lastVerCheck = now;
    if (DB_VERSION_PATH) {
      try {
        const mtime = fs.statSync(DB_VERSION_PATH).mtimeMs;
        if (mtime !== lastManifestMtime) {
          lastManifestMtime = mtime;
          const j = JSON.parse(fs.readFileSync(DB_VERSION_PATH, 'utf8'));
          if (Number.isInteger(j.version)) manifestVer = j.version;
          manifestMd5 = (typeof j.databaseMd5 === 'string' && j.databaseMd5) ? j.databaseMd5.toLowerCase() : null;
        }
      } catch {
        // File sedang ditulis / tak bisa dibaca: pertahankan nilai lama,
        // coba lagi di jendela throttle berikutnya.
      }
    } else {
      try {
        lastMtime = fs.statSync(DB_PATH).mtimeMs;
      } catch {
        lastMtime = 0;
      }
    }
  }
  return DB_VERSION_PATH ? 'v' + manifestVer : String(lastMtime);
}

// MD5 file secara sinkron per chunk 4MB (tanpa memuat seluruh file ke
// memori). ~0,2 dtk untuk 77MB — murah untuk sekali jalan per update DB.
function fileMd5(file) {
  const h = createHash('md5');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// Pastikan file DB persis seperti yang dideskripsikan manifest (anti
// korup/truncated saat upload). Throw bila tak cocok. Tanpa databaseMd5
// di manifest, atau bila CIDICT_DB_HASH_CHECK=false, cek di-skip.
function verifyDbChecksum() {
  if (!HASH_CHECK || !manifestMd5) return;
  const t0 = Date.now();
  const sum = fileMd5(DB_PATH);
  if (sum !== manifestMd5) {
    throw new Error(`databaseMd5 tak cocok (file=${sum}, manifest=${manifestMd5}): DB bukan file yang dideskripsikan manifest`);
  }
  console.log(`[cidict] database md5 ok (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
}

// Buka + validasi DB lalu bangun semua artefak turunan. Throw bila tak valid;
// handle yang gagal selalu ditutup kembali.
function openDictionary() {
  verifyDbChecksum();
  const dbh = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const count = dbh.prepare(COUNT_SQL).get().n;
    const built = buildJieba(dbh);
    return {
      dbh,
      count,
      jieba: built.jieba,
      splitWords: built.splitWords,
      pinyinPrio: loadPinyinPriority(dbh),
      lookupStmt: dbh.prepare(LOOKUP_SQL),
      countStmt: dbh.prepare(COUNT_SQL),
    };
  } catch (err) {
    try { dbh.close(); } catch { /* ignore */ }
    throw err;
  }
}

function activateDictionary(d) {
  const oldDb = db;
  db = d.dbh;
  jieba = d.jieba;
  splitWords = d.splitWords;
  pinyinPrio = d.pinyinPrio;
  lookupStmt = d.lookupStmt;
  countStmt = d.countStmt;
  if (oldDb) {
    try { oldDb.close(); } catch (err) { console.error(`[cidict] gagal tutup DB lama: ${err.message}`); }
  }
}

// true = reload sukses (sudah aktif), false = gagal (tetap pakai yang lama).
function tryReloadDictionary(sig) {
  try {
    const d = openDictionary();
    activateDictionary(d);
    activeManifestVer = manifestVer; // sinkron dengan dbSignal: tak bisa berubah di tengah
    console.log(`[cidict] database reload ok (signal=${sig}, entries=${d.count})`);
    return true;
  } catch (err) {
    console.error(`[cidict] database reload GAGAL, tetap pakai yang lama (${err.message})`);
    return false;
  }
}

// Dipanggil tiap request sebelum cek versi cache. Gagal reload -> backoff
// 30 detik agar DB bermasalah tidak membebani tiap request.
function ensureCurrentDictionary() {
  const sig = dbSignal();
  if (sig === activeDbSignal) return;
  const now = Date.now();
  if (now < reloadCooldownUntil) return;
  if (tryReloadDictionary(sig)) {
    activeDbSignal = sig;
  } else {
    reloadCooldownUntil = now + 30000;
  }
}

function buildJieba(dbh = db) {
  const splitWords = loadSplitWords();
  const rows = dbh
    .prepare(
      `SELECT simplified, traditional, COALESCE(frequency, 0) AS f
       FROM entries
       WHERE status = 'active' AND merged_into IS NULL`
    )
    .all();

  // Perluas daftar force-split dengan padanan tradisional/simplified dari DB.
  const splitExpanded = new Set(splitWords);
  for (const r of rows) {
    if (splitWords.has(r.simplified) || splitWords.has(r.traditional)) {
      splitExpanded.add(r.simplified);
      splitExpanded.add(r.traditional);
    }
  }

  const freqs = new Map();
  for (const r of rows) {
    const simp = r.simplified;
    const trad = r.traditional;
    if (!simp || !simp.trim()) continue;
    const freq = Math.max(Math.max(0, r.f | 0), MIN_FREQ);
    for (const w of [simp, trad]) {
      if (!w || !w.trim() || splitExpanded.has(w)) continue;
      freqs.set(w, Math.max(freqs.get(w) ?? 0, freq));
    }
  }

  // Demote: override tetap di leksikon dengan frekuensi sangat kecil.
  for (const w of splitExpanded) {
    if (w && w.trim()) freqs.set(w, DEMOTE_FREQ);
  }

  const dictText = [...freqs].map(([w, f]) => `${w}\t${f}`).join('\n');
  const jieba = Jieba.withDict(Buffer.from(dictText, 'utf8'));

  console.log(
    `[cidict] jieba lexicon ready: ${freqs.size} headwords ` +
      `(min_freq=${MIN_FREQ}, split_demoted=${JSON.stringify([...splitExpanded])})`
  );
  return { jieba, splitWords: [...splitExpanded] };
}

// Startup: DB harus valid, gagal -> crash (fail fast, seperti sebelumnya).
dbSignal(); // baca manifest/mtime awal
{
  const d = openDictionary();
  db = d.dbh;
  jieba = d.jieba;
  splitWords = d.splitWords;
  pinyinPrio = d.pinyinPrio;
  lookupStmt = d.lookupStmt;
  countStmt = d.countStmt;
  activeManifestVer = manifestVer;
  activeDbSignal = dbSignal();
  console.log(`[cidict] dictionary ready: ${d.count} entries (signal=${activeDbSignal})`);
}

// ---------- lookup ----------

// Lookup per surface form, dikelompokkan per bacaan pinyin.
function lookupWord(word) {
  const senses = [];
  let lastKey = null;
  for (const r of lookupStmt.all(word, word)) {
    const key = `${r.pinyin_marks}${r.trad}${r.simp}`;
    if (key === lastKey) {
      senses[senses.length - 1].defs.push(r.def);
    } else {
      senses.push({
        trad: r.trad,
        simp: r.simp,
        pinyin: r.pinyin,
        pinyin_marks: r.pinyin_marks,
        pinyin_toneless: r.pinyin_toneless,
        frequency: r.frequency,
        defs: [r.def],
      });
      lastKey = key;
    }
  }
  // Urutan bacaan: skor tunggal (port score_variant() plugin WP).
  return sortReadings(senses, pinyinPrio.get(word));
}

// Tradisional dash-encoded: karakter yang sama dengan simplified -> "-".
// "看书"/"看書" -> "-書"; null bila identik.
function tradDash(simp, trad) {
  const s = [...(simp || '')];
  const t = [...(trad || simp || '')];
  const n = Math.max(s.length, t.length);
  let out = '';
  let allDash = true;
  for (let i = 0; i < n; i++) {
    if (t[i] === undefined) continue;
    if (t[i] === s[i]) out += '-';
    else {
      out += t[i];
      allDash = false;
    }
  }
  return allDash ? null : out;
}

// Bentuk ringkas API: { r: [{ y, d }], t }; null bila tak ada di kamus.
function lookupCompact(word) {
  const senses = lookupWord(word);
  if (!senses.length) return null;
  return {
    r: senses.map((s) => ({ y: normalizePinyin(s.pinyin_marks || s.pinyin), d: s.defs })),
    t: tradDash(senses[0].simp, senses[0].trad),
  };
}

// ---------- cache hasil annotate ----------
// Dua tier: (1) memori (Map LRU) untuk kecepatan, (2) SQLite persisten agar
// survive restart. Kunci = sha1(teks); purge saat versi data berubah
// (mtime DB kamus / seg-reload). Kontrak API tidak berubah.
const CACHE_MAX = Math.max(0, Number.parseInt(env('CIDICT_CACHE_SIZE', '1000'), 10) || 0);
const annotateCache = new Map(); // sha1(teks) -> { tokens, defs }
let cacheStamp = null;           // versi data yang terlihat cache saat ini
let cacheEpoch = 0;              // naik tiap POST /api/seg-reload

// Versi untuk cache + client: berubah -> purge + (bila dari DB) reload.
function dataVersion() {
  return dbSignal() + ':' + cacheEpoch;
}

// ----- tier 2: cache disk (SQLite) -----
// Path relatif dihitung dari direktori project (bukan cwd), sama seperti
// CIDICT_DB. Kosongkan CIDICT_CACHE_FILE untuk mematikan tier ini.
const DISK_MAX = Math.max(0, Number.parseInt(env('CIDICT_CACHE_DISK_SIZE', '10000'), 10) || 0);
const CACHE_FILE = env('CIDICT_CACHE_FILE', path.join('data', 'annotate-cache.db'));
let diskDb = null;
let diskWarned = false;
let stDiskGet, stDiskSet, stDiskPurge, stDiskPrune, stDiskCount, stMetaGet, stMetaSet;

function diskWarn(msg) {
  if (!diskWarned) {
    diskWarned = true;
    console.error(`[cidict] peringatan: cache disk nonaktif (${msg})`);
  }
}

function diskInit() {
  if (!CACHE_FILE || CACHE_MAX <= 0 || DISK_MAX <= 0) return;
  try {
    const file = path.resolve(__dirname, CACHE_FILE);
    // Buat parent dir satu level saja, non-rekursif: mkdir rekursif bisa
    // hang pada path abnormal (mis. di bawah /proc) dan hang tak bisa
    // di-catch. Untuk path kustom yang lebih dalam, buat manual dulu.
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    diskDb = new DatabaseSync(file);
    diskDb.exec('PRAGMA journal_mode = WAL');
    diskDb.exec(
      'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);'
    );
    stDiskGet = diskDb.prepare('SELECT value FROM cache WHERE key = ?');
    stDiskSet = diskDb.prepare('INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)');
    stDiskPurge = diskDb.prepare('DELETE FROM cache');
    stDiskPrune = diskDb.prepare('DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY updated_at ASC LIMIT ?)');
    stDiskCount = diskDb.prepare('SELECT COUNT(*) AS n FROM cache');
    stMetaGet = diskDb.prepare('SELECT v FROM meta WHERE k = ?');
    stMetaSet = diskDb.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
    // Entri dari run sebelumnya hanya valid bila versi datanya sama.
    const ver = dataVersion();
    if (stMetaGet.get('ver')?.v !== ver) {
      stDiskPurge.run();
      stMetaSet.run('ver', ver);
    }
  } catch (err) {
    diskWarn(err.message);
    diskDb = null;
  }
}

// LRU tier disk disederhanakan: recency hanya di-refresh saat insert
// (tier memori sudah menangani recency saat read).
function diskGet(key) {
  if (!diskDb) return null;
  try {
    const row = stDiskGet.get(key);
    return row ? JSON.parse(row.value) : null;
  } catch (err) {
    diskWarn(err.message);
    return null;
  }
}

function diskSet(key, out) {
  if (!diskDb) return;
  // Async agar tidak menambah latensi respons; hanya cache, jadi
  // kehilangan tulis saat crash tidak masalah (jatuh jadi MISS).
  setImmediate(() => {
    try {
      stDiskSet.run(key, JSON.stringify(out), Date.now());
      const over = stDiskCount.get().n - DISK_MAX;
      if (over > 0) stDiskPrune.run(over);
    } catch (err) {
      diskWarn(err.message);
    }
  });
}

function diskPurge(ver) {
  if (!diskDb) return;
  try {
    stDiskPurge.run();
    stMetaSet.run('ver', ver);
  } catch (err) {
    diskWarn(err.message);
  }
}

diskInit();
// Tandai versi awal agar request pertama tidak salah dianggap "versi
// berubah" (yang akan mem-purge cache disk warisan run sebelumnya).
// Perubahan versi saat runtime tetap terdeteksi via dataVersion().
cacheStamp = dataVersion();

const HANZI_RE = /[一-鿿]/;

// Segmentasi + lookup satu teks. tokens = token ber-hanzi saja.
function buildAnnotate(clipped) {
  const cut = jieba.cut(clipped, HMM);
  const defs = {};
  for (const s of new Set(cut)) {
    const e = lookupCompact(s);
    if (e) defs[s] = e;
  }
  const tokens = cut.filter((s) => HANZI_RE.test(s) || defs[s]);
  return { tokens, defs };
}

// ---------- app ----------

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS permisif agar API bisa dipakai dari web/app lain.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
// Client hasil build; no-cache agar update langsung terlihat.
app.use('/static', express.static(path.join(__dirname, 'dist'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

app.get('/api/health', (req, res) => {
  ensureCurrentDictionary(); // verifikasi update DB ikut terpicu dari sini
  let entries = -1;
  try {
    entries = countStmt.get().n;
  } catch {
    /* ignore */
  }
  res.json({ ok: true, version: VERSION, db_version: activeManifestVer, entries, hmm: HMM, split_words: splitWords });
});

app.post('/api/annotate', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') return res.sendStatus(400);
  const clipped = [...text].slice(0, MAX_CHARS).join('');
  ensureCurrentDictionary(); // hot reload bila DB diganti
  const ver = dataVersion();
  if (ver !== cacheStamp) {
    annotateCache.clear();
    diskPurge(ver);
    cacheStamp = ver;
  }
  let out = null;
  let tier = 'miss';
  if (CACHE_MAX > 0) {
    const key = createHash('sha1').update(clipped).digest('hex');
    out = annotateCache.get(key) || null;
    if (out) {
      tier = 'memory';
      // Segarkan resensi (LRU sederhana).
      annotateCache.delete(key);
      annotateCache.set(key, out);
    } else if ((out = diskGet(key))) {
      tier = 'disk';
      // Promote ke memori agar hit berikutnya lebih cepat.
      if (annotateCache.size >= CACHE_MAX) annotateCache.delete(annotateCache.keys().next().value);
      annotateCache.set(key, out);
    } else {
      out = buildAnnotate(clipped);
      if (annotateCache.size >= CACHE_MAX) annotateCache.delete(annotateCache.keys().next().value);
      annotateCache.set(key, out);
      diskSet(key, out);
    }
  } else {
    out = buildAnnotate(clipped);
  }
  res.setHeader('X-Cache', tier === 'miss' ? 'MISS' : 'HIT');
  res.setHeader('X-Cache-Tier', tier);
  res.json({ tokens: out.tokens, defs: out.defs, v: ver });
});

app.get('/api/lookup', (req, res) => {
  ensureCurrentDictionary();
  const word = typeof req.query.text === 'string' ? req.query.text : '';
  res.json({ word, def: lookupCompact(word) });
});

// Muat ulang file konfigurasi + bangun ulang leksikon tanpa restart.
// Proteksi: koneksi TCP langsung dari localhost bebas token; dari luar
// wajib token (header `Authorization: Bearer <token>` atau query `?token=`).
// Request via reverse proxy selalu membawa X-Forwarded-For sehingga tidak
// lolos sebagai localhost. Tanpa CIDICT_RELOAD_TOKEN, non-localhost = 403.
const RELOAD_TOKEN = env('CIDICT_RELOAD_TOKEN', '');

function isDirectLocalhost(req) {
  const addr = req.socket && req.socket.remoteAddress;
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return !!loopback && !req.headers['x-forwarded-for'];
}

function reloadAuthorized(req) {
  if (isDirectLocalhost(req)) return true;
  if (!RELOAD_TOKEN) return false;
  const h = req.get('authorization') || '';
  const q = req.query && typeof req.query.token === 'string' ? req.query.token : '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : q;
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(RELOAD_TOKEN, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post('/api/seg-reload', (req, res) => {
  if (!reloadAuthorized(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const built = buildJieba();
    jieba = built.jieba;
    splitWords = built.splitWords;
    pinyinPrio = loadPinyinPriority();
    cacheEpoch++;
    annotateCache.clear();
    diskPurge(dataVersion());
    res.json({ ok: true, split_words: splitWords, pinyin_priority: [...pinyinPrio.keys()] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[cidict] listening on http://0.0.0.0:${PORT} (db=${DB_PATH}, hmm=${HMM})`);
});
