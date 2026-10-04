/**
 * Normalisasi pinyin ala CC-CEDICT menjadi ortografi baku.
 *
 * DB (dan CC-CEDICT) menulis spasi antar SEMUA suku kata:
 *   "kě yǐ", "Běi jīng Dà xué", "píng ān", "Xī ān"
 * Hasil normalisasi:
 *   "kěyǐ", "Běijīng Dàxué", "píng'ān", "Xī'ān"
 *
 * Aturan:
 *  1. Default: spasi dihilangkan (suku kata digabung).
 *  2. Suku kata berawalan huruf KAPITAL (kecuali suku kata pertama)
 *     menandai awal kata baru → diberi spasi sebelumnya.
 *     (Konvensi CC-CEDICT: kata nama diri ditulis kapital per kata.)
 *  3. Suku kata berawalan a/o/e disambung dengan apostrof (') agar
 *     batas suku kata tidak ambigu: "píng'ān", bukan "píngān".
 */

export function isCapitalized(s) {
  const c = (s || '').charAt(0);
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

export function stripTones(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function joinApos(syls) {
  let out = syls[0] || '';
  for (let i = 1; i < syls.length; i++) {
    const s = syls[i];
    out += /^[aoe]/i.test(stripTones(s).charAt(0)) ? "'" + s : s;
  }
  return out;
}

const cache = new Map();

export function normalizePinyin(marks) {
  if (!marks) return marks;
  const hit = cache.get(marks);
  if (hit !== undefined) return hit;
  const syls = marks.trim().split(/\s+/);
  const groups = [[]];
  syls.forEach((s, i) => {
    if (i > 0 && isCapitalized(s)) groups.push([]);
    groups[groups.length - 1].push(s);
  });
  const out = groups.map(joinApos).join(' ');
  cache.set(marks, out);
  return out;
}

// lowercase, nada diakritik → huruf biasa, ü → v, buang angka nada/spasi/simbol.
export function normPinyin(s) {
  let t = (s || '').toLowerCase().replace(/[üǖǘǚǜ]/g, 'v');
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return t.replace(/[1-5\s\W_]+/gu, '');
}

// ---------- skor bacaan ----------

// Bobot — override manual tetap dominan mutlak.
const W_OVERRIDE_EXACT = 1000;
const W_OVERRIDE_NORM = 900;
const W_PARTICLE = 10;
const W_SURNANE = -10;
const W_CAPITAL = -4;
const W_ARCHAIC = -3;
const W_RARE = -1;
const W_LOWER = 1;
const SENSE_CAP = 6;

const RE_SURNANE = /\b(marga|nama keluarga)\b/i;
const RE_ARCHAIC = /(\bvarian lama\b|\bvarian tidak resmi\b|\(kuno\)|\(dialek\))/i;
const RE_RARE = /(\(sastra\)|\bvarian dari\b|\bkata serapan\b|\bdigunakan dalam\b|\bsingkatan dari\b)/i;
const RE_PARTICLE =
  /\b(partikel pertanyaan|partikel modal|partikel akhir|partikel di akhir|partikel aspek)\b/i;

function countSenses(defs) {
  const set = new Set();
  for (const d of defs || []) {
    for (const part of String(d).split(/[/;]+/)) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  return set.size;
}

/**
 * Skor satu bacaan; makin tinggi makin diprioritaskan.
 * `prio` = { raws:[...], norms:[...] } dari pinyin_priority.txt (atau null).
 * Dihitung SEKALI per bacaan.
 */
export function scoreReading(sense, prio) {
  const marks = sense.pinyin_marks || '';
  const defs = (sense.defs || []).join(' ‖ ');

  if (prio) {
    if (
      prio.raws.includes(marks) ||
      prio.raws.includes(sense.pinyin || '') ||
      prio.raws.includes(sense.pinyin_toneless || '')
    ) {
      return W_OVERRIDE_EXACT;
    }
    const nm = normPinyin(marks);
    if (nm && prio.norms.includes(nm)) return W_OVERRIDE_NORM;
  }

  let score = 0;
  if (isCapitalized(marks)) score += W_CAPITAL;
  else score += W_LOWER;
  if (RE_SURNANE.test(defs)) score += W_SURNANE;
  if (RE_ARCHAIC.test(defs)) score += W_ARCHAIC;
  if (RE_RARE.test(defs)) score += W_RARE;
  if (RE_PARTICLE.test(defs)) score += W_PARTICLE;
  score += Math.min(SENSE_CAP, countSenses(sense.defs));
  const f = sense.frequency | 0;
  if (f > 0) score += Math.log10(1 + f);
  return score;
}

/**
 * Urutkan bacaan per skor (tertinggi dulu); seri → pinyin_marks (deterministik).
 */
export function sortReadings(senses, prio) {
  const scored = senses.map((s) => [scoreReading(s, prio), s]);
  scored.sort(
    (a, b) =>
      b[0] - a[0] ||
      (a[1].pinyin_marks < b[1].pinyin_marks ? -1 : a[1].pinyin_marks > b[1].pinyin_marks ? 1 : 0)
  );
  return scored.map((x) => x[1]);
}
