/* CC-CIDICT annotator client v2 — single file (CSS di-inject dari JS).
 *
 * Integrasi (satu script saja):
 *   <script src="//api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
 *   <script>cidict.annotate('.artikel', { theme: 'light' });</script>
 *
 * - Pinyin inline via <ruby>/<rt> bawaan browser (bisa dimatikan).
 * - Toggle Simplified <-> Traditional instan via atribut data-trad.
 * - Popup definisi: hover instan di desktop, tap-toggle di touch.
 * - Theme popup: 'light' (default) | 'dark'.
 * - Preferensi (showInline, showPopups, theme, trad) tersimpan otomatis
 *   di localStorage dan dipulihkan saat script di-load.
 * - Response API ringan: `tokens` hanya berisi token ber-hanzi.
 * - Teks panjang dipecah jadi chunk dan di-fetch paralel (chunkSize,
 *   maxConcurrency); ada indikator loading (opsi `loading`).
 * - Tanpa dependensi. Alias kompatibel: window.CidictAnnotator.
 */
(function (global) {
  'use strict';

  var VERSION = '2.3.1';

  var defaults = {
    apiBase: null,      // null = origin dari script ini (atau '' = origin halaman)
    theme: 'light',     // 'light' | 'dark'  (theme popup)
    showPopups: true,   // popup definisi saat hover/tap
    showInline: true,   // pinyin inline di atas hanzi
    chunkSize: 2000,    // pecah teks panjang per N karakter (0 = nonaktif)
    maxConcurrency: 3,  // fetch paralel maks per annotate
    loading: null,      // selector | { target, show } — indikator loading
  };
  var opts = {};
  configure(defaults);

  // ---------- preferensi (localStorage) ----------
  // showInline, showPopups, theme, dan trad disimpan otomatis setiap berubah
  // dan dipulihkan saat script di-load. Opsi eksplisit di annotate() tetap
  // menang atas nilai tersimpan.

  var useTrad = false; // tampilkan hanzi tradisional
  var PREF_KEY = 'cidict_prefs';

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        showInline: !!opts.showInline,
        showPopups: !!opts.showPopups,
        theme: opts.theme,
        trad: useTrad
      }));
    } catch (e) { /* abaikan (mode privat, dsb) */ }
  }

  function loadPrefs() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) {}
    if (!p || typeof p !== 'object') return;
    if (typeof p.showInline === 'boolean') opts.showInline = p.showInline;
    if (typeof p.showPopups === 'boolean') opts.showPopups = p.showPopups;
    if (p.theme === 'dark' || p.theme === 'light') opts.theme = p.theme;
    if (typeof p.trad === 'boolean') useTrad = p.trad;
  }

  loadPrefs();

  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  var dictCache = {};          // akumulasi { surface: { r:[{y,d}], t } }
  var trackedRoots = new Set(); // elemen yang pernah di-annotate

  function defaultApiBase() {
    try {
      var s = document.currentScript;
      if (s && s.src) return new URL(s.src).origin;
    } catch (e) { /* abaikan */ }
    return '';
  }

  function configure(o) {
    if (!o) return;
    var hadLoadingOpt = Object.prototype.hasOwnProperty.call(o, 'loading');
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined) opts[k] = o[k];
    }
    if (opts.apiBase === null) opts.apiBase = defaultApiBase();
    if (hadLoadingOpt && !o.loading) releaseAutoHidden();
    if (opts.loading) applyLoadingInitial();
  }

  function api(path, init) {
    return fetch(opts.apiBase + path, init).then(function (r) {
      if (!r.ok) throw new Error('CC-CIDICT API error: HTTP ' + r.status);
      return r.json();
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // ---------- CSS (di-inject sekali) ----------

  var CSS = [
    'ruby.cidict-rb{ruby-align:center;border-radius:2px;margin:0 .12ex}',
    'ruby.cidict-rb>rt{font-size:.68em;line-height:1.15;opacity:.78;user-select:none;-webkit-user-select:none}',
    '.cidict-no-inline ruby.cidict-rb>rt{display:none}',
    'ruby.cidict-rb.cidict-hl{background:rgba(255,196,0,.35)}',
    '#cidict-popup{position:fixed;z-index:1000000;visibility:hidden;max-width:300px;background:#fff;border:1px solid #ccc;border-radius:8px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,.15);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;color:#222;text-align:left}',
    '#cidict-popup .cidict-head{font-size:19px;text-align:center;margin-bottom:8px;border-bottom:2px solid #eee;padding-bottom:6px}',
    '#cidict-popup .cidict-trad{font-size:.78em;color:#888}',
    '#cidict-popup .cidict-reading{margin-bottom:7px}',
    '#cidict-popup .cidict-reading:last-of-type{margin-bottom:4px}',
    '#cidict-popup .cidict-pinyin{color:#1950d1;font-size:15px;font-weight:600;margin-bottom:4px}',
    '#cidict-popup .cidict-defs{margin:0;padding-left:1.3em;color:#444}',
    '#cidict-popup .cidict-defs li{margin-bottom:2px}',
    '#cidict-popup .cidict-credit{font-size:10px;color:#999;text-align:center;margin-top:6px}',
    '#cidict-popup[data-cidict-theme="dark"]{background:#2d2d2d;border-color:#555;color:#eee}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-head{border-bottom-color:#555}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-trad{color:#aaa}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-pinyin{color:#7aa5ff}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-defs{color:#ddd}'
  ].join('\n');

  function ensureStyle() {
    if (!document.getElementById('cidict-style')) {
      var st = document.createElement('style');
      st.id = 'cidict-style';
      st.type = 'text/css';
      st.appendChild(document.createTextNode(CSS));
      document.head.appendChild(st);
    }
    // Selaraskan dengan preferensi showInline (termasuk hasil loadPrefs).
    document.documentElement.classList.toggle('cidict-no-inline', !opts.showInline);
  }

  // ---------- popup (satu div bersama) ----------

  var popupEl = null;
  var popupFor = null; // ruby yang sedang ditampilkan popup-nya

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'cidict-popup';
    popupEl.dataset.cidictTheme = opts.theme;
    popupEl.style.left = '-1000px';
    popupEl.style.top = '-1000px';
    popupEl.addEventListener('mouseleave', hidePopup);
    document.body.appendChild(popupEl);
    return popupEl;
  }

  function buildPopupContent(word, entry) {
    var frag = document.createDocumentFragment();
    var head = el('div', 'cidict-head');
    head.appendChild(document.createTextNode(word));
    if (entry.t) head.appendChild(el('span', 'cidict-trad', ' [' + entry.t + ']'));
    frag.appendChild(head);
    (entry.r || []).forEach(function (rd) {
      var block = el('div', 'cidict-reading');
      block.appendChild(el('div', 'cidict-pinyin', rd.y || ''));
      var ul = el('ul', 'cidict-defs');
      (rd.d || []).forEach(function (d) {
        var li = document.createElement('li');
        li.textContent = d;
        ul.appendChild(li);
      });
      block.appendChild(ul);
      frag.appendChild(block);
    });
    frag.appendChild(el('div', 'cidict-credit', 'cidict.org'));
    return frag;
  }

  // Posisi: di bawah kata; flip ke atas bila tidak muat; clamp horizontal.
  // getClientRects()[0] menangani kata yang wrap ke beberapa baris.
  function placePopup(popup, anchor) {
    var rects = anchor.getClientRects();
    var rc = rects.length > 1 ? rects[0] : anchor.getBoundingClientRect();
    var maxW = isTouch ? 240 : 300;
    popup.style.width = '';
    if (popup.offsetWidth > maxW) popup.style.width = maxW + 'px';
    var pw = popup.offsetWidth, ph = popup.offsetHeight;
    var x = rc.left + rc.width / 2 - pw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    var y = rc.bottom + 6;
    if (y + ph > window.innerHeight - 8) y = rc.top - ph - 6;
    if (y < 8) y = 8;
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  }

  function openPopup(ruby) {
    if (!opts.showPopups) return;
    var word = ruby.getAttribute('data-w');
    var entry = dictCache[word];
    if (!entry) return;
    var popup = ensurePopup();
    popup.dataset.cidictTheme = opts.theme;
    popup.innerHTML = '';
    popup.appendChild(buildPopupContent(word, entry));
    popup.style.visibility = 'hidden'; // ukur dulu sebelum tampil
    placePopup(popup, ruby);
    popup.style.visibility = 'visible';
    if (popupFor && popupFor !== ruby) popupFor.classList.remove('cidict-hl');
    popupFor = ruby;
    ruby.classList.add('cidict-hl');
  }

  function hidePopup() {
    if (popupEl) {
      popupEl.style.visibility = 'hidden';
      popupEl.style.left = '-1000px';
      popupEl.style.top = '-1000px';
    }
    if (popupFor) {
      popupFor.classList.remove('cidict-hl');
      popupFor = null;
    }
  }

  // ---------- render ----------

  var HANZI_RE = /[一-鿿]/;

  // Decode "t" dash-encoded dari API ("-" = sama dengan simplified)
  // menjadi bentuk tradisional penuh.
  function expandTrad(simp, dash) {
    if (!dash) return simp;
    var s = Array.from(simp), d = Array.from(dash);
    var n = Math.max(s.length, d.length), out = '';
    for (var i = 0; i < n; i++) {
      if (d[i] === undefined) { out += s[i] || ''; continue; }
      out += d[i] === '-' ? (s[i] || '') : d[i];
    }
    return out;
  }

  // Terapkan pilihan simplified/traditional ke semua ruby yang sudah dirender.
  function applyTrad() {
    Array.prototype.forEach.call(document.querySelectorAll('ruby.cidict-rb'), function (rb) {
      var w = rb.getAttribute('data-w');
      var txt = useTrad ? (rb.getAttribute('data-trad') || w) : w;
      if (rb.firstChild) rb.firstChild.nodeValue = txt;
    });
  }

  function renderRuby(s, entry) {
    var frag = document.createDocumentFragment();
    if (!entry || !entry.r || !entry.r.length) {
      frag.appendChild(document.createTextNode(s)); // OOV: plain
      return frag;
    }
    var wbr = document.createElement('wbr');
    wbr.className = 'cidict-wbr';
    frag.appendChild(wbr);
    var ruby = document.createElement('ruby');
    ruby.className = 'cidict-rb';
    ruby.setAttribute('data-w', s);
    var trad = entry.t ? expandTrad(s, entry.t) : s;
    if (trad !== s) ruby.setAttribute('data-trad', trad);
    ruby.setAttribute('tabindex', '0');
    ruby.appendChild(document.createTextNode(useTrad ? trad : s));
    var rt = document.createElement('rt');
    rt.textContent = entry.r[0].y || '';
    ruby.appendChild(rt);
    frag.appendChild(ruby);
    return frag;
  }

  // tokens dari API hanya berisi token ber-hanzi (urutan sesuai segmentasi).
  // Teks non-token (tanda baca/spasi) dirender plain via cursor sederhana:
  // setiap karakter hanzi pasti diawali token berikutnya dalam urutan.
  function renderChunk(text, tokens, defs) {
    var frag = document.createDocumentFragment();
    var ti = 0, i = 0, buf = '';
    function flush() {
      if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
    }
    while (i < text.length) {
      var tok = ti < tokens.length ? tokens[ti] : null;
      if (tok && text.startsWith(tok, i)) {
        flush();
        frag.appendChild(renderRuby(tok, defs[tok]));
        i += tok.length;
        ti++;
      } else {
        buf += text[i];
        i++;
      }
    }
    flush();
    return frag;
  }

  // Kumpulkan text node ber-CJK; struktur DOM (p, b, dll) tetap utuh.
  function collectTextNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var v = node.nodeValue;
        if (!v || !/[一-鿿]/.test(v)) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        while (p && p !== root) {
          var tn = p.tagName;
          if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
          if (p.id === 'cidict-popup') return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains('cidict-rb')) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function annotateNode(node) {
    return annotateData(node.nodeValue).then(function (data) {
      var frag = document.createDocumentFragment();
      data.parts.forEach(function (p) {
        frag.appendChild(renderChunk(p.text, p.tokens, data.defs));
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ---------- chunking + fetch paralel ----------

  // Pecah teks panjang jadi potongan ≤ size karakter (code point),
  // diutamakan pada batas baris lalu tanda baca akhir kalimat.
  function splitChunks(text, size) {
    size = size | 0;
    if (size <= 0) return [text];
    var chars = Array.from(text);
    if (chars.length <= size) return [text];
    var chunks = [];
    var start = 0;
    while (start < chars.length) {
      var end = Math.min(start + size, chars.length);
      if (end < chars.length) {
        var cut = -1, i, c;
        for (i = end; i > start + (size >> 1); i--) {
          if (chars[i] === '\n') { cut = i + 1; break; }
        }
        if (cut < 0) {
          for (i = end; i > start + (size >> 1); i--) {
            c = chars[i];
            if (c === '。' || c === '！' || c === '？' || c === '；' || c === '…') { cut = i + 1; break; }
          }
        }
        if (cut > 0) end = cut;
      }
      chunks.push(chars.slice(start, end).join(''));
      start = end;
    }
    return chunks;
  }

  // Jalankan fn untuk tiap item dengan maks `maxConc` promise bersamaan.
  // Gagal satu → seluruh batch gagal (fail-fast, seperti 1 request besar).
  function runParallel(items, fn, maxConc) {
    maxConc = Math.max(1, maxConc | 0 || 3);
    return new Promise(function (resolve, reject) {
      var results = new Array(items.length);
      var nextIdx = 0, active = 0, done = false;
      function pump() {
        if (done) return;
        if (nextIdx >= items.length && active === 0) { done = true; resolve(results); return; }
        while (active < maxConc && nextIdx < items.length) {
          (function (k) {
            active++;
            fn(items[k]).then(function (r) {
              results[k] = r;
              active--;
              pump();
            }, function (err) { done = true; reject(err); });
          })(nextIdx++);
        }
      }
      pump();
    });
  }

  function postAnnotate(text) {
    return api('/api/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (res) {
      Object.assign(dictCache, res.defs || {});
      return { tokens: res.tokens || [], defs: res.defs || {}, v: res.v || null };
    });
  }

  // Cache client per chunk, dikunci versi data server (`v`): saat versi
  // berubah (DB diganti / seg-reload), entri lama otomatis tak dipakai.
  var textCache = new Map();
  var knownVer = null;
  var TEXT_CACHE_MAX = 200;

  function annotateData(text) {
    var chunks = splitChunks(text, opts.chunkSize);
    var results = new Array(chunks.length);
    var missing = [], missingIdx = [];
    chunks.forEach(function (ch, i) {
      var hit = textCache.get(ch);
      if (hit && hit.v === knownVer) results[i] = hit.data;
      else { missing.push(ch); missingIdx.push(i); }
    });
    function finish() {
      var tokens = [], defs = {}, parts = [];
      chunks.forEach(function (ch, i) {
        var r = results[i];
        parts.push({ text: ch, tokens: r.tokens || [] });
        (r.tokens || []).forEach(function (t) { tokens.push(t); });
        var d = r.defs || {};
        for (var k in d) defs[k] = d[k];
      });
      return { tokens: tokens, defs: defs, parts: parts };
    }
    if (!missing.length) return Promise.resolve(finish());
    return runParallel(missing, postAnnotate, opts.maxConcurrency).then(function (resps) {
      resps.forEach(function (r, j) {
        if (r.v && knownVer && r.v !== knownVer) textCache.clear(); // versi berubah: purge
        if (r.v) knownVer = r.v;
        results[missingIdx[j]] = r;
        if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
        textCache.set(missing[j], { v: r.v, data: r });
      });
      return finish();
    });
  }

  // ---------- indikator loading ----------

  var loadingDepth = 0;
  var autoHiddenElm = null;

  // Sembunyikan indikator saat idle, tanpa merusak styling eksplisit milik
  // user: hanya bila belum ada inline display. Ditandai agar bisa
  // dipulihkan bila opsi loading dicabut.
  function applyLoadingInitial() {
    var t = resolveLoadingTarget();
    if (!t) return;
    var elm = t.elm;
    if (!elm.style.display && !elm.hasAttribute('data-cidict-auto-hide')) {
      elm.style.display = 'none';
      elm.setAttribute('data-cidict-auto-hide', '1');
      autoHiddenElm = elm;
    }
  }

  function releaseAutoHidden() {
    var elm = autoHiddenElm;
    autoHiddenElm = null;
    if (!elm || !elm.hasAttribute('data-cidict-auto-hide')) return;
    elm.removeAttribute('data-cidict-auto-hide');
    if (elm.style.display === 'none') elm.style.display = '';
  }

  function resolveLoadingTarget() {
    var l = opts.loading;
    if (!l) return null;
    var target = (typeof l === 'string') ? l : l.target;
    var show = (l && typeof l === 'object' && l.show) || 'block';
    if (!target) return null;
    var elm = (typeof target === 'string') ? document.querySelector(target) : target;
    return elm ? { elm: elm, show: show } : null;
  }

  function loadingBegin() {
    loadingDepth++;
    if (loadingDepth !== 1) return;
    applyLoadingInitial(); // amankan elemen yang baru muncul di DOM
    var t = resolveLoadingTarget();
    if (!t) return;
    if (t.elm.getAttribute('data-cidict-orig-display') === null) {
      t.elm.setAttribute('data-cidict-orig-display', t.elm.style.display || '');
    }
    t.elm.style.display = t.show;
    t.elm.classList.add('cidict-loading');
  }

  function loadingEnd() {
    if (loadingDepth > 0) loadingDepth--;
    if (loadingDepth !== 0) return;
    var t = resolveLoadingTarget();
    if (!t) return;
    var orig = t.elm.getAttribute('data-cidict-orig-display');
    t.elm.style.display = (orig === null) ? 'none' : orig;
    t.elm.removeAttribute('data-cidict-orig-display');
    t.elm.classList.remove('cidict-loading');
  }

  function resolveElements(selector) {
    if (selector === undefined || selector === null) return [document.body];
    if (typeof selector === 'string') {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    }
    if (selector.nodeType) return [selector];
    return Array.prototype.slice.call(selector);
  }

  // ---------- interaksi: hover (desktop) / tap (touch) / keyboard ----------

  var listenersAttached = false;

  function closestRuby(t) {
    return t && t.closest ? t.closest('ruby.cidict-rb') : null;
  }

  function onMouseOver(e) {
    // Instant (tanpa delay): hover langsung membuka popup.
    // Di mobile, tap menghasilkan synthetic mouseover → popup terbuka.
    // (Sengaja tidak di-gate isTouch agar laptop touchscreen tetap dapat hover.)
    if (!opts.showPopups) return;
    var ruby = closestRuby(e.target);
    if (!ruby || ruby === popupFor) return;
    openPopup(ruby);
  }

  function onMouseOut(e) {
    var ruby = closestRuby(e.target);
    if (!ruby || ruby !== popupFor) return;
    var to = e.relatedTarget;
    // Popup langsung disembunyikan begitu pointer keluar dari ruby,
    // termasuk saat pindah ke area popup — popup tidak boleh
    // menghalangi hanzi di belakangnya.
    if (to && ruby.contains(to)) return;
    hidePopup();
  }

  function onClick(e) {
    var ruby = closestRuby(e.target);
    if (ruby) {
      if (!opts.showPopups) return;
      // Toggle: klik pada ruby yang sedang tampil = tutup;
      // klik pada ruby lain = buka langsung (tanpa delay).
      // Di mobile, tap = synthetic mouseover (buka) + click; kedua
      // jalur ini konsisten karena popupFor sudah ter-set.
      if (popupFor === ruby) hidePopup();
      else openPopup(ruby);
      return;
    }
    if (popupEl && popupEl.style.visibility === 'visible' &&
        !popupEl.contains(e.target)) hidePopup();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { hidePopup(); return; }
    var ruby = closestRuby(e.target);
    if (ruby && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (popupFor === ruby) hidePopup(); else openPopup(ruby);
    }
  }

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown);
  }

  function detachListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener('mouseover', onMouseOver);
    document.removeEventListener('mouseout', onMouseOut);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown);
  }

  // ---------- API publik ----------

  var cidict = {
    version: VERSION,

    configure: function (o) { configure(o); return this; },

    supported: function () { return !!window.fetch; },

    health: function () { return api('/api/health'); },

    lookup: function (word) {
      return api('/api/lookup?text=' + encodeURIComponent(word));
    },

    // Annotate elemen: { theme, showInline, showPopups, apiBase,
    //   chunkSize, maxConcurrency, loading }
    annotate: function (selector, options) {
      if (options) configure(options);
      ensureStyle();
      ensurePopup();
      attachListeners();
      loadingBegin();
      var jobs = [];
      resolveElements(selector).forEach(function (elm) {
        if (!elm || elm.nodeType !== 1) return;
        trackedRoots.add(elm);
        collectTextNodes(elm).forEach(function (node) { jobs.push(annotateNode(node)); });
      });
      return Promise.all(jobs).then(function (r) { loadingEnd(); return r; },
        function (e) { loadingEnd(); throw e; });
    },

    // Sama seperti annotate, tapi mengembalikan string HTML (tanpa inject).
    annotateText: function (text, options) {
      if (options) configure(options);
      ensureStyle();
      attachListeners();
      loadingBegin();
      return annotateData(text).then(function (data) {
        var div = document.createElement('div');
        data.parts.forEach(function (p) {
          div.appendChild(renderChunk(p.text, p.tokens, data.defs));
        });
        loadingEnd();
        return div.innerHTML;
      }, function (e) { loadingEnd(); throw e; });
    },

    // Kompatibilitas API lama (v1): render langsung ke container.
    annotateElement: function (container, text, options) {
      var self = this;
      if (typeof container === 'string') container = document.querySelector(container);
      return self.annotateText(text, options).then(function (html) {
        container.innerHTML = html;
        trackedRoots.add(container);
        return html;
      });
    },

    unannotate: function (selector) {
      resolveElements(selector === undefined ? document.body : selector).forEach(function (elm) {
        if (!elm || elm.nodeType !== 1) return;
        Array.prototype.forEach.call(elm.querySelectorAll('ruby.cidict-rb'), function (rb) {
          rb.parentNode.replaceChild(
            document.createTextNode(rb.getAttribute('data-w') || ''), rb);
        });
        Array.prototype.forEach.call(elm.querySelectorAll('wbr.cidict-wbr'), function (w) {
          if (w.parentNode) w.parentNode.removeChild(w);
        });
      });
      hidePopup();
      return this;
    },

    showPopups: function (b) {
      opts.showPopups = !!b;
      if (!opts.showPopups) hidePopup();
      savePrefs();
      return this;
    },

    showInline: function (b) {
      opts.showInline = !!b;
      document.documentElement.classList.toggle('cidict-no-inline', !opts.showInline);
      savePrefs();
      return this;
    },

    // Toggle pinyin inline. Tanpa argumen = balik status;
    // dengan boolean = set eksplisit. Status awal dibaca dari
    // localStorage (via loadPrefs), jadi aman dipakai setelah reload.
    togglePinyin: function (state) {
      var next = (typeof state === 'boolean') ? state : !opts.showInline;
      return this.showInline(next);
    },

    theme: function (name) {
      if (name !== 'dark' && name !== 'light') return this;
      opts.theme = name;
      if (popupEl) popupEl.dataset.cidictTheme = name;
      savePrefs();
      return this;
    },

    // Toggle theme popup light <-> dark. Tanpa argumen = balik status;
    // dengan 'light'/'dark' = set eksplisit.
    toggleTheme: function (name) {
      var next = (name === 'dark' || name === 'light')
        ? name
        : (opts.theme === 'dark' ? 'light' : 'dark');
      return this.theme(next);
    },

    // Toggle Simplified <-> Traditional. Tanpa argumen = balik status;
    // dengan boolean = set eksplisit. Instan (tanpa request), karena
    // bentuk tradisional sudah di-render sebagai atribut data-trad.
    // Preferensi tersimpan otomatis di localStorage.
    toggleHanzi: function (state) {
      useTrad = (typeof state === 'boolean') ? state : !useTrad;
      applyTrad();
      savePrefs();
      return this;
    },

    destroy: function () {
      var self = this;
      trackedRoots.forEach(function (elm) { self.unannotate(elm); });
      trackedRoots.clear();
      document.documentElement.classList.remove('cidict-no-inline');
      detachListeners();
      hidePopup();
      if (popupEl && popupEl.parentNode) popupEl.parentNode.removeChild(popupEl);
      popupEl = null;
      var st = document.getElementById('cidict-style');
      if (st && st.parentNode) st.parentNode.removeChild(st);
      for (var k in dictCache) delete dictCache[k];
      textCache.clear();
      knownVer = null;
      loadingDepth = 0;
      return this;
    }
  };

  // CSS langsung di-inject saat script di-load (satu file, tanpa <link>).
  ensureStyle();

  global.cidict = cidict;
  global.CidictAnnotator = cidict; // alias kompatibel v1
})(window);
