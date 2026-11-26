// 工程表の読み取り（第1段階の続き：日付と行の読み取り）
//
// PDF.js の文字データ（getTextContent）と描画命令（getOperatorList）から、
//   ・日付の列：何年何月何日の列が、x座標のどこからどこまでか
//   ・行：行の境目（y座標）と、各行の左側の項目名（＋左端の縦書きのまとまり名）
// を求める。
//
// 特定の建築会社の形式に決め打ちしない。前提にしているのは次の「よくある作り」だけ：
//   1. 日付は「1日＝1列」で横に並び、日の数字（23 24 25 … 31 1 2 …）が1行に並ぶ
//   2. 月（10月 など）と曜日（金 土 日 …）の行が、日の行の近くにある（なくても動く）
//   3. 日付の列より左に項目名がある
//   4. 罫線があれば使う（なければ文字の位置だけで推定する）
// 座標はすべて「PDFの pt、ページ左上が原点、下向きが +y」。

const WD = "日月火水木金土";
const MIN_COLS = 5;   // 日付の並びとみなす最小の列数
const THIN = 1.6;     // これより細い塗りつぶしは「線」とみなす（pt）
const MIN_LINE = 3;   // これより短い線は無視する（pt）

/**
 * 1ページを読み取る。
 * @param page      PDF.js の PDFPageProxy
 * @param pdfjsLib  PDF.js 本体（OPS を使う）
 * @param options   { year: number|null } year＝工程表の最初の月の年。null なら自動で推定する
 *                  （将来、画面の入力欄から指定できるようにするための入口）
 */
export async function analyzePage(page, pdfjsLib, options = {}) {
  const vp = page.getViewport({ scale: 1 });
  const warnings = [];

  const tc = await page.getTextContent();
  const tokens = buildTokens(tc.items, vp);

  let lines = { h: [], v: [] };
  try {
    const opList = await page.getOperatorList();
    lines = extractLines(opList, vp, pdfjsLib.OPS);
  } catch (err) {
    warnings.push("罫線の読み取りに失敗しました：" + (err && err.message || err));
  }

  const dates = detectDates(tokens, lines, options, warnings);
  const rows = dates ? detectRows(tokens, lines, dates, warnings) : null;

  return {
    width: vp.width,
    height: vp.height,
    textCount: tokens.length,
    lineCount: { h: lines.h.length, v: lines.v.length },
    dates,
    rows,
    warnings,
  };
}

// ======================================================================
// 文字データ → 「語」（空白で区切った単位）に分け、ページ上の位置をつける
// ======================================================================

// 文字幅の見積り（em）。PDF.js は離れたセルの文字を1つにまとめることがあるため、
// 空白で分けたあと、各語の位置をこの見積りで割り振る（あとで罫線に合わせて補正する）。
function charEm(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0xff61 && c <= 0xff9f) return 0.5; // 半角カナ
  if (c < 0x1100) return 0.55;                 // 英数字・記号
  return 1;                                    // 全角
}

