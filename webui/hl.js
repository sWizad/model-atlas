/* hl.js — a small Python syntax highlighter. No CDN: this pod's egress is not
 * dependable and Python is the only language the atlas ever shows.
 *
 * One alternating regex, longest-context-first (triple quotes beat quotes beat
 * comments), so a '#' inside a string is not a comment and a quote inside a
 * comment is not a string. Everything not matched is escaped and passed through.
 */
(function (global) {
  'use strict';

  const KW = new Set(('False None True and as assert async await break class continue def del ' +
    'elif else except finally for from global if import in is lambda nonlocal not or pass ' +
    'raise return try while with yield match case self cls').split(' '));
  const BI = new Set(('abs all any bool bytes dict enumerate float format getattr hasattr int ' +
    'isinstance len list map max min open print range repr reversed set setattr sorted str ' +
    'sum super tuple type zip torch nn F np Tensor Optional Union List Dict Tuple Any').split(' '));

  // order matters: triple-strings, strings, comments, decorators, numbers, words
  const TOK = new RegExp([
    /(?:[rbuf]{0,2})("""[\s\S]*?"""|'''[\s\S]*?''')/.source,
    /(?:[rbuf]{0,2})("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/.source,
    /(#[^\n]*)/.source,
    /(@[A-Za-z_][\w.]*)/.source,
    /\b(\d+\.?\d*(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+)\b/.source,
    /\b([A-Za-z_]\w*)\b/.source,
  ].join('|'), 'g');

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function highlight(src) {
    let out = '', last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      const [all, tri, str, com, dec, num, word] = m;
      if (tri !== undefined) out += `<span class="t-str">${esc(all)}</span>`;
      else if (str !== undefined) out += `<span class="t-str">${esc(all)}</span>`;
      else if (com !== undefined) out += `<span class="t-com">${esc(all)}</span>`;
      else if (dec !== undefined) out += `<span class="t-dec">${esc(all)}</span>`;
      else if (num !== undefined) out += `<span class="t-num">${esc(all)}</span>`;
      else if (word !== undefined) {
        // the name right after def/class is the definition itself
        const before = src.slice(Math.max(0, m.index - 7), m.index);
        if (/\b(def|class)\s+$/.test(before)) out += `<span class="t-def">${esc(word)}</span>`;
        else if (KW.has(word)) out += `<span class="t-kw">${esc(word)}</span>`;
        else if (BI.has(word)) out += `<span class="t-bi">${esc(word)}</span>`;
        else out += esc(word);
      } else out += esc(all);
      last = m.index + all.length;
    }
    return out + esc(src.slice(last));
  }

  /** Render lines [start..] as numbered rows, highlighting the `focus` range. */
  function renderLines(lines, start, focus) {
    const html = highlight(lines.join('\n')).split('\n');
    const [fa, fb] = focus || [];
    return html.map((h, i) => {
      const no = start + i;
      const on = fa && no >= fa && no <= fb ? ' foc' : '';
      return `<span class="ln${on}"><span class="n">${no}</span>${h || ' '}</span>`;
    }).join('');
  }

  global.Atlas = global.Atlas || {};
  global.Atlas.highlight = highlight;
  global.Atlas.renderLines = renderLines;
})(window);
