/* CC-CIDICT annotator client v2 — single file (CSS di-inject dari JS).
 *
 * Integrasi (satu script saja):
 *   <script src="//api.cidict.org/static/cidict-annotator.min.js" charset="UTF-8"></script>
 *   <script>cidict.annotate('.artikel', { theme: 'light' });</script>
 *
 * - Pinyin inline via <ruby>/<rt> bawaan browser (bisa dimatikan).
 * - Toggle Simplified <-> Traditional instan via atribut data-trad.
 * - Popup definisi (client 2.4.0):
 *   displayMode 'popup' (default) | 'docked' | 'both' — hanya setter
 *   setDisplayMode(), tanpa toggle. Hanzi selalu bisa di-hover (desktop)
 *   dan di-klik/tap.
 *   - Hover (desktop): popup transien — 1 reading utama + maks 4 definisi;
 *     bila konten terpotong tampil notice "Klik hanzi untuk info lengkap".
 *     Popup langsung tertutup begitu pointer keluar dari hanzi.
 *   - Klik: mode 'popup' = popup terpin (semua reading, tombol x/copy,
 *     bisa scroll); mode 'docked' = panel dock tampil/update; mode 'both'
 *     = pinned-popup + dock bersamaan (desktop).
 *   - Mobile (matchMedia('(hover: none)')): tap = klik; mode 'both' tap
 *     menampilkan pinned-popup + icon pindah ke mode dock; selama dock
 *     aktif popup tidak tampil. Pindah mode via icon dua arah (popup <->
 *     dock), tersimpan di localStorage.
 *   - Dock: satu reading per tampilan (tombol ‹ ›), navigasi antar hanzi
 *     (tombol/ketuk <- ->), indikator hanzi aktif; fixed bottom di mobile,
 *     align kiri/kanan di desktop via dockAlign ('left'|'right').
 * - Theme popup/dock: 'light' (default) | 'dark'.
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

  var VERSION = '2.4.0';

  var defaults = {
    apiBase: null,      // null = origin dari script ini (atau '' = origin halaman)
    theme: 'light',     // 'light' | 'dark'  (theme popup & dock)
    showPopups: true,   // popup definisi saat hover/klik/tap
    showInline: true,   // pinyin inline di atas hanzi
    displayMode: 'popup', // 'popup' | 'docked' | 'both' (mode tampilan definisi)
    dockAlign: 'right',  // 'left' | 'right' (posisi dock di desktop; mobile selalu bottom)
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
        trad: useTrad,
        displayMode: opts.displayMode,
        dockAlign: opts.dockAlign
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
    if (p.displayMode === 'popup' || p.displayMode === 'docked' || p.displayMode === 'both')
      opts.displayMode = p.displayMode;
    if (p.dockAlign === 'left' || p.dockAlign === 'right') opts.dockAlign = p.dockAlign;
  }

  loadPrefs();

  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  // Deteksi "mobile" (tanpa hover) via matchMedia — lebih tepat daripada
  // isTouch, karena laptop touchscreen tetap melaporkan hover: hover.
  var noHover = isTouch;
  try {
    if (window.matchMedia) noHover = window.matchMedia('(hover: none)').matches;
  } catch (e) { /* pakai fallback isTouch */ }
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
    '#cidict-popup[data-popup-mode="hover"] .cidict-hover-body{max-height:190px;overflow:hidden}',
    '#cidict-popup[data-popup-mode="pinned"]{max-height:min(70vh,420px);display:flex;flex-direction:column}',
    '#cidict-popup[data-popup-mode="pinned"] .cidict-pinned-body{overflow-y:auto;overscroll-behavior:contain}',
    '#cidict-popup .cidict-actions{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}',
    '#cidict-popup .cidict-iconbtn{border:1px solid #ccc;background:#f7f7f7;border-radius:6px;padding:2px 9px;font-size:13px;line-height:1.6;cursor:pointer;color:#333;font-family:inherit}',
    '#cidict-popup .cidict-iconbtn:hover{background:#eee}',
    '#cidict-popup .cidict-notice{font-size:12px;color:#666;background:#f6f6f6;border:1px dashed #bbb;border-radius:6px;padding:6px 8px;margin:6px 0 2px;text-align:center}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-iconbtn{background:#3d3d3d;border-color:#666;color:#eee}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-iconbtn:hover{background:#4a4a4a}',
    '#cidict-popup[data-cidict-theme="dark"] .cidict-notice{background:#3a3a3a;border-color:#666;color:#ccc}',
    '#cidict-dock{position:fixed;z-index:1000000;background:#fff;border:1px solid #ccc;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;color:#222;text-align:left;display:none;max-height:70vh}',
    '#cidict-dock.open{display:flex;flex-direction:column}',
    '#cidict-dock.dock-bottom{left:8px;right:8px;bottom:8px;max-height:46vh}',
    '#cidict-dock.dock-left{top:12%;left:8px;width:300px;max-width:calc(100vw - 16px)}',
    '#cidict-dock.dock-right{top:12%;right:8px;width:300px;max-width:calc(100vw - 16px)}',
    '#cidict-dock .cidict-dock-head{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:2px solid #eee}',
    '#cidict-dock .cidict-dock-word{font-size:18px;font-weight:600;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#cidict-dock .cidict-dock-count{font-size:11px;color:#888;margin-right:2px;white-space:nowrap}',
    '#cidict-dock .cidict-dockbtn{border:1px solid #ccc;background:#f7f7f7;border-radius:6px;min-width:28px;padding:2px 6px;font-size:13px;cursor:pointer;color:#333;font-family:inherit}',
    '#cidict-dock .cidict-dockbtn:hover{background:#eee}',
    '#cidict-dock .cidict-dock-body{padding:10px 12px;overflow-y:auto;overscroll-behavior:contain}',
    '#cidict-dock .cidict-dock-body .cidict-pinyin{color:#1950d1;font-size:15px;font-weight:600;margin-bottom:4px}',
    '#cidict-dock .cidict-dock-body .cidict-defs{margin:0;padding-left:1.3em;color:#444}',
    '#cidict-dock .cidict-dock-body .cidict-defs li{margin-bottom:2px}',
    '#cidict-dock .cidict-credit{font-size:10px;color:#999;text-align:center;margin:4px 0 8px}',
    '#cidict-dock[data-cidict-theme="dark"]{background:#2d2d2d;border-color:#555;color:#eee}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dock-head{border-bottom-color:#555}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dock-count{color:#aaa}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dockbtn{background:#3d3d3d;border-color:#666;color:#eee}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dockbtn:hover{background:#4a4a4a}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dock-body .cidict-pinyin{color:#7aa5ff}',
    '#cidict-dock[data-cidict-theme="dark"] .cidict-dock-body .cidict-defs{color:#ddd}',
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

  // ---------- popup (satu div bersama) + dock ----------

  var popupEl = null;
  var popupFor = null;   // ruby yang sedang ditampilkan popup-nya
  var popupState = null; // null | 'hover' (transien) | 'pinned' (terpin)
  var dockEl = null;
  var dockActive = false; // dock sedang tampil
  var dockFor = null;     // ruby yang sedang ditampilkan di dock
  var dockReadingIdx = 0; // indeks reading yang tampil di dock

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'cidict-popup';
    popupEl.dataset.cidictTheme = opts.theme;
    popupEl.style.left = '-1000px';
    popupEl.style.top = '-1000px';
    // Aturan 2.3.1 (popup langsung hilang saat pointer keluar hanzi) hanya
    // berlaku untuk popup transien; popup terpin harus bisa di-klik.
    popupEl.addEventListener('mouseleave', function () {
      if (popupState === 'hover') hidePopup();
    });
    document.body.appendChild(popupEl);
    return popupEl;
  }

  // Highlight terpadu: popup dan dock bisa menunjuk hanzi yang sama/beda.
  function refreshHl() {
    Array.prototype.forEach.call(
      document.querySelectorAll('ruby.cidict-rb.cidict-hl'),
      function (rb) { rb.classList.remove('cidict-hl'); });
    if (popupFor) popupFor.classList.add('cidict-hl');
    if (dockActive && dockFor && dockFor !== popupFor) dockFor.classList.add('cidict-hl');
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

  // Konten popup hover: 1 reading utama + maks 4 definisi (pendek, agar
  // tidak menutupi hanzi pemicu — perbaikan bug loop tutup-buka 2.4.0).
  function buildHoverContent(word, entry) {
    var frag = document.createDocumentFragment();
    var head = el('div', 'cidict-head');
    head.appendChild(document.createTextNode(word));
    if (entry.t) head.appendChild(el('span', 'cidict-trad', ' [' + entry.t + ']'));
    frag.appendChild(head);
    var body = el('div', 'cidict-hover-body');
    var rd = (entry.r || [])[0];
    if (rd) {
      var block = el('div', 'cidict-reading');
      block.appendChild(el('div', 'cidict-pinyin', rd.y || ''));
      var ul = el('ul', 'cidict-defs');
      (rd.d || []).slice(0, 4).forEach(function (d) {
        var li = document.createElement('li');
        li.textContent = d;
        ul.appendChild(li);
      });
      block.appendChild(ul);
      body.appendChild(block);
    }
    frag.appendChild(body);
    frag.appendChild(el('div', 'cidict-credit', 'cidict.org'));
    return { frag: frag, body: body };
  }

  // Terpotong = ada reading/definisi yang disembunyikan, atau tinggi
  // konten melebihi batas CSS .cidict-hover-body.
  function hoverTruncated(entry, bodyEl) {
    var r = entry.r || [];
    if (r.length > 1) return true;
    if (r.length && (r[0].d || []).length > 4) return true;
    return bodyEl.scrollHeight > bodyEl.clientHeight + 2;
  }

  // Teks notice kontekstual: bila dock sedang aktif, arahkan ke dock
  // (tanpa kata "bawah" karena dock bisa di kiri/kanan di desktop).
  function hoverNoticeText() {
    if (opts.displayMode === 'both' && dockActive)
      return 'Lihat selengkapnya di panel dock, atau klik hanzi';
    return 'Klik hanzi untuk info lengkap';
  }

  function showHoverPopup(ruby) {
    if (!opts.showPopups) return;
    var word = ruby.getAttribute('data-w');
    var entry = dictCache[word];
    if (!entry) return;
    var popup = ensurePopup();
    popup.dataset.cidictTheme = opts.theme;
    popup.dataset.popupMode = 'hover';
    popup.innerHTML = '';
    var h = buildHoverContent(word, entry);
    popup.appendChild(h.frag);
    popup.style.visibility = 'hidden'; // ukur dulu sebelum tampil
    placePopup(popup, ruby);
    if (hoverTruncated(entry, h.body)) {
      popup.insertBefore(el('div', 'cidict-notice', hoverNoticeText()),
        popup.querySelector('.cidict-credit'));
      placePopup(popup, ruby); // ukur ulang setelah notice
    }
    popup.style.visibility = 'visible';
    popupState = 'hover';
    popupFor = ruby;
    refreshHl();
  }

  function copyEntry(word, entry) {
    var lines = [word + (entry.t ? ' [' + entry.t + ']' : '')];
    (entry.r || []).forEach(function (rd) {
      if (rd.y) lines.push(rd.y);
      (rd.d || []).forEach(function (d, j) { lines.push((j + 1) + '. ' + d); });
    });
    var txt = lines.join('\n');
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* abaikan */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(txt).catch(fallback);
    else fallback();
  }

  // Popup terpin: semua reading stacked, tombol x + copy, bisa scroll.
  // Di mode 'both' pada perangkat tanpa hover, tampil juga tombol pindah
  // ke mode dock.
  function showPinnedPopup(ruby) {
    if (!opts.showPopups) return;
    var word = ruby.getAttribute('data-w');
    var entry = dictCache[word];
    if (!entry) return;
    var popup = ensurePopup();
    popup.dataset.cidictTheme = opts.theme;
    popup.dataset.popupMode = 'pinned';
    popup.innerHTML = '';
    var actions = el('div', 'cidict-actions');
    if (opts.displayMode === 'both' && noHover) {
      var btnDock = el('button', 'cidict-iconbtn', '\u2913 Mode dock');
      btnDock.setAttribute('title', 'Beralih ke mode dock');
      btnDock.addEventListener('click', function (ev) {
        ev.stopPropagation();
        cidict.setDisplayMode('docked');
      });
      actions.appendChild(btnDock);
    }
    var btnCopy = el('button', 'cidict-iconbtn', '\u29C9');
    btnCopy.setAttribute('title', 'Salin definisi');
    btnCopy.addEventListener('click', function (ev) {
      ev.stopPropagation();
      copyEntry(word, entry);
    });
    actions.appendChild(btnCopy);
    var btnClose = el('button', 'cidict-iconbtn', '\u00D7');
    btnClose.setAttribute('title', 'Tutup');
    btnClose.addEventListener('click', function (ev) {
      ev.stopPropagation();
      hidePopup();
    });
    actions.appendChild(btnClose);
    popup.appendChild(actions);
    var body = el('div', 'cidict-pinned-body');
    body.appendChild(buildPopupContent(word, entry));
    popup.appendChild(body);
    popup.style.visibility = 'hidden'; // ukur dulu sebelum tampil
    placePopup(popup, ruby);
    popup.style.visibility = 'visible';
    popupState = 'pinned';
    popupFor = ruby;
    refreshHl();
  }

  function hidePopup() {
    if (popupEl) {
      popupEl.style.visibility = 'hidden';
      popupEl.style.left = '-1000px';
      popupEl.style.top = '-1000px';
    }
    popupState = null;
    popupFor = null;
    refreshHl();
  }

  // ---------- dock ----------

  function ensureDock() {
    if (dockEl) return dockEl;
    dockEl = document.createElement('div');
    dockEl.id = 'cidict-dock';
    dockEl.dataset.cidictTheme = opts.theme;
    var head = el('div', 'cidict-dock-head');
    var word = el('span', 'cidict-dock-word');
    head.appendChild(word);
    var count = el('span', 'cidict-dock-count');
    head.appendChild(count);
    function navBtn(cls, label, title, fn) {
      var b = el('button', 'cidict-dockbtn ' + cls, label);
      b.setAttribute('title', title);
      b.setAttribute('type', 'button');
      b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
      head.appendChild(b);
      return b;
    }
    navBtn('cidict-nav-hanzi-prev', '\u2190', 'Hanzi sebelumnya', function () { stepHanzi(-1); });
    navBtn('cidict-nav-hanzi-next', '\u2192', 'Hanzi berikutnya', function () { stepHanzi(1); });
    navBtn('cidict-nav-reading-prev', '\u2039', 'Reading sebelumnya', function () { stepReading(-1); });
    navBtn('cidict-nav-reading-next', '\u203A', 'Reading berikutnya', function () { stepReading(1); });
    var btnMode = navBtn('cidict-dock-switch', '\u29C9', 'Beralih ke mode popup', function () {
      cidict.setDisplayMode('popup');
    });
    btnMode.classList.add('cidict-dock-switch');
    var btnClose = navBtn('cidict-dock-close', '\u00D7', 'Tutup dock', function () { hideDock(); });
    dockEl.appendChild(head);
    var body = el('div', 'cidict-dock-body');
    dockEl.appendChild(body);
    dockEl.appendChild(el('div', 'cidict-credit', 'cidict.org'));
    document.body.appendChild(dockEl);
    dockEl._word = word;
    dockEl._count = count;
    dockEl._body = body;
    dockEl._switch = btnMode;
    return dockEl;
  }

  // Posisi dock: fixed bottom di perangkat tanpa hover; di desktop ikut
  // dockAlign ('left' | 'right').
  function applyDockPosition() {
    var dock = ensureDock();
    dock.classList.remove('dock-bottom', 'dock-left', 'dock-right');
    dock.classList.add(noHover ? 'dock-bottom'
      : (opts.dockAlign === 'left' ? 'dock-left' : 'dock-right'));
  }

  function allRubies() {
    return Array.prototype.slice.call(document.querySelectorAll('ruby.cidict-rb'));
  }

  function renderDock() {
    if (!dockActive || !dockFor) return;
    var word = dockFor.getAttribute('data-w');
    var entry = dictCache[word];
    if (!entry || !(entry.r || []).length) { hideDock(); return; }
    var n = entry.r.length;
    dockReadingIdx = Math.max(0, Math.min(dockReadingIdx, n - 1));
    var rd = entry.r[dockReadingIdx];
    var dock = ensureDock();
    dock.dataset.cidictTheme = opts.theme;
    dock._word.textContent = word + (entry.t ? ' [' + entry.t + ']' : '');
    dock._count.textContent = n > 1 ? ((dockReadingIdx + 1) + '/' + n) : '';
    var body = dock._body;
    body.innerHTML = '';
    body.appendChild(el('div', 'cidict-pinyin', rd.y || ''));
    var ul = el('ul', 'cidict-defs');
    (rd.d || []).forEach(function (d) {
      var li = document.createElement('li');
      li.textContent = d;
      ul.appendChild(li);
    });
    body.appendChild(ul);
    // Icon pindah mode hanya relevan di mode 'both'.
    dock._switch.style.display = (opts.displayMode === 'both') ? '' : 'none';
  }

  function showDock(ruby) {
    if (!opts.showPopups) return;
    var word = ruby.getAttribute('data-w');
    if (!dictCache[word]) return;
    dockActive = true;
    dockFor = ruby;
    dockReadingIdx = 0;
    applyDockPosition();
    ensureDock().classList.add('open');
    renderDock();
    refreshHl();
  }

  function hideDock() {
    dockActive = false;
    dockFor = null;
    if (dockEl) dockEl.classList.remove('open');
    refreshHl();
  }

  function stepReading(dir) {
    if (!dockActive || !dockFor) return;
    var entry = dictCache[dockFor.getAttribute('data-w')];
    var n = entry && (entry.r || []).length;
    if (!n) return;
    dockReadingIdx = (dockReadingIdx + dir + n) % n;
    renderDock();
  }

  function stepHanzi(dir) {
    if (!dockActive) return;
    var list = allRubies();
    var i = list.indexOf(dockFor);
    if (i < 0) { if (list.length) { dockFor = list[0]; dockReadingIdx = 0; renderDock(); refreshHl(); } return; }
    dockFor = list[(i + dir + list.length) % list.length];
    dockReadingIdx = 0;
    renderDock();
    refreshHl();
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

  // Aktivasi hanzi (klik / tap / Enter / Space). Perilaku mengikuti
  // displayMode; function `trigger` tidak ada — hanzi selalu bisa
  // di-hover (desktop) dan di-klik/tap.
  function activateRuby(ruby) {
    if (!opts.showPopups) return;
    var mode = opts.displayMode;
    if (mode === 'docked') { showDock(ruby); return; }
    if (mode === 'both' && !noHover) {
      // Desktop: klik = pinned-popup + dock bersamaan; klik ulang pada
      // hanzi yang sama menutup pinned (dock tetap).
      if (popupState === 'pinned' && popupFor === ruby) { hidePopup(); return; }
      showPinnedPopup(ruby);
      showDock(ruby);
      return;
    }
    if (mode === 'both' && noHover && dockActive) { showDock(ruby); return; }
    // Mode 'popup', atau 'both' di mobile tanpa dock aktif: toggle pinned.
    if (popupState === 'pinned' && popupFor === ruby) hidePopup();
    else showPinnedPopup(ruby);
  }

  function onMouseOver(e) {
    // Instant (tanpa delay): hover langsung membuka popup transien.
    // Di perangkat tanpa hover (mobile), tap langsung ditangani onClick
    // sebagai pinned-popup — tidak ada fase hover.
    if (!opts.showPopups || noHover) return;
    var ruby = closestRuby(e.target);
    if (!ruby || ruby === popupFor) return;
    if (opts.displayMode === 'docked') { showDock(ruby); return; }
    showHoverPopup(ruby);
  }

  function onMouseOut(e) {
    var ruby = closestRuby(e.target);
    if (!ruby || ruby !== popupFor) return;
    if (popupState !== 'hover') return; // popup terpin tidak ikut aturan ini
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
      activateRuby(ruby);
      return;
    }
    // Klik di luar: tutup popup terpin (dock bersifat persisten, punya
    // tombol x sendiri, dan interaksi dengannya tidak menutup popup).
    if (popupState === 'pinned' && popupEl && !popupEl.contains(e.target) &&
        !(dockEl && dockEl.contains(e.target))) hidePopup();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (popupState) { hidePopup(); return; }
      if (dockActive) { hideDock(); return; }
      return;
    }
    // Navigasi hanzi di dock via panah, hanya saat fokus di ruby/dock
    // (agar tidak membajak scroll halaman).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && dockActive) {
      var t = e.target;
      var inDock = dockEl && dockEl.contains(t);
      if (inDock || closestRuby(t)) {
        e.preventDefault();
        stepHanzi(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
    }
    var ruby = closestRuby(e.target);
    if (ruby && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activateRuby(ruby);
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

    // Annotate elemen: { theme, showInline, showPopups, displayMode,
    //   dockAlign, apiBase, chunkSize, maxConcurrency, loading }
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
      if (!opts.showPopups) { hidePopup(); hideDock(); }
      savePrefs();
      return this;
    },

    // Mode tampilan definisi: 'popup' | 'docked' | 'both'.
    // Hanya setter (tidak ada toggle). Nilai tidak valid diabaikan.
    // Berpindah mode juga menyimpan preferensi visitor ke localStorage.
    setDisplayMode: function (mode) {
      if (mode !== 'popup' && mode !== 'docked' && mode !== 'both') return this;
      opts.displayMode = mode;
      if (mode === 'popup') {
        hideDock();
      } else if (mode === 'docked') {
        var rb = popupFor;
        hidePopup();
        if (rb) showDock(rb);
      }
      // 'both': dock tampil saat hanzi diklik berikutnya.
      savePrefs();
      return this;
    },

    // Posisi dock di desktop: 'left' | 'right' (mobile selalu bottom).
    // Nilai tidak valid diabaikan.
    setDockAlign: function (align) {
      if (align !== 'left' && align !== 'right') return this;
      opts.dockAlign = align;
      if (dockActive) applyDockPosition();
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
      if (dockEl) dockEl.dataset.cidictTheme = name;
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
      hideDock();
      if (popupEl && popupEl.parentNode) popupEl.parentNode.removeChild(popupEl);
      popupEl = null;
      if (dockEl && dockEl.parentNode) dockEl.parentNode.removeChild(dockEl);
      dockEl = null;
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