function mul(a, b) { // b を先に、a を後に適用する変換（PDF.js の Util.transform と同じ）
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function ap(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function buildTokens(items, vp) {
  const out = [];
  for (const it of items) {
    if (!it || typeof it.str !== "string" || !it.str.trim()) continue;
    const tx = mul(vp.transform, it.transform);
    // 回転した文字（縦向きの配置）は今回は扱わない。縦書きセルは1文字ずつ横書きで出るのが普通。
    if (Math.abs(tx[1]) > Math.abs(tx[0]) + 1e-6 || tx[0] <= 0) continue;
    const h = Math.hypot(tx[2], tx[3]) || it.height || 1;
    const base = tx[5];
    const x0 = tx[4];
    const W = Math.max(0, (it.width || 0) * vp.scale);

    // 空白で区切る
    const runs = [];
    for (const ch of it.str) {
      const sp = /\s/.test(ch);
      const last = runs[runs.length - 1];
      if (last && last.space === sp) last.text += ch;
      else runs.push({ space: sp, text: ch });
    }
    const words = runs.filter((r) => !r.space);
    if (!words.length) continue;
    if (runs.length === 1) {
      out.push(makeToken(runs[0].text, x0, x0 + W, base, h));
      continue;
    }
    let inkEm = 0;
    let spaceRuns = 0;
    for (const r of runs) {
      if (r.space) spaceRuns++;
      else for (const ch of r.text) inkEm += charEm(ch);
    }
    let k = 1;
    let gapW;
    if (spaceRuns > 0 && W > inkEm * h) {
      gapW = (W - inkEm * h) / spaceRuns;
    } else {
      // 見積りが合わない → 全体を比例で割り振る
      const totalEm = inkEm + spaceRuns * 0.5;
      k = totalEm > 0 ? W / (totalEm * h) : 0;
      gapW = 0.5 * h * k;
    }
    let x = x0;
    for (const r of runs) {
      if (r.space) { x += gapW; continue; }
      let w = 0;
      for (const ch of r.text) w += charEm(ch) * h * k;
      out.push(makeToken(r.text, x, x + w, base, h));
      x += w;
    }
  }
  return out;
}

function makeToken(str, x0, x1, base, h) {
  return {
    str,
    norm: str.normalize("NFKC").trim(), // 全角数字「１２月」→「12月」など
    x0, x1, cx: (x0 + x1) / 2,
    base, h,
    top: base - 0.85 * h,
    bottom: base + 0.15 * h,
    cy: base - 0.35 * h,
  };
}

// ======================================================================
// 描画命令 → 水平線・垂直線（罫線）
// ======================================================================

function extractLines(opList, vp, OPS) {
  const { fnArray, argsArray } = opList;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = [];
  const segsH = [];
  const segsV = [];

  function addSeg(a, b) {
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dy <= 0.3 && dx >= MIN_LINE) segsH.push({ y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
    else if (dx <= 0.3 && dy >= MIN_LINE) segsV.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
  }

  function addPath(args) {
    const ops = args[0];
    const c = args[1];
    if (!ops || !c) return;
    const m = mul(vp.transform, ctm);
    let j = 0;
    let cur = null;
    const start = (p) => { cur = { pts: [p], closed: false, curve: false }; pending.push(cur); };
    for (const op of ops) {
      if (op === OPS.moveTo) { start(ap(m, c[j], c[j + 1])); j += 2; }
      else if (op === OPS.lineTo) {
        const p = ap(m, c[j], c[j + 1]); j += 2;
        if (cur) cur.pts.push(p); else start(p);
      } else if (op === OPS.curveTo) {
        const p = ap(m, c[j + 4], c[j + 5]); j += 6;
        if (cur) { cur.pts.push(p); cur.curve = true; } else start(p);
      } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
        const p = ap(m, c[j + 2], c[j + 3]); j += 4;
        if (cur) { cur.pts.push(p); cur.curve = true; } else start(p);
      } else if (op === OPS.rectangle) {
        const x = c[j], y = c[j + 1], w = c[j + 2], h = c[j + 3]; j += 4;
        pending.push({ pts: [ap(m, x, y), ap(m, x + w, y), ap(m, x + w, y + h), ap(m, x, y + h)], closed: true, curve: false });
        cur = null;
      } else if (op === OPS.closePath) {
        if (cur) cur.closed = true;
      }
    }
  }

  function commit(stroke, fill) {
    for (const sp of pending) {
      if (sp.curve) continue;
      const pts = sp.pts;
      if (fill && pts.length >= 3) {
        // Excel 由来のPDFは、罫線を「細い塗りつぶしの四角」で描くことが多い
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const w = x1 - x0, h = y1 - y0;
        if (w <= THIN && h >= MIN_LINE) segsV.push({ x: (x0 + x1) / 2, y0, y1 });
        else if (h <= THIN && w >= MIN_LINE) segsH.push({ y: (y0 + y1) / 2, x0, x1 });
      }
      if (stroke) {
        const n = pts.length;
        const count = sp.closed ? n : n - 1;
        for (let k = 0; k < count; k++) addSeg(pts[k], pts[(k + 1) % n]);
      }
    }
    pending = [];
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: if (stack.length) ctm = stack.pop(); break;
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd: if (stack.length) ctm = stack.pop(); break;
      case OPS.constructPath: addPath(args); break;
      case OPS.stroke: case OPS.closeStroke: commit(true, false); break;
      case OPS.fill: case OPS.eoFill: commit(false, true); break;
      case OPS.fillStroke: case OPS.eoFillStroke:
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: commit(true, true); break;
      case OPS.endPath: pending = []; break;
      default: break;
    }
  }

  return {
    h: mergeSegs(segsH, "y", "x0", "x1"),
    v: mergeSegs(segsV, "x", "y0", "y1"),
  };
}

// 同じ高さ（同じ横位置）にあり、つながっている線を1本にまとめる
function mergeSegs(segs, pos, a, b) {
  const out = [];
  for (const g of clusterBy(segs, (s) => s[pos], () => 0.8)) {
    const items = g.items.sort((s, t) => s[a] - t[a]);
    let cur = null;
    for (const s of items) {
      if (cur && s[a] <= cur[b] + 1.5) cur[b] = Math.max(cur[b], s[b]);
      else { cur = { [pos]: g.key, [a]: s[a], [b]: s[b] }; out.push(cur); }
    }
  }
  return out;
}

// ======================================================================
// 日付の列
// ======================================================================

function isNext(a, b) {
  return b === a + 1 || (b === 1 && a >= 28);
}

function detectDates(tokens, lines, options, warnings) {
  // 1) 日の候補：「23」「23日」「10/23」「23(金)」など
  const dayCands = [];
  for (const t of tokens) {
    const m = /^(?:(\d{1,2})\/)?(\d{1,2})日?(?:\(?([日月火水木金土])\)?)?$/.exec(t.norm);
    if (!m) continue;
    const day = +m[2];
    const month = m[1] ? +m[1] : null;
    if (day < 1 || day > 31 || (month !== null && (month < 1 || month > 12))) continue;
    dayCands.push({ tok: t, cx: t.cx, day, month, wd: m[3] ? WD.indexOf(m[3]) : null });
  }

  // 2) 同じ高さの行ごとに、「1日ずつ増える・ほぼ等間隔」の一番長い並びを探す
  let best = null;
  for (const g of clusterBy(dayCands, (c) => c.tok.base, (c) => c.tok.h * 0.5)) {
    if (g.items.length < MIN_COLS) continue;
    const list = g.items.sort((p, q) => p.cx - q.cx);
    const dxs = [];
    for (let i = 1; i < list.length; i++) {
      const dx = list[i].cx - list[i - 1].cx;
      if (dx > 0 && isNext(list[i - 1].day, list[i].day)) dxs.push(dx);
    }
    const pitch0 = median(dxs);
    if (!pitch0) continue;
    const chain = bestChain(list, pitch0);
    if (chain.length >= MIN_COLS && (!best || chain.length > best.chain.length)) best = { chain };
  }
  if (!best) {
    warnings.push("日付（1日ずつ並んだ日の数字）の行が見つかりませんでした。");
    return null;
  }
  const chain = best.chain;
  const n = chain.length;
  const pitch = (chain[n - 1].cx - chain[0].cx) / (n - 1);
  const dayToks = chain.filter((c) => c.tok).map((c) => c.tok);
  const dayBase = median(dayToks.map((t) => t.base));
  const dayH = median(dayToks.map((t) => t.h));

  // 3) 曜日の行（日の行の近く）
  const wdCands = [];
  for (const t of tokens) {
    const m = /^\(?([日月火水木金土])(?:曜日?)?\)?$/.exec(t.norm);
    if (m) wdCands.push({ tok: t, cx: t.cx, wd: WD.indexOf(m[1]) });
  }
  let wdBest = null;
  for (const g of clusterBy(wdCands, (c) => c.tok.base, (c) => c.tok.h * 0.5)) {
    const dist = Math.abs(g.key - dayBase);
    if (dist < dayH * 0.3 || dist > dayH * 4) continue;
    const map = new Array(n).fill(null);
    let score = 0;
    for (const c of g.items) {
      const i = nearestIndex(chain, c.cx, pitch * 0.45);
      if (i >= 0 && !map[i]) { map[i] = c; score++; }
    }
    if (score >= n * 0.5 && (!wdBest || score > wdBest.score)) wdBest = { map, score, base: g.key };
  }

  // 4) 列の境目：文字の中心の中間 → 近くに縦の罫線があればそこに合わせる
  let bounds = [chain[0].cx - pitch / 2];
  for (let i = 1; i < n; i++) bounds.push((chain[i - 1].cx + chain[i].cx) / 2);
  bounds.push(chain[n - 1].cx + pitch / 2);
  const probes = [dayBase - 0.35 * dayH];
  if (wdBest) probes.push(wdBest.base - 0.35 * dayH);
  const vxs = lines.v
    .filter((l) => probes.some((y) => l.y0 <= y + 0.5 && l.y1 >= y - 0.5))
    .map((l) => l.x);
  let snapped = 0;
  bounds = bounds.map((b) => {
    let bx = null;
    let bd = pitch * 0.35;
    for (const x of vxs) {
      const d = Math.abs(x - b);
      if (d < bd) { bd = d; bx = x; }
    }
    if (bx === null) return b;
    snapped++;
    return bx;
  });
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] <= bounds[i - 1] + pitch * 0.3) {
      warnings.push(`列の境目が詰まりすぎている箇所があります（${i}列目付近）。`);
      break;
    }
  }

  // 5) 月：日が小さくなる所で「月の区切り」とし、各区切りに月の見出しを当てはめる
  const segs = [];
  let s0 = 0;
  for (let i = 1; i < n; i++) {
    if (chain[i].day < chain[i - 1].day) { segs.push({ start: s0, end: i - 1, labels: [] }); s0 = i; }
  }
  segs.push({ start: s0, end: n - 1, labels: [] });

  const monthToks = [];
  for (const t of tokens) {
    const m = /^(?:(\d{4})年)?(\d{1,2})月$/.exec(t.norm);
    if (!m) continue;
    const mo = +m[2];
    if (mo < 1 || mo > 12) continue;
    const dist = Math.abs(t.base - dayBase);
    if (dist < dayH * 0.3 || dist > dayH * 6) continue;
    if (t.cx < bounds[0] - pitch * 3 || t.cx > bounds[n] + pitch * 3) continue;
    monthToks.push({ tok: t, month: mo, year: m[1] ? +m[1] : null });
  }
  for (const ml of monthToks) {
    let bi = 0;
    let bd = Infinity;
    segs.forEach((sg, k) => {
      const x0 = bounds[sg.start];
      const x1 = bounds[sg.end + 1];
      const d = ml.tok.cx < x0 ? x0 - ml.tok.cx : ml.tok.cx > x1 ? ml.tok.cx - x1 : 0;
      if (d < bd) { bd = d; bi = k; }
    });
    ml.seg = bi;
    segs[bi].labels.push(ml);
  }
  segs.forEach((sg, k) => {
    const explicit = chain.slice(sg.start, sg.end + 1).find((c) => c.month);
    if (explicit) { sg.month = explicit.month; sg.src = "日付の文字"; return; }
    if (sg.labels.length) {
      sg.labels.sort((p, q) => p.tok.cx - q.tok.cx);
      const ms = new Set(sg.labels.map((l) => l.month));
      if (ms.size > 1) warnings.push(`${k + 1}番目の月の区切りに、違う月の見出しが複数あります（${[...ms].join("・")}月）。`);
      sg.month = sg.labels[0].month;
      sg.src = "月の見出し";
    } else {
      sg.month = null;
    }
  });
  for (let k = 1; k < segs.length; k++) {
    if (!segs[k].month && segs[k - 1].month) { segs[k].month = (segs[k - 1].month % 12) + 1; segs[k].src = "前の月から推定"; }
  }
  for (let k = segs.length - 2; k >= 0; k--) {
    if (!segs[k].month && segs[k + 1].month) { segs[k].month = ((segs[k + 1].month + 10) % 12) + 1; segs[k].src = "次の月から推定"; }
  }
  const monthsKnown = segs.every((sg) => sg.month);
  if (!monthsKnown) warnings.push("月が読めませんでした（「10月」のような見出しが見つからない）。日だけ表示します。");
  for (let k = 1; k < segs.length; k++) {
    const a = segs[k - 1].month, b = segs[k].month;
    if (a && b && b !== (a % 12) + 1) warnings.push(`月の並びが連続していません（${a}月の次が${b}月）。`);
  }
  // 区切りごとの年の繰り上がり（12月→1月）
  const rolls = [];
  let roll = 0;
  segs.forEach((sg, k) => {
    if (k > 0 && sg.month && segs[k - 1].month && sg.month < segs[k - 1].month) roll++;
    rolls[k] = roll;
  });

  // 6) 年：指定 → 見出しの年 → 曜日との突き合わせ → 作成日 → 今年 の順で決める
  const created = findCreatedDate(tokens);
  const wdReadAt = (i) => (chain[i].wd !== null && chain[i].wd !== undefined ? chain[i].wd : wdBest && wdBest.map[i] ? wdBest.map[i].wd : null);
  const calcWd = (firstYear, k, month, day) => {
    const y = firstYear + rolls[k];
    if (day > new Date(y, month, 0).getDate()) return null;
    return new Date(y, month - 1, day).getDay();
  };
  const scoreYear = (fy) => {
    let ok = 0;
    segs.forEach((sg, k) => {
      for (let i = sg.start; i <= sg.end; i++) {
        const r = wdReadAt(i);
        if (r !== null && sg.month && calcWd(fy, k, sg.month, chain[i].day) === r) ok++;
      }
    });
    return ok;
  };
  let wdTotal = 0;
  for (let i = 0; i < n; i++) if (wdReadAt(i) !== null) wdTotal++;
  const labelWithYear = monthToks.find((m) => m.year);
  let year;
  let yearSource;
  if (options.year) {
    year = options.year;
    yearSource = "指定";
  } else if (labelWithYear) {
    year = labelWithYear.year - rolls[labelWithYear.seg];
    yearSource = "月の見出しの年";
  } else if (monthsKnown && wdTotal >= 3) {
    const baseYear = created ? created.year : new Date().getFullYear();
    let bestY = baseYear;
    let bestS = -1;
    for (const y of [baseYear, baseYear - 1, baseYear + 1]) {
      const sc = scoreYear(y);
      if (sc > bestS) { bestS = sc; bestY = y; }
    }
    year = bestY;
    yearSource = bestS === wdTotal ? "曜日から推定（全列一致）" : `曜日から推定（${bestS}/${wdTotal}列一致）`;
    if (bestS < wdTotal * 0.8) warnings.push("曜日と日付がうまく合いません。年の指定が必要かもしれません。");
  } else if (created) {
    year = created.year;
    yearSource = "作成日の年";
  } else {
    year = new Date().getFullYear();
    yearSource = "今年（仮）";
    warnings.push("年が分からないため、仮に今年としました。");
  }

  // 7) 列の一覧
  const columns = [];
  segs.forEach((sg, k) => {
    const y = year + rolls[k];
    if (sg.month && k < segs.length - 1) {
      const dim = new Date(y, sg.month, 0).getDate();
      if (chain[sg.end].day !== dim) warnings.push(`${y}年${sg.month}月の最後の日が${chain[sg.end].day}日になっています（本来は${dim}日）。`);
    }
    for (let i = sg.start; i <= sg.end; i++) {
      const c = chain[i];
      const wdCalc = sg.month ? calcWd(year, k, sg.month, c.day) : null;
      columns.push({
        index: i,
        x0: bounds[i],
        x1: bounds[i + 1],
        cx: c.cx,
        year: sg.month ? y : null,
        month: sg.month || null,
        day: c.day,
        wdRead: wdReadAt(i),
        wdCalc,
        filled: !!c.filled,
      });
    }
  });
  const wdMismatch = columns.filter((c) => c.wdRead !== null && c.wdCalc !== null && c.wdRead !== c.wdCalc).length;
  if (wdMismatch) warnings.push(`曜日が合わない列が ${wdMismatch} 列あります（重ね表示で赤く表示）。`);

  const hdr = [...dayToks];
  if (wdBest) for (const c of wdBest.map) if (c) hdr.push(c.tok);
  for (const m of monthToks) hdr.push(m.tok);

  return {
    columns,
    pitch,
    year,
    yearSource,
    created,
    months: segs.map((sg, k) => ({
      year: sg.month ? year + rolls[k] : null,
      month: sg.month,
      src: sg.src || "不明",
      from: chain[sg.start].day,
      to: chain[sg.end].day,
      count: sg.end - sg.start + 1,
    })),
    weekdayRow: !!wdBest || chain.some((c) => c.wd !== null && c.wd !== undefined),
    wdTotal,
    wdMismatch,
    snapped,
    boundCount: bounds.length,
    filledCount: chain.filter((c) => c.filled).length,
    gridLeft: bounds[0],
    gridRight: bounds[n],
    headerTop: Math.min(...hdr.map((t) => t.top)),
    headerBottom: Math.max(...hdr.map((t) => t.bottom)),
    headerBaseMax: Math.max(...hdr.map((t) => t.base)),
  };
}

