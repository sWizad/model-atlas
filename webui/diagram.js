/* diagram.js — the generic lane × row SVG renderer.
 *
 * A spec places things in a named grid; this file does all pixel math. It never
 * hardcodes a colour: a node's `stream` resolves to var(--tone-<tone>) from the
 * model manifest, so the theme toggle needs no re-render.
 *
 * renderDiagram(svg, level, manifest, {onSelect, onDrill}) -> {fit, zoom}
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const D = { laneW: 240, laneGap: 32, rowH: 92, rowGap: 54, pad: [30, 44, 44, 140] };
  const BOXPAD = 12, LINE = 15, TITLE = 18, DIMH = 16, GUTTER = 14, HEADH = 26;
  const ZOOMH = 86;   // the 'you are inside X' lens above the lane headers
  const DRILLH = 15;  // its own line for the 'opens -> <level>' label

  // ---- text measurement (canvas is faster and steadier than getComputedTextLength)
  const ctx2d = document.createElement('canvas').getContext('2d');
  const _mw = new Map();
  function textW(s, font) {
    const k = font + '\u0000' + s;
    let v = _mw.get(k);
    if (v === undefined) { ctx2d.font = font; v = ctx2d.measureText(s).width; _mw.set(k, v); }
    return v;
  }
  const F_TITLE = '600 12.5px Outfit, Inter, sans-serif';
  const F_SUB = '11px Inter, sans-serif';
  const F_DIM = '10.5px "JetBrains Mono", monospace';
  const F_DRILL = '9.5px Inter, sans-serif';
  const F_ROW = '600 10px Outfit, Inter, sans-serif';
  const ROWLAB_TRACK = 0.9;   // .09em letter-spacing, which measureText ignores

  function wrap(s, font, maxW, maxLines) {
    if (textW(s, font) <= maxW) return [s];
    const words = String(s).split(/\s+/), out = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (textW(t, font) <= maxW || !cur) { cur = t; } else { out.push(cur); cur = w; }
      if (maxLines && out.length === maxLines) break;
    }
    if (cur && (!maxLines || out.length < maxLines)) out.push(cur);
    if (maxLines && out.length === maxLines) {
      let last = out[maxLines - 1];
      while (last.length > 1 && textW(last + '…', font) > maxW) last = last.slice(0, -1);
      if (textW(out[maxLines - 1], font) > maxW) out[maxLines - 1] = last + '…';
    }
    return out;
  }

  const el = (name, attrs, parent) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const txt = (parent, x, y, cls, s) => {
    const t = el('text', { x, y, class: cls }, parent);
    t.textContent = s;
    return t;
  };

  function toneOf(manifest, streamId) {
    const s = (manifest.streams || {})[streamId];
    return s && s.tone ? s.tone : 'slate';
  }

  // ---------------------------------------------------------------- layout
  function layout(level, manifest) {
    const g = Object.assign({}, D, level.grid || {});
    const pad = (g.pad || D.pad).slice();
    const lanes = level.lanes || [], rows = level.rows || [];

    // Row labels live in the left margin. Widen it to fit them rather than
    // trusting the spec's pad — otherwise a spec silently clips its own labels.
    let need = 0;
    for (const r of rows) {
      if (r.label) need = Math.max(need, textW(r.label, F_ROW) + r.label.length * ROWLAB_TRACK);
    }
    if (need) pad[3] = Math.max(pad[3], Math.ceil(need) + 30);

    const laneW = [], laneX = [];
    let x = pad[3];
    lanes.forEach((l, i) => {
      laneW[i] = (l.w || 1) * g.laneW;
      laneX[i] = x;
      x += laneW[i] + g.laneGap;
    });
    const contentW = lanes.length ? laneX[lanes.length - 1] + laneW[lanes.length - 1] - pad[3] : 400;

    const laneIx = {}, rowIx = {};
    lanes.forEach((l, i) => (laneIx[l.id] = i));
    rows.forEach((r, i) => (rowIx[r.id] = i));

    // node box geometry needs widths first, heights after
    const boxes = {};
    for (const n of level.nodes || []) {
      const li = laneIx[n.lane], span = n.laneSpan || 1;
      const full = laneX[li + span - 1] + laneW[li + span - 1] - laneX[li];
      const cols = n.cols || 1, col = n.col || 0;
      const w = (full - GUTTER * (cols - 1)) / cols;
      const inner = w - BOXPAD * 2;
      const tl = wrap(n.title || '', F_TITLE, inner, 2);
      const sl = [];
      for (const s of n.sublines || []) sl.push(...wrap(s, F_SUB, inner, 2));
      const h = BOXPAD * 2 + tl.length * TITLE + sl.length * LINE +
                (n.dim ? DIMH : 0) + (n.drill ? DRILLH : 0);
      boxes[n.id] = { x: laneX[li] + col * (w + GUTTER), w, h, tl, sl, node: n };
    }

    const rowH = [], rowY = [];
    const zoomH = level.zoom_from ? ZOOMH : 0;
    let y = pad[0] + HEADH + zoomH;
    rows.forEach((r, i) => {
      let hh = (r.h || 1) * (r.kind === 'footer' ? 0 : g.rowH);
      for (const id in boxes) {
        const b = boxes[id];
        if (rowIx[b.node.row] === i) hh = Math.max(hh, b.h + 16);
      }
      if (r.kind === 'footer') {
        const notes = (level.notes || []).filter((n) => n.row === r.id);
        if (notes.length) {
          const w = (contentW - GUTTER * (notes.length - 1)) / notes.length;
          let nh = 0;
          for (const n of notes) {
            const lines = wrap(n.text || '', F_SUB, w - BOXPAD * 2, 6);
            nh = Math.max(nh, BOXPAD * 2 + TITLE + lines.length * LINE);
          }
          hh = Math.max(hh, nh);
        }
      }
      rowH[i] = hh;
      rowY[i] = y;
      y += hh + (r.kind === 'footer' ? g.rowGap + 14 : g.rowGap);
    });

    for (const id in boxes) {
      const b = boxes[id], i = rowIx[b.node.row], span = b.node.rowSpan || 1;
      const cellH = rowY[i + span - 1] + rowH[i + span - 1] - rowY[i];
      b.y = rowY[i] + (cellH - b.h) / 2;
    }

    const bands = {};
    for (const bd of level.bands || []) {
      const rs = bd.rows.map((r) => rowIx[r]);
      const r0 = Math.min(...rs), r1 = Math.max(...rs);
      let bx, bw;
      if (bd.lanes === '*') {
        bx = laneX[0]; bw = contentW;
      } else {
        const is = bd.lanes.map((l) => laneIx[l]);
        const i0 = Math.min(...is), i1 = Math.max(...is);
        bx = laneX[i0]; bw = laneX[i1] + laneW[i1] - laneX[i0];
      }
      bands[bd.id] = { x: bx, w: bw, y: rowY[r0], h: rowY[r1] + rowH[r1] - rowY[r0], band: bd };
    }

    const H = (rowY.length ? rowY[rowY.length - 1] + rowH[rowH.length - 1] : 300) + pad[2];
    return { g, pad, lanes, rows, laneX, laneW, rowY, rowH, laneIx, rowIx, zoomH,
             boxes, bands, contentW, W: pad[3] + contentW + pad[1], H };
  }

  // ---------------------------------------------------------------- anchors
  function anchor(r, port) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    switch (port) {
      case 'n': return [cx, r.y];
      case 's': return [cx, r.y + r.h];
      case 'w': return [r.x, cy];
      case 'e': return [r.x + r.w, cy];
      case 'nw': return [r.x, r.y];
      case 'ne': return [r.x + r.w, r.y];
      case 'sw': return [r.x, r.y + r.h];
      case 'se': return [r.x + r.w, r.y + r.h];
      default: return [cx, cy];
    }
  }

  function edgePath(p0, p1, kind, bow) {
    const [x0, y0] = p0, [x1, y1] = p1;
    if (kind === 'elbow') {
      const my = (y0 + y1) / 2;
      return `M ${x0} ${y0} V ${my} H ${x1} V ${y1}`;
    }
    if (kind === 'curve') {
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, b = bow === undefined ? 90 : bow;
      return `M ${x0} ${y0} C ${x0 + nx * b} ${y0 + ny * b}, ${x1 + nx * b} ${y1 + ny * b}, ${x1} ${y1}`;
    }
    return `M ${x0} ${y0} L ${x1} ${y1}`;
  }

  function midOf(kind, p0, p1, bow) {
    if (kind === 'curve') {
      const [x0, y0] = p0, [x1, y1] = p1;
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
      const b = (bow === undefined ? 90 : bow) * 0.75;
      return [(x0 + x1) / 2 - dy / len * b, (y0 + y1) / 2 + dx / len * b];
    }
    return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  }

  // ----------------------------------------------------------------- render
  function renderDiagram(svg, level, manifest, handlers) {
    handlers = handlers || {};
    const L = layout(level, manifest);
    svg.textContent = '';
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');

    const tones = new Set(['slate']);
    (level.nodes || []).forEach((n) => tones.add(toneOf(manifest, n.stream)));
    (level.edges || []).forEach((e) => tones.add(toneOf(manifest, e.stream)));
    const defs = el('defs', {}, svg);
    tones.forEach((t) => {
      const m = el('marker', { id: `ah-${t}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
                               markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: `var(--tone-${t})` }, m);
    });

    const cam = el('g', { id: 'cam' }, svg);
    const gBand = el('g', {}, cam), gEdge = el('g', {}, cam),
          gNode = el('g', {}, cam), gNote = el('g', {}, cam), gChrome = el('g', {}, cam);

    // The zoom lens: a ghost of the parent box, funnelling down into this level.
    // Without it a level reads as a free-floating picture with no idea where it
    // came from — which is exactly the complaint it exists to answer.
    if (level.zoom_from) {
      const z = level.zoom_from;
      const gz = el('g', { class: 'zoomlens', 'data-up': z.level }, gChrome);
      const bw = Math.min(520, L.contentW * 0.56);
      const bx = L.pad[3] + (L.contentW - bw) / 2, by = L.pad[0];
      el('rect', { x: bx, y: by, width: bw, height: 44, class: 'zbox' }, gz);
      txt(gz, bx + bw / 2, by + 18, 'zcap', (handlers.titleOf ? handlers.titleOf(z.level) : z.level) + '  ·  zoom in on')
        .setAttribute('text-anchor', 'middle');
      txt(gz, bx + bw / 2, by + 34, 'zname', z.label || z.node).setAttribute('text-anchor', 'middle');
      const top = by + 44, bot = by + ZOOMH - 16;
      el('path', { d: `M ${bx} ${top} L ${L.pad[3]} ${bot}`, class: 'zfun' }, gz);
      el('path', { d: `M ${bx + bw} ${top} L ${L.pad[3] + L.contentW} ${bot}`, class: 'zfun' }, gz);
      el('path', { d: `M ${L.pad[3]} ${bot} L ${L.pad[3] + L.contentW} ${bot}`, class: 'zfun dash' }, gz);
      txt(gz, L.pad[3] + L.contentW, bot - 7, 'zhint', '↑ click to go back up')
        .setAttribute('text-anchor', 'end');
      gz.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (handlers.onUp) handlers.onUp(z.level, z.node);
      });
    }

    // Say out loud when columns are MEANT to stand apart, so a comparison or a
    // gallery never reads as a flow diagram that forgot to join up.
    const kind = level.kind || 'flow';
    if (kind !== 'flow') {
      const cap = kind === 'compare'
        ? 'side-by-side comparison — the columns are two variants of one thing, not a flow'
        : 'gallery — each column is an independent piece; there is no flow between them';
      txt(gChrome, L.pad[3], L.pad[0] + L.zoomH - 6, 'kindcap', cap);
    }

    // a comparison marks, per row, whether the two columns agree
    if (kind === 'compare' && L.lanes.length === 2) {
      const gap = (L.laneX[1] + L.laneX[0] + L.laneW[0]) / 2;
      L.rows.forEach((r, i) => {
        if (!r.compare) return;
        const y = L.rowY[i] + L.rowH[i] / 2;
        const same = r.compare === 'same';
        const label = same ? 'same' : 'differs';
        const w = textW(label, '9.5px Inter, sans-serif') + 14;
        el('rect', { x: gap - w / 2, y: y - 9, width: w, height: 18, rx: 9,
                     class: 'cmp ' + r.compare }, gChrome);
        txt(gChrome, gap, y + 4, 'cmptx ' + r.compare, label)
          .setAttribute('text-anchor', 'middle');
      });
    }

    // lane headers + guides
    L.lanes.forEach((l, i) => {
      txt(gChrome, L.laneX[i] + L.laneW[i] / 2, L.pad[0] + L.zoomH + 6, 'lane-label', l.label || l.id)
        .setAttribute('text-anchor', 'middle');
      el('line', { x1: L.laneX[i] + L.laneW[i] / 2, y1: L.pad[0] + L.zoomH + 14,
                   x2: L.laneX[i] + L.laneW[i] / 2, y2: L.H - L.pad[2], class: 'lane-guide' }, gChrome);
    });
    // row labels + the footer rule
    L.rows.forEach((r, i) => {
      if (r.label) {
        const t = txt(gChrome, L.pad[3] - 18, L.rowY[i] + L.rowH[i] / 2 + 3, 'row-label', r.label);
        t.setAttribute('text-anchor', 'end');
      }
      if (r.kind === 'footer') {
        el('line', { x1: L.pad[3], y1: L.rowY[i] - 22, x2: L.pad[3] + L.contentW,
                     y2: L.rowY[i] - 22, class: 'rule' }, gChrome);
      }
    });

    const rectOf = (id) => L.boxes[id] || L.bands[id];

    // bands
    for (const id in L.bands) {
      const b = L.bands[id], sp = b.band;
      const g = el('g', { class: `bd ${sp.style || 'shaded'}${sp.dashed ? ' dashed' : ''}${sp.selectable ? ' sel8' : ''}`,
                          'data-id': id }, gBand);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'band' }, g);
      const cx = b.x + b.w / 2;
      const hasDim = !!sp.dim;
      // A band whose area is occupied by node boxes cannot put its label in the
      // middle - the text would render underneath them - so it labels itself
      // just above instead. Test the real geometry: sharing a ROW is not enough,
      // the node must also sit within the band's LANES, or a band gets pushed
      // outside itself by a box sitting in a column it does not even cover.
      const shared = Object.values(L.boxes).some((n) =>
        sp.rows.indexOf(n.node.row) >= 0 && n.x < b.x + b.w - 1 && n.x + n.w > b.x + 1);
      if (shared) {
        txt(g, b.x + 14, b.y - 9, 'bt out', sp.label || '');
        if (hasDim) {
          const lw = textW(sp.label || '', F_TITLE);
          txt(g, b.x + 28 + lw, b.y - 9, 'bs out', sp.dim);
        }
      } else {
        const tl = wrap(sp.label || '', F_TITLE, b.w - 40, 2);
        let ty = b.y + b.h / 2 - (tl.length * TITLE + (hasDim ? DIMH : 0)) / 2 + 13;
        tl.forEach((s) => { txt(g, cx, ty, 'bt', s).setAttribute('text-anchor', 'middle'); ty += TITLE; });
        if (hasDim) txt(g, cx, ty + 2, 'bs', sp.dim).setAttribute('text-anchor', 'middle');
      }
      if (sp.drill) {
        drillMark(g, b.x + b.w - 14, b.y + b.h - 12);
        const lt = handlers.shortOf ? handlers.shortOf(sp.drill) : sp.drill;
        txt(g, b.x + 16, b.y + b.h - 9, 'drilltx', 'opens → ' + lt);
      }
      if (sp.selectable !== false) bindPick(g, id, sp, handlers);
    }

    // edges
    (level.edges || []).forEach((e, i) => {
      const a = rectOf(e.from), b = rectOf(e.to);
      if (!a || !b) return;
      const ports = e.ports || ['s', 'n'];
      const p0 = anchor(a, ports[0]), p1 = anchor(b, ports[1]);
      // A band spans lanes, so its n/s anchor is meaningless as an x: borrow the
      // x of the node at the other end so the arrow stays in that lane. Clamp it
      // to the band's own extent though - a band that covers only SOME lanes must
      // not sprout an arrow from empty space beside it.
      const vert = (q) => q === 'n' || q === 's';
      const aBand = !!L.bands[e.from], bBand = !!L.bands[e.to];
      const onBand = (r, x) => Math.min(Math.max(x, r.x + 18), r.x + r.w - 18);
      if (bBand && !aBand && vert(ports[1])) p1[0] = onBand(b, p0[0]);
      if (aBand && !bBand && vert(ports[0])) p0[0] = onBand(a, p1[0]);
      const tone = toneOf(manifest, e.stream);
      const g = el('g', { class: `eg${e.dashed ? ' dashed' : ''}`, style: `--tone:var(--tone-${tone})`,
                          'data-from': e.from, 'data-to': e.to }, gEdge);
      const kind = e.kind || 'straight';
      el('path', { d: edgePath(p0, p1, kind, e.bow),
                   'marker-end': e.head === 'none' ? null : `url(#ah-${tone})` }, g);
      if (e.label) {
        const [mx, my] = midOf(kind, p0, p1, e.bow);
        txt(g, mx, my - 5, '', e.label).setAttribute('text-anchor', 'middle');
      }
    });

    // nodes
    for (const id in L.boxes) {
      const b = L.boxes[id], n = b.node, tone = toneOf(manifest, n.stream);
      const g = el('g', { class: `nd${n.optional ? ' dashed' : ''}`, 'data-id': id,
                          style: `--tone:var(--tone-${tone})` }, gNode);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'tint' }, g);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'box' }, g);
      let ty = b.y + BOXPAD + 12;
      b.tl.forEach((s) => { txt(g, b.x + BOXPAD, ty, 't', s); ty += TITLE; });
      b.sl.forEach((s) => { txt(g, b.x + BOXPAD, ty, 's', s); ty += LINE; });
      if (n.dim) { txt(g, b.x + BOXPAD, ty + 3, 'd', n.dim); ty += DIMH; }
      const st = n.state;
      if (st === 'trainable' || st === 'frozen') {
        el('circle', { cx: b.x + b.w - 14, cy: b.y + 14, r: 4.5,
                       class: st === 'trainable' ? 'st-train' : 'st-froz' }, g);
        el('title', {}, g).textContent = st === 'trainable' ? 'trains' : 'frozen';
      }
      if (n.badge) txt(g, b.x + b.w - (st === 'none' ? 10 : 26), b.y + 18, 'g', n.badge)
        .setAttribute('text-anchor', 'end');
      if (n.drill) {
        drillMark(g, b.x + b.w - 10, b.y + b.h - 9);
        const lt = handlers.shortOf ? handlers.shortOf(n.drill) : n.drill;
        const fit = wrap('opens → ' + lt, F_DRILL, b.w - BOXPAD - 24, 1)[0];
        txt(g, b.x + BOXPAD, ty + 2, 'drilltx', fit);
      }
      bindPick(g, id, n, handlers);
    }

    // footer notes
    L.rows.forEach((r, i) => {
      if (r.kind !== 'footer') return;
      const notes = (level.notes || []).filter((n) => n.row === r.id);
      if (!notes.length) return;
      const w = (L.contentW - GUTTER * (notes.length - 1)) / notes.length;
      notes.forEach((n, k) => {
        const x = L.pad[3] + k * (w + GUTTER);
        const g = el('g', { class: 'nt', 'data-note': `${i}:${k}` }, gNote);
        const lines = wrap(n.text || '', F_SUB, w - BOXPAD * 2, 6);
        const h = BOXPAD * 2 + TITLE + lines.length * LINE;
        el('rect', { x, y: L.rowY[i], width: w, height: h }, g);
        let ty = L.rowY[i] + BOXPAD + 11;
        txt(g, x + BOXPAD, ty, 'ntt', n.title || ''); ty += TITLE + 2;
        lines.forEach((s) => { txt(g, x + BOXPAD, ty, 'nts', s); ty += LINE; });
        bindPick(g, `note:${i}:${k}`, n, handlers);
      });
    });

    return { layout: L, cam };
  }

  /** A small triangle meaning "double-click to drill in" — geometry, not a glyph,
   *  so it cannot fall back to tofu when a font lacks the character. */
  function drillMark(g, x, y) {
    el('path', { d: `M ${x - 7} ${y - 5} L ${x} ${y + 3} L ${x + 7} ${y - 5} z`, class: 'drill' }, g);
  }

  function bindPick(g, id, spec, handlers) {
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (handlers.onSelect) handlers.onSelect(id, spec, g);
    });
    if (spec.drill) {
      g.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        if (handlers.onDrill) handlers.onDrill(spec.drill);
      });
    }
  }

  global.Atlas = global.Atlas || {};
  global.Atlas.renderDiagram = renderDiagram;
  global.Atlas.layout = layout;
})(window);
