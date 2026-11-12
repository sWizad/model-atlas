/* app.js — boot, routing, selection and the live code panel.
 * Loading must never fail silently (playbook §5): every step sets status text,
 * every fetch has a hard timeout, and both global error hooks paint on screen.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const S = { index: null, model: null, data: null, level: null, sel: null,
              tab: 0, pad: 0, srcCache: new Map(), view: { k: 0, x: 0, y: 0 }, cam: null, box: null };

  // ---------------------------------------------------------------- loading
  const setLoad = (m) => { const e = $('loadMsg'); if (e) e.textContent = m; };
  function showFatal(msg) {
    const l = $('loading'), e = $('loadErr');
    if (l) l.hidden = false;
    if (e) { e.hidden = false; e.textContent = msg; }
    setLoad('stopped');
  }
  function toast(msg) {
    const old = $('toast'); if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'toast'; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  }
  window.addEventListener('error', (e) => showFatal('JS error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) =>
    showFatal('Unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));

  function getJSON(url, ms) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.responseType = 'json';
      x.timeout = ms || 20000;
      x.onload = () => {
        if (x.status < 200 || x.status >= 300) {
          let detail = '';
          try { detail = (x.response && x.response.error) || ''; } catch (_) {}
          return rej(new Error(`HTTP ${x.status}${detail ? ' — ' + detail : ''}`));
        }
        let r = x.response;
        if (r === null) { try { r = JSON.parse(x.responseText); } catch (err) { return rej(err); } }
        res(r);
      };
      x.onerror = () => rej(new Error('network error'));
      x.ontimeout = () => rej(new Error(`timeout (${x.timeout}ms)`));
      x.send();
    });
  }

  // ----------------------------------------------------------------- routing
  function route() {
    const h = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    return { model: h[0], level: h[1], node: h[2] };
  }
  function go(model, level, node, replace) {
    const h = '#/' + [model, level, node].filter(Boolean).join('/');
    if (replace) history.replaceState(null, '', h); else location.hash = h;
  }

  // ------------------------------------------------------------------- boot
  (async function boot() {
    try {
      const saved = localStorage.getItem('atlas.theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (_) {}

    setLoad('fetching index…');
    S.index = await getJSON('data/index.json?t=' + Date.now(), 15000);
    if (!S.index.models || !S.index.models.length) {
      return showFatal('data/index.json has no models — run build_viz.py first.');
    }
    setLoad('building UI…');

    const pick = $('modelPick');
    S.index.models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.name;
      pick.appendChild(o);
    });
    pick.addEventListener('change', () => go(pick.value));

    if (S.index.stale_refs) {
      const c = $('staleChip');
      c.hidden = false;
      c.textContent = `${S.index.stale_refs} stale ref${S.index.stale_refs > 1 ? 's' : ''} — run build_viz.py --fix`;
    }

    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('atlas.theme', cur); } catch (_) {}
    });
    $('zIn').addEventListener('click', () => zoomBy(1.2));
    $('zOut').addEventListener('click', () => zoomBy(1 / 1.2));
    $('zFit').addEventListener('click', fit);
    $('wider').addEventListener('click', () => { S.pad += 20; loadRef(); });
    $('whole').addEventListener('click', wholeSymbol);
    $('copyRef').addEventListener('click', copyRef);
    $('diag').addEventListener('click', () => { if (!S.swallow) select(null); });
    wirePan();
    wireGutter();
    window.addEventListener('hashchange', apply);
    window.addEventListener('keydown', onKey);

    setLoad('loading model…');
    await apply();
    $('loading').hidden = true;
    ['top', 'levels', 'app'].forEach((i) => ($(i).hidden = false));
    applyView();                       // the stage finally has a width
  })().catch((e) => showFatal(
    'Could not start: ' + e.message +
    '\n\nIf this says 404, run build_viz.py. If it hangs, hard-refresh (Cmd/Ctrl+Shift+R) ' +
    'or reopen on a fresh port — a new localhost:PORT origin has an empty cache.'));

  // ---------------------------------------------------------------- applying
  async function apply() {
    const r = route();
    const mid = r.model && S.index.models.some((m) => m.id === r.model)
      ? r.model : S.index.models[0].id;
    const meta = S.index.models.find((m) => m.id === mid);

    if (S.model !== mid) {
      setLoad('loading ' + mid + '…');
      S.data = await getJSON(`data/${mid}.json?v=${encodeURIComponent(S.index.built_utc)}`, 20000);
      S.model = mid;
      $('modelPick').value = mid;
      const sc = $('shapeChip'), sn = S.data.manifest.shape_note;
      sc.hidden = !sn; if (sn) sc.textContent = sn;
    }
    const lid = (r.level && S.data.levels[r.level]) ? r.level : (meta.root || Object.keys(S.data.levels)[0]);
    S.level = lid;
    if (r.model !== mid || r.level !== lid) go(mid, lid, r.node, true);

    renderRail();
    renderCrumbs();
    draw();
    if (r.node) {
      const sp = findSpec(r.node);
      if (sp) select(r.node, sp, true);
    } else select(null);
  }

  function findSpec(id) {
    const lv = S.data.levels[S.level];
    if (id.startsWith('note:')) {
      const [, ri, ki] = id.split(':');
      const row = lv.rows[+ri];
      return row ? (lv.notes || []).filter((n) => n.row === row.id)[+ki] : null;
    }
    return (lv.nodes || []).find((n) => n.id === id) ||
           (lv.bands || []).find((b) => b.id === id) || null;
  }

  function renderRail() {
    const rail = $('levels'), meta = S.index.models.find((m) => m.id === S.model);
    rail.textContent = '';
    meta.levels.forEach((l, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = l.id === S.level ? 'on' : '';
      b.innerHTML = `<span class="lvnum">${i + 1}</span>${l.short || l.title}`;
      b.addEventListener('click', () => go(S.model, l.id));
      rail.appendChild(b);
    });
  }

  function renderCrumbs() {
    const c = $('crumbs'), lv = S.data.levels[S.level];
    let chain = [];
    let cur = lv;
    while (cur) { chain.unshift(cur); cur = cur.parent ? S.data.levels[cur.parent] : null; }
    c.textContent = '';
    // Six levels deep the full chain just gets clipped; keep the tail, which is
    // the part that says where you are.
    if (chain.length > 3) {
      const e = document.createElement('span');
      e.className = 'sep'; e.textContent = '…';
      c.appendChild(e);
      chain = chain.slice(-3);
    }
    chain.forEach((l, i) => {
      if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; c.appendChild(s); }
      if (l.id === S.level) {
        const s = document.createElement('span'); s.className = 'cur'; s.textContent = l.title; c.appendChild(s);
      } else {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = l.title;
        b.addEventListener('click', () => go(S.model, l.id));
        c.appendChild(b);
      }
    });
  }

  function draw() {
    const lv = S.data.levels[S.level];
    $('lvTitle').textContent = lv.title || S.level;
    $('lvSub').textContent = lv.subtitle || '';
    const out = window.Atlas.renderDiagram($('diag'), lv, S.data.manifest, {
      onSelect: (id, spec) => select(id, spec),
      onDrill: (target) => go(S.model, target),
      onUp: (lvl, node) => go(S.model, lvl, node),
      titleOf: (id) => (S.data.levels[id] || {}).title || id,
      shortOf: (id) => { const l = S.data.levels[id] || {}; return l.short || l.title || id; },
    });
    S.cam = out.cam;
    S.box = { W: out.layout.W, H: out.layout.H };
    S.view = { k: 0, x: 0, y: 0 };   // unfitted; applyView fits once the stage has a width
    applyView();
  }

  // -------------------------------------------------------------- selection
  function select(id, spec, keepHash) {
    const cam = S.cam;
    if (cam) {
      cam.classList.toggle('has-sel', !!id);
      cam.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
      cam.querySelectorAll('.lit').forEach((n) => n.classList.remove('lit'));
      if (id) {
        const g = cam.querySelector(`[data-id="${CSS.escape(id)}"]`) ||
                  cam.querySelector(`[data-note="${CSS.escape(id.replace('note:', ''))}"]`);
        if (g) g.classList.add('sel');
        cam.querySelectorAll(`.eg[data-from="${CSS.escape(id)}"], .eg[data-to="${CSS.escape(id)}"]`)
           .forEach((e) => e.classList.add('lit'));
      }
    }
    S.sel = id ? { id, spec } : null;
    S.tab = 0; S.pad = 0;
    if (!keepHash) go(S.model, S.level, id || undefined, true);
    renderSide();
  }

  function renderSide() {
    const t = $('sideTitle'), d = $('sideDim'), n = $('sideNote'), tabs = $('tabs');
    tabs.textContent = '';
    const lv = S.data.levels[S.level];
    if (!S.sel && (lv.code || []).length) {
      // Landing on a level shows that LEVEL's own source - the overview - so the
      // panel is never blank and you can read the whole function it draws.
      S.sel = { id: null, spec: lv, overview: true };
    }
    if (!S.sel) {
      t.textContent = 'Nothing selected';
      d.textContent = ''; n.textContent = '';
      $('codeBar').hidden = true; $('code').textContent = ''; $('codePath').textContent = '';
      $('empty').hidden = false;
      return;
    }
    const sp = S.sel.spec;
    const isOverview = !!S.sel.overview;
    t.textContent = (isOverview ? 'Overview \u00b7 ' : '') + (sp.title || sp.label || S.sel.id);
    d.textContent = isOverview ? 'the whole function this level draws' : (sp.dim || '');
    n.textContent = isOverview ? (sp.subtitle || '') : (sp.note || sp.text || '');
    const refs = sp.code || [];
    if (!refs.length) {
      $('codeBar').hidden = true; $('code').textContent = ''; $('codePath').textContent = '';
      $('empty').hidden = false;
      $('empty').innerHTML = 'No code reference on this element yet.<br><b>Add one to its spec under <code>code: []</code>.</b>';
      return;
    }
    refs.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === S.tab ? 'on' : '';
      const base = (r.src || '').split('.').pop();
      b.innerHTML = `<span class="role">${r.role || 'code'}</span>${base}:${r.lines[0]}` +
        (r._v && r._v !== 'OK' ? `<span class="drift">${r._v}</span>` : '');
      b.addEventListener('click', () => { S.tab = i; S.pad = 0; renderSide(); loadRef(); });
      tabs.appendChild(b);
    });
    loadRef();
  }

  // --------------------------------------------------------------- the code
  function curRef() {
    return S.sel && S.sel.spec.code ? S.sel.spec.code[S.tab] : null;
  }

  /** Load the current tab's lines. `range` overrides them (the whole-symbol view). */
  async function loadRef(range) {
    const ref = curRef();
    if (!ref) return;
    const a = range ? range[0] : Math.max(1, ref.lines[0] - S.pad);
    const b = range ? range[1] : ref.lines[1] + S.pad;
    const key = `${ref.src}:${a}:${b}`;
    $('empty').hidden = true;
    $('codeBar').hidden = false;
    $('codePath').textContent = 'loading…';
    $('whole').disabled = !(ref.expect && ref.expect.span);
    try {
      let r = S.srcCache.get(key);
      if (!r) {
        r = await getJSON(`/api/src?src=${encodeURIComponent(ref.src)}&a=${a}&b=${b}`, 15000);
        S.srcCache.set(key, r);
      }
      S.shown = r;
      $('codePath').textContent = `${r.label}  ${r.start}\u2013${r.end}` +
        (ref.expect && ref.expect.symbol ? `   ${ref.expect.symbol}` : '');
      // when the view is wider than the ref, mark where the ref itself sits
      const wide = a < ref.lines[0] || b > ref.lines[1];
      $('code').innerHTML = window.Atlas.renderLines(r.lines, r.start, ref.focus || (wide ? ref.lines : null));
    } catch (e) {
      S.shown = null;
      $('codePath').textContent = ref.src;
      $('code').innerHTML = `<span class="ln"><span class="n"></span>Could not read source: ${e.message}</span>`;
      toast(`/api/src failed for ${ref.src}: ${e.message}`);
    }
  }

  function wholeSymbol() {
    const ref = curRef();
    if (!ref || !ref.expect || !ref.expect.span) return;
    const [lo, hi] = ref.expect.span;
    S.pad = 0;
    loadRef([lo, Math.min(hi, lo + 399)]);
  }

  function copyRef() {
    const r = S.shown, ref = curRef();
    if (!ref) return;
    const where = r ? `${r.path}:${r.start}` : `${ref.src}:${ref.lines[0]}`;
    navigator.clipboard.writeText(where).then(
      () => toast('copied ' + where),
      () => toast('clipboard blocked — ' + where));
  }

  // ------------------------------------------------------------ the canvas
  /* A real canvas: the viewport is fixed and the viewBox moves over the drawing,
     so there are no scrollbars and text stays crisp at any zoom. S.view.{x,y} is
     the world coordinate at the top-left of the viewport; k is pixels per world
     unit. Opening a level fits the WIDTH (letterboxing a 13-row diagram to fit
     height shrank the text to nothing), then you pan and zoom freely. */
  const KMIN = 0.15, KMAX = 6;

  function viewport() {
    const host = $('stageScroll');
    return { w: host.clientWidth, h: host.clientHeight };
  }

  function applyView() {
    if (!S.box) return;
    const vp = viewport();
    if (vp.w < 90 || vp.h < 90) return;    // not laid out yet; ResizeObserver retries
    if (!S.view.k) fitWidth();
    const vw = vp.w / S.view.k, vh = vp.h / S.view.k;
    $('diag').setAttribute('viewBox', `${S.view.x} ${S.view.y} ${vw} ${vh}`);
  }

  function fitWidth() {
    const vp = viewport();
    S.view.k = vp.w / S.box.W;
    S.view.x = 0;
    S.view.y = 0;
  }

  function fitAll() {
    const vp = viewport();
    S.view.k = Math.min(vp.w / S.box.W, vp.h / S.box.H);
    S.view.x = (S.box.W - vp.w / S.view.k) / 2;
    S.view.y = 0;
  }

  /** Toggle: whole diagram <-> fit to width. */
  function fit() {
    if (!S.box) return;
    const vp = viewport();
    const kAll = Math.min(vp.w / S.box.W, vp.h / S.box.H);
    if (Math.abs(S.view.k - kAll) < 0.005) fitWidth(); else fitAll();
    applyView();
  }

  /** Zoom about a point given in CLIENT pixels (defaults to the centre). */
  function zoomBy(f, cx, cy) {
    if (!S.box) return;
    const vp = viewport();
    const px = cx === undefined ? vp.w / 2 : cx;
    const py = cy === undefined ? vp.h / 2 : cy;
    const wx = S.view.x + px / S.view.k;      // world point under the cursor
    const wy = S.view.y + py / S.view.k;
    S.view.k = Math.min(KMAX, Math.max(KMIN, S.view.k * f));
    S.view.x = wx - px / S.view.k;            // keep it under the cursor
    S.view.y = wy - py / S.view.k;
    applyView();
  }

  function panBy(dxPx, dyPx) {
    S.view.x += dxPx / S.view.k;
    S.view.y += dyPx / S.view.k;
    applyView();
  }

  function wirePan() {
    const host = $('stageScroll'), svg = $('diag');
    const T = 4;
    let down = false, drag = false, px = 0, py = 0;

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = true; drag = false; px = e.clientX; py = e.clientY;
    });
    svg.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      if (!drag) {
        if (Math.abs(dx) < T && Math.abs(dy) < T) return;
        drag = true;
        svg.classList.add('drag');
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      }
      panBy(-dx, -dy);
      px = e.clientX; py = e.clientY;
    });
    const up = (e) => {
      if (drag) { S.swallow = true; setTimeout(() => (S.swallow = false), 0); }
      down = false; drag = false;
      svg.classList.remove('drag');
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);

    // Figma/Miro convention: wheel pans, ctrl/cmd+wheel zooms at the cursor.
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = host.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      } else {
        panBy(e.shiftKey ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY);
      }
    }, { passive: false });

    svg.addEventListener('dblclick', (e) => { if (e.target === svg) fit(); });

    if (window.ResizeObserver) new ResizeObserver(applyView).observe(host);
  }

  // ------------------------------------------------------- the split handle
  /* Drag the gutter to trade diagram width for code width; the choice sticks. */
  const SIDE_DEFAULT = 460;
  function setSide(px) {
    const max = Math.max(360, window.innerWidth - 420);
    const w = Math.round(Math.min(max, Math.max(300, px)));
    document.documentElement.style.setProperty('--side', w + 'px');
    try { localStorage.setItem('atlas.side', String(w)); } catch (_) {}
    applyView();
  }
  function wireGutter() {
    try {
      const saved = parseInt(localStorage.getItem('atlas.side') || '', 10);
      if (saved) setSide(saved);
    } catch (_) {}
    const g = $('gutter');
    let on = false;
    const stacked = () => window.innerWidth <= 1080;
    g.addEventListener('pointerdown', (e) => {
      if (stacked()) return;          // panels are stacked; width drag is meaningless
      on = true; g.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
    });
    g.addEventListener('pointermove', (e) => {
      if (on) setSide(window.innerWidth - e.clientX);
    });
    const stop = (e) => {
      on = false;
      document.body.classList.remove('resizing');
      try { g.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    g.addEventListener('pointerup', stop);
    g.addEventListener('pointercancel', stop);
    g.addEventListener('dblclick', () => setSide(SIDE_DEFAULT));
    g.addEventListener('keydown', (e) => {
      const cur = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--side'), 10) || SIDE_DEFAULT;
      if (e.key === 'ArrowLeft') { setSide(cur + 40); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setSide(cur - 40); e.preventDefault(); }
    });
    window.addEventListener('resize', applyView);
  }

  function onKey(e) {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === '0') fit();
    else if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === 'Escape') select(null);
    else if (e.key === 'ArrowLeft') panBy(-80, 0);
    else if (e.key === 'ArrowRight') panBy(80, 0);
    else if (e.key === 'ArrowUp') panBy(0, -80);
    else if (e.key === 'ArrowDown') panBy(0, 80);
  }
})();