function bestChain(list, pitch) {
  let best = [];
  let cur = [];
  const entry = (c) => ({ tok: c.tok, cx: c.cx, day: c.day, month: c.month, wd: c.wd, filled: false });
  for (const c of list) {
    if (!cur.length) { cur.push(entry(c)); continue; }
    const prev = cur[cur.length - 1];
    const r = (c.cx - prev.cx) / pitch;
    if (r < 0.6) continue; // 近すぎる（同じ列にある別の数字など）→ 無視
    const k = Math.round(r);
    if (Math.abs(r - k) < 0.3) {
      if (k === 1 && isNext(prev.day, c.day)) { cur.push(entry(c)); continue; }
      if (k >= 2 && k <= 3 && c.day === prev.day + k) {
        // 日の文字が1〜2列ぶん抜けている → 等間隔として補う
        for (let s = 1; s < k; s++) {
          cur.push({ tok: null, cx: prev.cx + pitch * s, day: prev.day + s, month: null, wd: null, filled: true });
        }
        cur.push(entry(c));
        continue;
      }
    }
    if (cur.length > best.length) best = cur;
    cur = [entry(c)];
  }
  if (cur.length > best.length) best = cur;
  return best;
}

function findCreatedDate(tokens) {
  let first = null;
  for (const t of tokens) {
    const m = /((?:19|20)\d{2})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/.exec(t.norm);
    if (!m) continue;
    const d = { year: +m[1], month: +m[2], day: +m[3], text: t.str };
    if (/作成|更新|改訂|発行/.test(t.norm)) return d;
    if (!first) first = d;
  }
  return first;
}

