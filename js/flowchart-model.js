// The story's flowchart, read out of the script itself.
//
// The script's flow section is a list of blocks: "*f<N>" plays one scene
// ("gosub *s<N>") and then leaves by a choice (select), by flags
// ("if ... goto *f<M>") or straight on ("goto *f<M>"); "goto *endofplay" ends
// the day. parseFlow() turns that into a graph and layoutFlow() places it in
// layers, top to bottom. No DOM here, so it can be tested under Node.

const ROOT = 'f500';

export function parseFlow(src) {
  const lines = src.split('\n');
  const labelLine = new Map();
  lines.forEach((l, i) => {
    const m = /^[ \t]*\*([A-Za-z0-9_]+)/.exec(l);
    if (m && !labelLine.has(m[1].toLowerCase())) labelLine.set(m[1].toLowerCase(), i);
  });
  const sorted = [...labelLine.values()].sort((a, b) => a - b);
  const nextLabel = (i) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= i) lo = mid + 1; else hi = mid; }
    return lo < sorted.length ? sorted[lo] : lines.length;
  };

  // each scene names itself in the question it asks before a re-read: This scene is "Place - Title."
  const titles = new Map();
  for (const [k, i] of labelLine) {
    if (!/^s\d+$/.test(k)) continue;
    for (let li = i + 1; li < i + 12 && li < lines.length; li++) {
      if (/^[ \t]*\*/.test(lines[li])) break;
      const m = /This scene is\s*["“](.*)$/.exec(lines[li]);
      if (m) { titles.set(k, m[1].replace(/["”]\s*$/, '').replace(/\.$/, '').trim()); break; }
    }
  }

  // blocks that leave by "goto $nextflow" go wherever an earlier block said
  const dynamic = new Set();
  for (const l of lines) {
    const m = /^[ \t]*mov\s+\$nextflow\s*,\s*"\*(f\d+)"/i.exec(l);
    if (m) dynamic.add(m[1].toLowerCase());
  }

  const nodes = new Map();
  for (const [k, i] of labelLine) {
    if (!/^f\d+$/.test(k)) continue;
    const end = nextLabel(i);
    const node = { id: k, scene: null, outs: [], ends: false, opens: [], sets: [], prog: [] };
    let conditional = false;
    // the same block as a little program, in order, for following a day through it (simulateDay)
    const effectsOf = (text) => {
      const list = [];
      for (const mm of text.matchAll(/\b(inc|add|mov)\s+%([a-z_0-9]+)(?:\s*,\s*(-?\d+))?/gi)) {
        const kind = mm[1].toLowerCase(), name = mm[2].toLowerCase();
        if (kind === 'mov' && mm[3] === undefined) continue;
        list.push(kind === 'mov' ? { name, set: parseInt(mm[3], 10) } : { name, add: kind === 'inc' ? 1 : parseInt(mm[3] || '1', 10) });
      }
      return list;
    };
    for (let li = i + 1; li < end; li++) {
      let st = lines[li].trim();
      if (!st || st[0] === ';') continue;
      let mm;
      if (/^gosub\s+\*quiz\b/i.test(st)) { node.prog.push({ op: 'quiz' }); continue; }
      if ((mm = /^mov\s+\$nextflow\s*,\s*"\*(f\d+)"/i.exec(st))) { node.prog.push({ op: 'next', to: mm[1].toLowerCase() }); continue; }
      if (/^(select|selgosub)\b/i.test(st)) {
        while (/,\s*$/.test(st) && li + 1 < end) { li++; st += ' ' + lines[li].trim(); }
        const options = [];
        for (const o of st.matchAll(/[`"]([^`"]*)[`"]\s*,\s*\*(\w+)/g)) options.push({ text: o[1].trim(), to: o[2].toLowerCase() });
        node.prog.push({ op: 'select', options });
        break;
      }
      if ((mm = /^(if|notif)\s+(.*?)\s+goto\s+\*(\w+)\s*$/i.exec(st))) { node.prog.push({ op: 'if', not: mm[1].toLowerCase() === 'notif', terms: parseCond(mm[2]), to: mm[3].toLowerCase() }); continue; }
      if ((mm = /^goto\s+\*(\w+)/i.exec(st))) { node.prog.push({ op: 'goto', to: mm[1].toLowerCase() }); break; }
      if (/^goto\s+\$nextflow/i.test(st)) { node.prog.push({ op: 'dyn' }); break; }
      if ((mm = /^(if|notif)\s+(.*?)\s+((?:inc|add|mov)\s+%.*)$/i.exec(st))) { node.prog.push({ op: 'effect', not: mm[1].toLowerCase() === 'notif', terms: parseCond(mm[2]), list: effectsOf(mm[3]) }); continue; }
      if (/^(inc|add|mov)\s+%/i.test(st)) node.prog.push({ op: 'effect', terms: [], list: effectsOf(st) });
    }
    scan:
    for (let li = i + 1; li < end; li++) {
      const s = lines[li].trim();
      if (!s || s[0] === ';') continue;
      let m;
      if ((m = /^gosub\s+\*(s\d+)\b/i.exec(s))) { if (!node.scene) node.scene = m[1].toLowerCase(); continue; }
      if ((m = /^(?:mov|inc)\s+%(yume\d\d)\b/i.exec(s))) { node.opens.push(m[1].toLowerCase()); continue; }
      // flags and counts this block raises ("inc %flgA", "notif %pointflg9>=1 inc %ren_point:inc %pointflg9", "add %ren_point,2")
      for (const mm of s.matchAll(/\b(inc|add)\s+%([a-z_0-9]+)/gi)) {
        const v = mm[2].toLowerCase();
        if (!/^(pointflg|guest_|type_|buttonno)/.test(v) && !node.sets.includes(v)) node.sets.push(v);
      }
      if (/^(inc|add|notif)\b/i.test(s)) continue;
      if (/^(select|selgosub)\b/i.test(s)) {
        let buf = s;
        while (/,\s*$/.test(buf) && li + 1 < end) { li++; buf += ' ' + lines[li].trim(); }
        const re = /[`"]([^`"]*)[`"]\s*,\s*\*(\w+)/g;
        let mm;
        while ((mm = re.exec(buf))) node.outs.push({ kind: 'choice', text: mm[1].trim().replace(/^\d+\.\s*/, ''), to: mm[2].toLowerCase() });
        break scan;
      }
      if ((m = /^if\s+(.*?)\s+goto\s+\*(\w+)\s*$/i.exec(s))) {
        node.outs.push({ kind: 'if', text: m[1].replace(/%/g, '').replace(/\s*&&\s*/g, ' and '), to: m[2].toLowerCase() });
        conditional = true;
        continue;
      }
      if ((m = /^goto\s+\*(\w+)/i.exec(s))) {
        node.outs.push({ kind: conditional ? 'else' : 'next', text: '', to: m[1].toLowerCase() });
        break scan;
      }
      if (/^goto\s+\$nextflow/i.test(s)) {
        for (const t of dynamic) node.outs.push({ kind: 'next', text: '', to: t });
        break scan;
      }
    }
    node.ends = node.outs.some((o) => o.to === 'endofplay');
    nodes.set(k, node);
  }
  for (const n of nodes.values()) n.outs = n.outs.filter((o) => nodes.has(o.to));
  const setters = new Map();
  for (const n of nodes.values()) for (const v of n.sets) { if (!setters.has(v)) setters.set(v, []); setters.get(v).push(n.id); }
  // what the end of a day puts back to nothing ("*endofplay": mov %ark_point,0 ...)
  const resets = [];
  if (labelLine.has('endofplay')) {
    for (let li = labelLine.get('endofplay') + 1; li < nextLabel(labelLine.get('endofplay')); li++) {
      const m = /^[ \t]*mov\s+%([a-z_0-9]+)\s*,\s*0\b/i.exec(lines[li]);
      if (m) resets.push(m[1].toLowerCase());
    }
  }
  return { nodes, titles, setters, resets, root: nodes.has(ROOT) ? ROOT : null };
}

export function parseCond(text) {
  const out = [];
  for (const m of text.matchAll(/([A-Za-z_][A-Za-z_0-9]*)\s*(>=|<=|==|!=|<>|=|<|>)\s*(\d+)/g)) out.push({ name: m[1].toLowerCase(), op: m[2], n: parseInt(m[3], 10) });
  return out;
}

// "School - Morning" -> zone "School", name "Morning"
export function splitTitle(title) {
  if (!title) return { zone: '', name: '' };
  const m = /^([A-Za-z' ]{3,22}?)\s*(?:-|:|–|—)\s+(.+)$/.exec(title);
  if (!m) return { zone: '', name: title };
  return { zone: m[1].trim(), name: m[2].trim() };
}
const ZONES = ['morning', 'school', 'mansion', 'street', 'night'];
export function zoneKey(zone) {
  const z = zone.toLowerCase();
  for (const k of ZONES) if (z.includes(k)) return k;
  if (/festival|sports|classroom|tea room|courtyard|cafeteria|lunch|period/.test(z)) return 'school';
  if (/home|room|garden|lobby|detached|forest/.test(z)) return 'mansion';
  if (/park|alley|town|station|road|shop|hospital/.test(z)) return 'street';
  if (/evening|midnight|dream|dawn/.test(z)) return 'night';
  return 'other';
}

const SIZE = { scene: { w: 178, h: 54 }, gate: { w: 26, h: 26 }, bend: { w: 4, h: 0 } };
const GAP = { real: 26, bend: 9 };
const LAYER_H = 104;
const MARGIN = 70;

export function layoutFlow(model, opts = {}) {
  const { nodes, titles } = model;
  if (!model.root) return { nodes: [], edges: [], width: 0, height: 0 };

  // reachable part, with the edges that close a loop set aside
  const state = new Map();
  const order = [];
  const edges = [];
  const visit = (id) => {
    state.set(id, 1);
    for (const o of nodes.get(id).outs) {
      const st = state.get(o.to);
      if (st === 1) continue;                     // would close a loop
      edges.push({ from: id, to: o.to, kind: o.kind, text: o.text });
      if (st === undefined) visit(o.to);
    }
    state.set(id, 2);
    order.push(id);
  };
  // (iterative to be safe with deep chains)
  const stack = [[model.root, 0]];
  const found = new Map([[model.root, 0]]);       // the order blocks are first met in, to seed each row
  state.set(model.root, 1);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const outs = nodes.get(top[0]).outs;
    if (top[1] < outs.length) {
      const o = outs[top[1]++];
      const st = state.get(o.to);
      if (st === 1) continue;
      edges.push({ from: top[0], to: o.to, kind: o.kind, text: o.text });
      if (st === undefined) { state.set(o.to, 1); found.set(o.to, found.size); stack.push([o.to, 0]); }
    } else {
      state.set(top[0], 2);
      order.push(top[0]);
      stack.pop();
    }
  }
  void visit;
  order.reverse();                                // topological order

  // layer = longest way down from the first block
  const layer = new Map(order.map((id) => [id, 0]));
  const outOf = new Map(order.map((id) => [id, []]));
  for (const e of edges) outOf.get(e.from).push(e);
  for (const id of order) for (const e of outOf.get(id)) if (layer.get(e.to) < layer.get(id) + 1) layer.set(e.to, layer.get(id) + 1);

  // ---- bands (the day's chart): morning across the top, the three places as columns, night along the foot
  const COLS = ['school', 'mansion', 'street'];
  let band = null, topMax = -1, dayFloor = 0, nightFloor = 0;
  if (opts.bands) {
    const inOf = new Map(order.map((id) => [id, []]));
    for (const e of edges) inOf.get(e.to).push(e.from);
    const zone = new Map();
    for (const id of order) {
      const n = nodes.get(id);
      const zk = n.scene ? zoneKey(splitTitle(titles.get(n.scene) || '').zone || titles.get(n.scene) || '') : 'other';
      zone.set(id, zk === 'other' ? null : zk);
    }
    // blocks without a place of their own take their neighbours'
    for (let pass = 0; pass < 6; pass++) {
      for (const id of order) {
        if (zone.get(id)) continue;
        const votes = {};
        for (const e of outOf.get(id)) { const v = zone.get(e.to); if (v) votes[v] = (votes[v] || 0) + 1; }
        for (const f of inOf.get(id)) { const v = zone.get(f); if (v) votes[v] = (votes[v] || 0) + 1; }
        const best = Object.entries(votes).sort((p, q) => q[1] - p[1])[0];
        if (best) zone.set(id, best[0]);
      }
    }
    for (const id of order) if (zone.get(id) === 'morning') topMax = Math.max(topMax, layer.get(id));
    // night proper: night scenes from which only night follows; an evening scene that leads back
    // into a place stays in that place's column
    const pure = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      pure.set(id, zone.get(id) === 'night' && outOf.get(id).every((e) => pure.get(e.to)));
    }
    band = new Map();
    for (const id of order) {
      if (zone.get(id) === 'morning' || layer.get(id) <= topMax) band.set(id, 'top');
      else if (pure.get(id)) band.set(id, 'bottom');
      else if (COLS.includes(zone.get(id))) band.set(id, zone.get(id));
    }
    for (let pass = 0; pass < 4; pass++) {
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        if (band.get(id)) continue;
        const votes = {};
        for (const e of outOf.get(id)) { const v = band.get(e.to); if (COLS.includes(v)) votes[v] = (votes[v] || 0) + 1; }
        for (const f of inOf.get(id)) { const v = band.get(f); if (COLS.includes(v)) votes[v] = (votes[v] || 0) + 0.5; }
        const best = Object.entries(votes).sort((p, q) => q[1] - p[1])[0];
        if (best) band.set(id, best[0]);
      }
    }
    for (const id of order) if (!band.get(id)) band.set(id, 'mansion');
    // each band starts below the one before it
    const relayer = () => {
      for (const id of order) layer.set(id, 0);
      for (const id of order) {
        const b = band.get(id);
        const l = Math.max(layer.get(id), b === 'top' ? 0 : b === 'bottom' ? nightFloor : dayFloor);
        layer.set(id, l);
        for (const e of outOf.get(id)) if (layer.get(e.to) < l + 1) layer.set(e.to, l + 1);
      }
    };
    relayer();
    topMax = Math.max(0, ...order.filter((id) => band.get(id) === 'top').map((id) => layer.get(id)));
    dayFloor = topMax + 1;
    relayer();
    nightFloor = Math.max(dayFloor, ...order.filter((id) => COLS.includes(band.get(id))).map((id) => layer.get(id))) + 1;
    relayer();
  }
  const bandAt = (l, from, to) => {
    if (!band) return 'all';
    if (l <= topMax) return 'top';
    if (l >= nightFloor) return 'bottom';
    const a = band.get(from), z = band.get(to);
    return COLS.includes(a) ? a : COLS.includes(z) ? z : 'mansion';
  };
  const groupIndex = (b) => (b === 'school' ? 0 : b === 'mansion' ? 1 : b === 'street' ? 2 : 0);

  // boxes
  const boxes = new Map();
  const preorder = new Map();
  [...order].forEach((id, i) => preorder.set(id, i));
  for (const id of order) {
    const n = nodes.get(id);
    const title = n.scene ? titles.get(n.scene) || '' : '';
    const st = n.name ? { zone: n.zone || '', name: n.name } : splitTitle(title);
    const kind = n.scene ? 'scene' : 'gate';
    boxes.set(id, {
      id, kind, scene: n.scene, title, zone: st.zone, name: st.name, zoneKey: n.zoneKey || (n.scene ? zoneKey(st.zone || title) : 'other'),
      ends: n.ends, layer: layer.get(id), w: SIZE[kind].w, h: SIZE[kind].h, x: 0, y: 0, up: [], down: [],
      band: band ? band.get(id) : 'all',
    });
  }

  // an edge that crosses several layers gets a bend in each, so it is routed between boxes
  const layers = [];
  const put = (b) => { (layers[b.layer] || (layers[b.layer] = [])).push(b); };
  for (const id of order) put(boxes.get(id));
  let bends = 0;
  const routed = [];
  for (const e of edges) {
    const a = boxes.get(e.from), z = boxes.get(e.to);
    const chain = [a];
    for (let l = a.layer + 1; l < z.layer; l++) {
      const b = { id: 'b' + bends++, kind: 'bend', layer: l, w: SIZE.bend.w, h: 0, x: 0, y: 0, up: [], down: [], seed: found.get(e.from) + 0.5, band: bandAt(l, e.from, e.to) };
      put(b);
      chain.push(b);
    }
    chain.push(z);
    for (let i = 0; i + 1 < chain.length; i++) { chain[i].down.push(chain[i + 1]); chain[i + 1].up.push(chain[i]); }
    routed.push({ from: e.from, to: e.to, kind: e.kind, text: e.text, chain });
  }

  // order within layers: start from the walk order, then pull towards neighbours
  for (let l = 0; l < layers.length; l++) if (!layers[l]) layers[l] = [];
  for (const row of layers) {
    for (const b of row) { if (b.seed === undefined) b.seed = found.get(b.id); b.g = groupIndex(b.band); }
    row.sort((p, q) => p.g - q.g || p.seed - q.seed);
    row.forEach((b, i) => { b.pos = i; });
  }
  // Only blocks that have neighbours on that side are re-ordered, among the places they already
  // hold; the others stay put. (Mixing a neighbour's place with a block's own place in one sort
  // would drag a lone parent to wherever its children happen to stand.)
  const sweep = (rows, side) => {
    for (const row of rows) {
      for (let g = 0; g < 3; g++) {
        const slots = [], movers = [];
        row.forEach((b, i) => {
          const nb = b[side];
          if (b.g !== g || !nb.length) return;
          b.key = nb.reduce((s, o) => s + o.pos, 0) / nb.length;
          slots.push(i);
          movers.push(b);
        });
        movers.sort((p, q) => p.key - q.key || p.pos - q.pos);
        slots.forEach((slot, k) => { row[slot] = movers[k]; });
      }
      row.forEach((b, i) => { b.pos = i; });
    }
  };
  for (let it = 0; it < 12; it++) {
    sweep(layers.slice(1), 'up');
    sweep(layers.slice(0, -1).reverse(), 'down');
  }

  // x: pack, then relax towards neighbours while keeping the order and the gaps. With bands, each
  // place has a column of its own (as wide as its widest row) and its blocks stay inside it.
  const sep = (p, q) => (p.w + q.w) / 2 + (p.kind === 'bend' && q.kind === 'bend' ? GAP.bend : p.kind === 'bend' || q.kind === 'bend' ? 14 : GAP.real);
  const segmentsOf = (row) => {
    const segs = [];
    for (const b of row) {
      const key = band && b.band !== 'top' && b.band !== 'bottom' ? b.band : 'wide';
      if (!segs.length || segs[segs.length - 1].key !== key) segs.push({ key, items: [] });
      segs[segs.length - 1].items.push(b);
    }
    return segs;
  };
  const packed = (items) => { let w = 0; items.forEach((b, i) => { w += i ? sep(items[i - 1], b) : 0; }); return w + (items.length ? (items[0].w + items[items.length - 1].w) / 2 : 0); };
  const COL_PAD = 46, COL_GAP = 54;
  const span = {};      // key -> [x0, x1]
  if (band) {
    let x = 0;
    for (const c of COLS) {
      let w = SIZE.scene.w;
      for (const row of layers) for (const seg of segmentsOf(row)) if (seg.key === c) w = Math.max(w, packed(seg.items));
      span[c] = [x, x + w + COL_PAD * 2];
      x += w + COL_PAD * 2 + COL_GAP;
    }
    let wide = x - COL_GAP;
    for (const row of layers) for (const seg of segmentsOf(row)) if (seg.key === 'wide') wide = Math.max(wide, packed(seg.items) + COL_PAD * 2);
    const shift = (wide - (x - COL_GAP)) / 2;
    for (const c of COLS) { span[c][0] += shift; span[c][1] += shift; }
    span.wide = [0, wide];
  }
  const place = (items, lo, hi, want) => {
    // lowest and highest centre each block may take, packed from either end
    const n = items.length, min = [], max = [];
    for (let i = 0; i < n; i++) min[i] = i ? min[i - 1] + sep(items[i - 1], items[i]) : lo + items[0].w / 2;
    for (let i = n - 1; i >= 0; i--) max[i] = i < n - 1 ? max[i + 1] - sep(items[i], items[i + 1]) : hi - items[n - 1].w / 2;
    const w = items.map((b, i) => Math.min(Math.max(want ? want[i] : (min[i] + max[i]) / 2, min[i]), Math.max(min[i], max[i])));
    const left = [], right = [];
    for (let i = 0; i < n; i++) left[i] = i ? Math.max(w[i], left[i - 1] + sep(items[i - 1], items[i])) : w[i];
    for (let i = n - 1; i >= 0; i--) right[i] = i < n - 1 ? Math.min(w[i], right[i + 1] - sep(items[i], items[i + 1])) : w[i];
    items.forEach((b, i) => { b.x = (left[i] + right[i]) / 2; });
  };
  const bounds = (seg) => (band ? [span[seg.key][0] + COL_PAD, span[seg.key][1] - COL_PAD] : [-1e9, 1e9]);
  for (const row of layers) {
    for (const seg of segmentsOf(row)) {
      const [lo, hi] = bounds(seg);
      if (band) place(seg.items, lo, hi, null);
      else { let x = 0; seg.items.forEach((b, i) => { x += i ? sep(seg.items[i - 1], b) : 0; b.x = x; }); const sh = x / 2; for (const b of seg.items) b.x -= sh; }
    }
  }
  const relax = (row, sides) => {
    for (const seg of segmentsOf(row)) {
      const want = seg.items.map((b) => {
        let sum = 0, n = 0;
        for (const side of sides) for (const o of b[side]) { sum += o.x; n++; }
        return n ? sum / n : b.x;
      });
      const [lo, hi] = bounds(seg);
      place(seg.items, lo, hi, want);
    }
  };
  for (let it = 0; it < 10; it++) {
    for (let l = 1; l < layers.length; l++) relax(layers[l], ['up']);
    for (let l = layers.length - 2; l >= 0; l--) relax(layers[l], ['down']);
    for (let l = 0; l < layers.length; l++) relax(layers[l], ['up', 'down']);
  }

  let minX = Infinity, maxX = -Infinity;
  for (const row of layers) for (const b of row) { minX = Math.min(minX, b.x - b.w / 2); maxX = Math.max(maxX, b.x + b.w / 2); }
  if (band) { minX = Math.min(minX, 0); maxX = Math.max(maxX, span.wide[1]); }
  for (const row of layers) for (const b of row) { b.x += MARGIN - minX; b.y = MARGIN + b.layer * LAYER_H; }

  // the bands themselves, for the page to tint and name
  const bands = [];
  if (band) {
    const yOf = (l) => MARGIN + l * LAYER_H;
    const last = layers.length - 1;
    const rect = (key, label, x0, x1, l0, l1) => bands.push({ key, label, x: x0 + MARGIN - minX, y: yOf(l0) - 34, w: x1 - x0, h: yOf(l1) - yOf(l0) + SIZE.scene.h + 68 });
    rect('morning', 'Morning', span.wide[0], span.wide[1], 0, topMax);
    if (nightFloor - 1 >= dayFloor) for (const c of COLS) rect(c, c[0].toUpperCase() + c.slice(1), span[c][0], span[c][1], dayFloor, nightFloor - 1);
    if (last >= nightFloor) rect('night', 'Night', span.wide[0], span.wide[1], nightFloor, last);
  }

  const out = [];
  for (const id of order) {
    const b = boxes.get(id);
    const src = nodes.get(id);
    out.push({ id, kind: b.kind, scene: b.scene, title: b.title, zone: b.zone, name: b.name, zoneKey: b.zoneKey, ends: b.ends, x: b.x, y: b.y, w: b.w, h: b.h, outs: [],
      opens: src.opens || [], sets: src.sets || [], flag: src.flag || null, fin: src.fin || null, openedBy: src.openedBy || [] });
  }
  const byId = new Map(out.map((n) => [n.id, n]));
  const outEdges = routed.map((r) => {
    const e = { from: r.from, to: r.to, kind: r.kind, text: r.text, points: r.chain.map((b) => [b.x, b.y]) };
    byId.get(r.from).outs.push(e);
    return e;
  });
  return { nodes: out, byId, edges: outEdges, bands, setters: model.setters || new Map(),
    width: maxX - minX + MARGIN * 2, height: MARGIN * 2 + (layers.length - 1) * LAYER_H + SIZE.scene.h };
}

// ---------------------------------------------------------------------- side stories
// The two lists on the game-start page. Each entry is a block "*yume<NN>" or
// "*summer_<who>" that plays one scene; the seventh dream ends one of three ways.
// A dream is opened by a flag (%yume<NN>) that blocks of the day set, and counts
// as read once %fin_yume<NN> is set; the festivals open together once every
// dream has been read.
const DREAMS = ['Good luck, Ciel-sensei', 'A Story for the Evening', 'Crimson Moon', 'Red Demon God', 'Nanako-chan SOS!',
  'Imogirisou', 'Flower of Thanatos', 'Hisui-chan, Inversion Impulse!', 'The Tohno Family Con Game', 'Dawn'];
const FESTIVALS = [['summer_ark', 'Arcueid'], ['summer_ciel', 'Ciel'], ['summer_akiha', 'Akiha'], ['summer_hisui', 'Hisui'], ['summer_kohaku', 'Kohaku']];

function sideBlock(lines, labelLine, label) {
  const i = labelLine.get(label);
  if (i === undefined) return null;
  const out = { scene: null, choices: [] };
  for (let li = i + 1; li < lines.length && li < i + 40; li++) {
    const s = lines[li].trim();
    if (/^\*/.test(s)) break;
    let m;
    if (!out.scene && (m = /^gosub\s+\*(s\d+)\b/i.exec(s))) { out.scene = m[1].toLowerCase(); continue; }
    if (/^(select|selgosub)\b/i.test(s)) {
      let buf = s;
      while (/,\s*$/.test(buf) && li + 1 < lines.length) { li++; buf += ' ' + lines[li].trim(); }
      const re = /[`"]([^`"]*)[`"]\s*,\s*\*(s\d+)/g;
      let mm;
      while ((mm = re.exec(buf))) out.choices.push({ text: mm[1].trim().replace(/^\d+\.\s*/, ''), scene: mm[2].toLowerCase() });
    }
    if (/^goto\b/i.test(s)) break;
  }
  return out.scene ? out : null;
}

export function sideStories(src, flow) {
  const lines = src.split('\n');
  const labelLine = new Map();
  lines.forEach((l, i) => {
    const m = /^[ \t]*\*([A-Za-z0-9_]+)/.exec(l);
    if (m && !labelLine.has(m[1].toLowerCase())) labelLine.set(m[1].toLowerCase(), i);
  });
  const openedBy = new Map();
  for (const n of flow.nodes.values()) for (const v of n.opens) { if (!openedBy.has(v)) openedBy.set(v, []); openedBy.get(v).push(n.id); }

  const build = (entries, zoneKeyName, zoneLabel) => {
    const nodes = new Map();
    const root = { id: 'list', scene: null, outs: [], ends: false };
    nodes.set('list', root);
    for (const e of entries) {
      const b = sideBlock(lines, labelLine, e.label);
      if (!b) continue;
      const node = { id: e.label, scene: b.scene, outs: [], ends: false, name: e.name, zone: zoneLabel, zoneKey: zoneKeyName,
        flag: e.flag, fin: e.fin, openedBy: openedBy.get(e.label) || [] };
      for (const c of b.choices) {
        const id = e.label + ':' + c.scene;
        nodes.set(id, { id, scene: c.scene, outs: [], ends: false, name: c.text, zone: e.name, zoneKey: zoneKeyName, flag: e.flag, fin: null, openedBy: [] });
        node.outs.push({ kind: 'choice', text: c.text, to: id });
      }
      nodes.set(e.label, node);
      root.outs.push({ kind: 'next', text: '', to: e.label });
    }
    return layoutFlow({ nodes, titles: new Map(), root: 'list' });
  };

  const dreams = DREAMS.map((name, i) => {
    const nn = String(i + 1).padStart(2, '0');
    return { label: 'yume' + nn, name, flag: 'yume' + nn, fin: 'fin_yume' + nn };
  });
  const fests = FESTIVALS.map(([label, name]) => ({ label, name, flag: 'finish_yume', fin: 'finish_' + label }));
  return [
    { key: 'yume', label: 'Ten Nights of Dream', note: 'Each dream is opened by something that happens in the day.', chart: build(dreams, 'dream', 'Ten Nights of Dream') },
    { key: 'summer', label: 'Summer Festivals', note: 'These open once all ten dreams have been read.', chart: build(fests, 'summer', 'Summer Festivals') },
  ].filter((t) => t.chart.nodes.length > 1);
}

// ---------------------------------------------------------------------- following a day
// Walks one day through the flow: flags and counts as each block changes them, branches as
// they would fall, and `choose(optionTexts, blockId)` for each choice (-1 stops the walk there).
// `getVar(name)` gives a value as it stands when the day begins. Returns the blocks passed.
export function simulateDay(model, getVar, choose, opts = {}) {
  const vars = new Map();
  const get = (n) => (vars.has(n) ? vars.get(n) : getVar(n) | 0);
  const test = (terms, not) => terms.every((t) => {
    const v = get(t.name);
    const ok = t.op === '>=' ? v >= t.n : t.op === '<=' ? v <= t.n : t.op === '>' ? v > t.n : t.op === '<' ? v < t.n
      : t.op === '!=' || t.op === '<>' ? v !== t.n : v === t.n;
    return not ? !ok : ok;
  });
  const path = [];
  let id = model.root, next = null;
  for (let guard = 0; id && model.nodes.has(id) && guard < 400; guard++) {
    path.push(id);
    let to = null;
    for (const op of model.nodes.get(id).prog) {
      if (op.op === 'effect') {
        if (op.terms.length && !test(op.terms, op.not)) continue;
        for (const e of op.list) vars.set(e.name, e.set !== undefined ? e.set : get(e.name) + e.add);
      } else if (op.op === 'quiz') vars.set('answer_point', opts.quizPass ? 10 : 0);
      else if (op.op === 'next') next = op.to;
      else if (op.op === 'if') { if (test(op.terms, op.not)) { to = op.to; break; } }
      else if (op.op === 'goto') { to = op.to; break; }
      else if (op.op === 'dyn') { to = next; break; }
      else if (op.op === 'select') {
        const i = choose(op.options.map((o) => o.text), id);
        if (i < 0 || !op.options[i]) return { path, vars, stopped: id };
        to = op.options[i].to;
        break;
      }
    }
    if (!to || to === 'endofplay' || !model.nodes.has(to)) return { path, vars, ended: to === 'endofplay' };
    id = to;
  }
  return { path, vars };
}