// ======================================================================
// 行と項目名
// ======================================================================

function detectRows(tokens, lines, dates, warnings) {
  const gridLeft = dates.gridLeft;
  // 日付の列より左・見出しより下の文字
  const left = tokens.filter((t) => t.cx < gridLeft && t.cy > dates.headerBaseMax);

  // 縦書きのまとまり名（1文字ずつ縦に積まれた文字。例：第二十二アパート）
  const groupLabels = [];
  const used = new Set();
  const singles = left.filter((t) => [...t.norm].length === 1);
  for (const gx of clusterBy(singles, (t) => t.cx, (t) => Math.max(2, t.h * 0.5))) {
    const col = gx.items.sort((p, q) => p.cy - q.cy);
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        groupLabels.push({
          text: run.map((t) => t.str).join(""),
          x: median(run.map((t) => t.cx)),
          x0: Math.min(...run.map((t) => t.x0)),
          labelTop: Math.min(...run.map((t) => t.top)),
          labelBottom: Math.max(...run.map((t) => t.bottom)),
        });
        for (const t of run) used.add(t);
      }
      run = [];
    };
    for (const t of col) {
      // 1文字ぶん抜けても（回転した「ー」など）同じまとまりとみなせるよう、2.6文字ぶんまで許す
      if (run.length && t.cy - run[run.length - 1].cy > t.h * 2.6) flush();
      run.push(t);
    }
    flush();
  }
  const names = left.filter((t) => !used.has(t));
  if (!names.length) warnings.push("日付の列より左に、項目名らしい文字が見つかりませんでした。");

  const nameX0 = names.length ? Math.min(...names.map((t) => t.x0)) : gridLeft - 60;
  const span = Math.max(4, gridLeft - nameX0);
  const pA = nameX0 + span * 0.25;
  const pB = nameX0 + span * 0.75;

  // 行の境目：項目名の欄を横切る水平の罫線
  const rowLines = lines.h.filter((l) => l.x0 <= pA + 0.5 && l.x1 >= pB - 0.5 && l.y > dates.headerBaseMax);
  let ys = dedupe(rowLines.map((l) => l.y).sort((a, b) => a - b), 2);
  let method = "罫線";
  let tableLeft = rowLines.length ? Math.min(...rowLines.map((l) => l.x0)) : nameX0 - 2;

  if (ys.length < 2) {
    // 罫線が使えない → 項目名の文字の高さの並びから推定
    method = "文字の位置（罫線が見つからないため）";
    const bands = clusterBy(names, (t) => t.cy, (t) => t.h * 0.6).map((g) => ({
      top: Math.min(...g.items.map((t) => t.top)),
      bottom: Math.max(...g.items.map((t) => t.bottom)),
    }));
    ys = [];
    if (bands.length) {
      ys.push(bands[0].top - 2);
      for (let i = 1; i < bands.length; i++) ys.push((bands[i - 1].bottom + bands[i].top) / 2);
      ys.push(bands[bands.length - 1].bottom + 2);
    }
    tableLeft = nameX0 - 2;
  }

  const rows = [];
  for (let i = 0; i < ys.length - 1; i++) rows.push({ y0: ys[i], y1: ys[i + 1], toks: [] });
  let outside = 0;
  for (const t of names) {
    const r = rows.find((row) => t.cy >= row.y0 && t.cy < row.y1);
    if (r) r.toks.push(t);
    else outside++;
  }

  // まとまり名の範囲：まとまり名の欄を横切る罫線で区切る（なければ文字の中間で区切る）
  const tableTop = ys.length ? ys[0] : dates.headerBottom;
  const tableBottom = ys.length ? ys[ys.length - 1] : dates.headerBottom;
  groupLabels.sort((p, q) => p.labelTop - q.labelTop);
  for (const g of groupLabels) {
    const gys = lines.h
      .filter((l) => l.x0 <= g.x + 0.5 && l.x1 >= g.x - 0.5 && l.y >= tableTop - 1 && l.y <= tableBottom + 1)
      .map((l) => l.y);
    gys.push(tableTop, tableBottom);
    const above = gys.filter((y) => y <= g.labelTop + 0.5);
    const below = gys.filter((y) => y >= g.labelBottom - 0.5);
    g.y0 = above.length ? Math.max(...above) : tableTop;
    g.y1 = below.length ? Math.min(...below) : tableBottom;
    tableLeft = Math.min(tableLeft, g.x0 - 2);
  }
  for (let k = 1; k < groupLabels.length; k++) {
    const p = groupLabels[k - 1], g = groupLabels[k];
    if (g.y0 < p.y1 - 1) {
      // 範囲が重なる → 2つの文字の中間に一番近い行の境目で区切る
      const mid = (p.labelBottom + g.labelTop) / 2;
      const cut = ys.length ? ys.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : mid;
      p.y1 = cut;
      g.y0 = cut;
    }
  }

  const items = rows.map((r, i) => {
    const c = (r.y0 + r.y1) / 2;
    const g = groupLabels.find((gl) => c >= gl.y0 && c <= gl.y1);
    return { no: i + 1, y0: r.y0, y1: r.y1, name: joinTokens(r.toks), group: g ? g.text : "" };
  });
  if (outside) warnings.push(`行の範囲の外にある左側の文字が ${outside} 個ありました（項目名に含めていません）。`);

  // 項目名のセルの左の境目（まとまり名の欄との境の縦の罫線）。設備の行を描くときに使う。
  // 見つからなければ、項目名の文字の少し左とする。
  const tableH = tableBottom - tableTop;
  const groupRight = groupLabels.length ? Math.max(...groupLabels.map((g) => g.x)) : -Infinity;
  const cellLines = lines.v.filter((l) =>
    l.x < nameX0 - 0.3 && l.x > groupRight &&
    l.y1 - l.y0 >= Math.min(tableH * 0.3, 30) && l.y0 < tableBottom && l.y1 > tableTop);
  const nameCellLeft = cellLines.length ? Math.max(...cellLines.map((l) => l.x)) : Math.max(tableLeft, nameX0 - 2);

  return {
    method,
    items,
    groups: groupLabels.map((g) => ({ text: g.text, y0: g.y0, y1: g.y1, x: g.x })),
    nameArea: { x0: nameX0, x1: gridLeft },
    nameCellLeft,
    tableLeft,
    tableTop,
    tableBottom,
  };
}

// 同じ行の文字は左から、複数行は上から順につなぐ
function joinTokens(toks) {
  if (!toks.length) return "";
  const parts = [];
  for (const g of clusterBy(toks, (t) => t.base, (t) => t.h * 0.5)) {
    const line = g.items.sort((a, b) => a.x0 - b.x0);
    let s = "";
    let prev = null;
    for (const t of line) {
      if (prev && t.x0 - prev.x1 > t.h * 0.25) s += " ";
      s += t.str;
      prev = t;
    }
    parts.push(s);
  }
  return parts.join(" ").replace(/[\s　]+/g, " ").trim();
}

// ======================================================================
// 小道具
// ======================================================================

function clusterBy(list, keyFn, tolFn) {
  const sorted = [...list].sort((a, b) => keyFn(a) - keyFn(b));
  const groups = [];
  let cur = null;
  for (const it of sorted) {
    const k = keyFn(it);
    if (cur && Math.abs(k - cur.key) <= tolFn(it)) {
      cur.items.push(it);
      cur.key += (k - cur.key) / cur.items.length; // 平均
    } else {
      cur = { key: k, items: [it] };
      groups.push(cur);
    }
  }
  return groups;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function nearestIndex(chain, x, tol) {
  let bi = -1;
  let bd = tol;
  for (let i = 0; i < chain.length; i++) {
    const d = Math.abs(chain[i].cx - x);
    if (d <= bd) { bd = d; bi = i; }
  }
  return bi;
}

function dedupe(sorted, tol) {
  const out = [];
  for (const y of sorted) {
    if (out.length && y - out[out.length - 1] <= tol) continue;
    out.push(y);
  }
  return out;
}
