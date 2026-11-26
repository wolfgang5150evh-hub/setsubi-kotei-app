// 設備工程管理アプリ：第1段階
//   ・PDFの読み込み・表示・拡大縮小・移動
//   ・日付と行の読み取り＋重ね表示
//   ・設備の行の差し込み（行の境目で画像を短冊に切り分け、差し込んだ分だけ下をずらして表示）
//   ・設備の行へのバーの配置（ドラッグで移動、両端で伸縮、1行に複数）
// PDFの描画には PDF.js（CDN）を使う。元のPDF画像は書き換えず、表示上の並べ替えだけで行を差し込む。
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { analyzePage } from "./reader.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// ---- 設定 ----
const PAGE_GAP = 16;            // ページ同士のすき間（PDFの pt 単位）
const MAX_SCALE = 10;           // 最大倍率（画面px / PDF pt）
const MAX_CANVAS_AREA = 16_000_000; // iPhone の canvas 上限（約1677万px）より少し下
const RERENDER_DELAY = 250;     // 操作が止まってから描き直すまでの待ち時間（ms）

// 設備の行・バー
const EQUIP_LABEL = "設備工事";  // 差し込んだ行の項目名
const EQUIP_ROW_RATIO = 1.0;    // 差し込む行の高さ＝元の行の高さ（中央値）× この値
const DEFAULT_BAR_DAYS = 3;     // 「ここにバーを置く」で置くバーの長さ（日）
const HIT_PX = 28;              // バーの端をつかめる幅（画面px。拡大率によらずこの大きさ）
const TAP_SLOP = 8;             // これ以上指が動いたら「タップ」ではなく「移動」とみなす（px）
const TAP_TIME = 600;           // これより長く押したら「タップ」とみなさない（ms）
const EPS = 0.01;

// ---- 画面の部品 ----
const viewer = document.getElementById("viewer");
const stage = document.getElementById("stage");
const message = document.getElementById("message");
const fileInput = document.getElementById("file-input");
const fileNameEl = document.getElementById("file-name");
const zoomLabel = document.getElementById("zoom-label");
const dock = document.getElementById("bottom-dock");
const btnOverlay = document.getElementById("btn-overlay");
const readPanel = document.getElementById("read-panel");
const readSummary = document.getElementById("read-summary");
const readDetail = document.getElementById("read-detail");
const readDetailText = document.getElementById("read-detail-text");
const btnReadDetail = document.getElementById("btn-read-detail");
const btnReadCopy = document.getElementById("btn-read-copy");
const btnEquip = document.getElementById("btn-equip");
const equipPanel = document.getElementById("equip-panel");
const equipInfo = document.getElementById("equip-info");
const equipActions = document.getElementById("equip-actions");
const dragTip = document.getElementById("drag-tip");

// ---- 状態 ----
let pdfDoc = null;
// 1ページ分：{ page, no, width, height（元の大きさ pt）, top, left, dispH（行を差し込んだあとの表示の高さ）,
//   el, imgBox, canvas（ページ全体を描いた元の画像）, task, result（読み取り結果）, overlay,
//   equip（行番号→差し込んだ設備の行）, cuts（切れ目の一覧）, cutByRow, insH（差し込む行の高さ）,
//   colors（列・棟の欄の色）, equipSvg, barEls, selRect, cellRect }
let pages = [];
let contentW = 0;      // 全ページを並べた幅（pt）
let contentH = 0;      // 全ページを並べた高さ（pt）
const view = { scale: 1, x: 0, y: 0 }; // 表示の倍率と位置
let fitScale = 1;      // 幅に合わせたときの倍率
let renderedScale = 0; // 今 canvas に描いてある解像度
let rerenderTimer = 0;
let renderToken = 0;

// ---- メッセージ表示 ----
function showMessage(text, isError = false) {
  message.innerHTML = text;
  message.classList.remove("hidden");
  message.classList.toggle("error", isError);
}
function hideMessage() {
  message.classList.add("hidden");
}

// ---- ファイルを開く ----
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) openFile(file);
  fileInput.value = ""; // 同じファイルをもう一度選べるようにする
});

// パソコン向け：画面にPDFをドラッグ＆ドロップしても開ける
viewer.addEventListener("dragover", (e) => e.preventDefault());
viewer.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) openFile(file);
});

async function openFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showMessage("PDFファイルを選んでください。", true);
    return;
  }
  if (hasEquipData() && !confirm("今の設備の行とバーは消えます（まだ保存できません）。別のPDFを開きますか？")) return;
  showMessage("読み込み中…");
  fileNameEl.textContent = file.name;
  resetAnalysis();
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    await setupPages();
    fitToWidth();
    hideMessage();
    fileNameEl.textContent = `${file.name}（${pdfDoc.numPages}ページ）`;
    startAnalysis(); // 日付と行の読み取り（表示はそのまま使える。終わりしだい重ねて表示）
  } catch (err) {
    console.error(err);
    showMessage("PDFを開けませんでした。<br>" + escapeHtml(String(err && err.message || err)), true);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- ページの並べ方を決める ----
async function setupPages() {
  stage.innerHTML = "";
  pages = [];
  renderedScale = 0;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 }); // 1 = PDFの pt そのまま
    const el = document.createElement("div");
    el.className = "page";
    el.style.width = vp.width + "px";
    const imgBox = document.createElement("div");
    imgBox.className = "page-img";
    const canvas = document.createElement("canvas");
    canvas.className = "full";
    canvas.width = canvas.height = 0; // 大きさ0＝まだ描いていない（描き終わると差し替わる）
    imgBox.appendChild(canvas);
    el.appendChild(imgBox);
    stage.appendChild(el);
    pages.push({
      page, no: i, width: vp.width, height: vp.height, top: 0, left: 0, dispH: vp.height,
      el, imgBox, canvas, task: null, result: null, overlay: null,
      equip: new Map(), cuts: [], cutByRow: new Map(), insH: 0, colors: null,
      equipSvg: null, barEls: new Map(), selRect: null, cellRect: null,
    });
  }
  layoutPages();
}

// 各ページの表示の高さ（差し込んだ行の分だけ伸びる）から、縦の並びを決め直す
function layoutPages() {
  let top = 0;
  let maxW = 0;
  for (const p of pages) {
    p.dispH = p.height + p.cuts.length * p.insH;
    p.top = top;
    p.el.style.top = top + "px";
    p.el.style.height = p.dispH + "px";
    top += p.dispH + PAGE_GAP;
    maxW = Math.max(maxW, p.width);
  }
  contentW = maxW;
  contentH = Math.max(0, top - PAGE_GAP);
  stage.style.width = contentW + "px";
  stage.style.height = contentH + "px";
  // 幅の違うページは中央にそろえる
  for (const p of pages) {
    p.left = (contentW - p.width) / 2;
    p.el.style.left = p.left + "px";
  }
}

// ---- 描画（解像度をそろえて描き直す） ----
function desiredRenderScale() {
  const dpr = window.devicePixelRatio || 1;
  let s = view.scale * dpr;
  // canvas が大きすぎると iPhone で真っ白になるので上限をかける
  for (const p of pages) {
    const limit = Math.sqrt(MAX_CANVAS_AREA / (p.width * p.height));
    s = Math.min(s, limit);
  }
  return Math.max(s, 0.5);
}

async function renderPages() {
  if (!pages.length) return;
  const scale = desiredRenderScale();
  // 今の解像度で十分なら描き直さない
  if (renderedScale && scale <= renderedScale * 1.15 && scale >= renderedScale * 0.5) return;
  const token = ++renderToken;
  for (const p of pages) {
    if (p.task) { p.task.cancel(); p.task = null; }
  }
  for (const p of pages) {
    if (token !== renderToken) return;
    const vp = p.page.getViewport({ scale });
    // 別の canvas に描いてから差し替える（ちらつき防止）
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") return;
      throw err;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (token !== renderToken) return;
    const old = p.canvas;
    canvas.className = "full";
    p.canvas = canvas;
    if (old.parentNode) old.remove();
    // 古い canvas のメモリを早めに解放（iPhone 対策）
    old.width = old.height = 0;
    updatePageImage(p);
    // 列の色（土日・祝日の色など）は最初に描けたときに1回だけ調べる
    if (!p.colors && p.result) {
      ensureColors(p);
      if (p.colors && p.cuts.length && !barDrag) { drawEquip(p); applySelectionVisuals(); }
    }
  }
  renderedScale = scale;
}

function scheduleRender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    refreshBarHits(); // 拡大率が変わったら、バーの端のつかみ幅を画面px基準で合わせ直す
    renderPages().catch(console.error);
  }, RERENDER_DELAY);
}

// ---- 短冊（行の境目で切り分けた画像）----
// 差し込みがないページは、ページ全体の canvas をそのまま表示する。
// 差し込みがあるページは、ページ全体の canvas から短冊を切り出し、差し込んだ行の分だけ下にずらして並べる。
function updatePageImage(p) {
  const box = p.imgBox;
  const src = p.canvas;
  for (const c of [...box.children]) {
    if (c !== src) c.width = c.height = 0; // 前の短冊のメモリを解放
  }
  box.textContent = "";
  if (!p.cuts.length) {
    box.appendChild(src);
    return;
  }
  if (!src.width || !src.height) return; // まだ描けていない（描け次第ここに戻ってくる）
  const ky = src.height / p.height;      // 縦：1pt あたりの px
  const edges = [0, ...p.cuts.map((c) => c.y), p.height];
  for (let i = 0; i < edges.length - 1; i++) {
    const sy0 = Math.max(0, Math.round(edges[i] * ky));
    const sy1 = Math.min(src.height, Math.round(edges[i + 1] * ky));
    if (sy1 <= sy0) continue;
    const cv = document.createElement("canvas");
    cv.className = "strip";
    cv.width = src.width;
    cv.height = sy1 - sy0;
    cv.getContext("2d").drawImage(src, 0, sy0, src.width, sy1 - sy0, 0, 0, src.width, sy1 - sy0);
    cv.style.top = (sy0 / ky + i * p.insH) + "px";
    cv.style.height = ((sy1 - sy0) / ky) + "px";
    box.appendChild(cv);
  }
}

// 差し込んだ行の一覧（切れ目）を作り直す。切れ目＝選んだ行の下の境目。
function updateCuts(p) {
  const items = p.result && p.result.rows ? p.result.rows.items : [];
  const list = [...p.equip.keys()]
    .filter((i) => items[i])
    .map((i) => ({ rowIndex: i, y: items[i].y1 }))
    .sort((a, b) => a.y - b.y);
  list.forEach((c, k) => { c.dTop = c.y + k * p.insH; }); // 差し込んだ行の表示上の上端
  p.cuts = list;
  p.cutByRow = new Map(list.map((c) => [c.rowIndex, c]));
}

// 元のPDFの y（pt）→ 表示上の y。
// 切れ目ちょうどの y は、after=false なら差し込んだ行の上側、after=true なら下側として扱う。
function mapY(p, y, after) {
  let n = 0;
  for (const c of p.cuts) {
    if (c.y < y - EPS || (after && Math.abs(c.y - y) <= EPS)) n++;
  }
  return y + n * p.insH;
}

// 表示上の y → 元の行か、差し込んだ設備の行か
function hitPage(p, dy) {
  let off = 0;
  for (const c of p.cuts) {
    const dTop = c.y + off;
    if (dy < dTop) return { kind: "orig", y: dy - off };
    if (dy < dTop + p.insH) return { kind: "equip", rowIndex: c.rowIndex };
    off += p.insH;
  }
  return { kind: "orig", y: dy - off };
}

// ---- 表示位置・倍率 ----
function minScale() {
  return Math.min(fitScale, fitHeightScale()) * 0.5;
}
function fitHeightScale() {
  return contentH ? viewer.clientHeight / contentH : 1;
}

// はみ出しすぎないように位置を制限する（下の帯に隠れる分は、さらに上まで動かせる）
function clampView() {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  const cw = contentW * view.scale;
  const ch = contentH * view.scale;
  const margin = 40;
  const padB = dock && !dock.classList.contains("hidden") ? dock.offsetHeight : 0;
  if (cw <= vw) view.x = (vw - cw) / 2;
  else view.x = Math.min(margin, Math.max(vw - cw - margin, view.x));
  if (ch <= vh - padB) view.y = (vh - padB - ch) / 2;
  else view.y = Math.min(margin, Math.max(vh - ch - margin - padB, view.y));
}

function applyView() {
  clampView();
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomLabel.textContent = pages.length ? Math.round((view.scale / fitScale) * 100) + "%" : "--%";
  scheduleRender();
}

// 画面上の点 (sx, sy) を固定したまま倍率を変える
function zoomAt(newScale, sx, sy) {
  if (!pages.length) return;
  newScale = Math.min(MAX_SCALE, Math.max(minScale(), newScale));
  const cx = (sx - view.x) / view.scale;
  const cy = (sy - view.y) / view.scale;
  view.scale = newScale;
  view.x = sx - cx * newScale;
  view.y = sy - cy * newScale;
  applyView();
}

function fitToWidth() {
  if (!pages.length) return;
  fitScale = (viewer.clientWidth - 16) / contentW;
  view.scale = fitScale;
  view.x = 8;
  view.y = 8;
  applyView();
}

// ---- ボタン ----
document.getElementById("btn-zoom-in").addEventListener("click", () =>
  zoomAt(view.scale * 1.4, viewer.clientWidth / 2, viewer.clientHeight / 2));
document.getElementById("btn-zoom-out").addEventListener("click", () =>
  zoomAt(view.scale / 1.4, viewer.clientWidth / 2, viewer.clientHeight / 2));
document.getElementById("btn-fit").addEventListener("click", fitToWidth);

// ---- ホイール（パソコン） ----
viewer.addEventListener("wheel", (e) => {
  if (!pages.length) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewer.clientHeight : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.shiftKey) {
    // Shift＋ホイール：横に移動
    view.x -= dy || dx;
    applyView();
  } else {
    // ホイール（およびトラックパッドのピンチ = ctrlKey 付き）：拡大縮小
    const rect = viewer.getBoundingClientRect();
    const speed = e.ctrlKey ? 0.01 : 0.0015;
    zoomAt(view.scale * Math.exp(-dy * speed), e.clientX - rect.left, e.clientY - rect.top);
  }
}, { passive: false });

// ---- タッチ・マウス（ピンチ・ドラッグ・タップ） ----
const pointers = new Map(); // pointerId → {x, y}
let gesture = null;
let tap = null;             // タップの候補（1本指で、ほとんど動かさずに離したらタップ）

function localPoint(e) {
  const rect = viewer.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function startGesture() {
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    gesture = { type: "pan", sx: pts[0].x, sy: pts[0].y, vx: view.x, vy: view.y };
  } else if (pts.length >= 2) {
    const [a, b] = pts;
    gesture = {
      type: "pinch",
      dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      scale: view.scale,
      vx: view.x,
      vy: view.y,
    };
  } else {
    gesture = null;
  }
}

viewer.addEventListener("pointerdown", (e) => {
  if (!pages.length) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  viewer.setPointerCapture(e.pointerId);
  const pt = localPoint(e);
  pointers.set(e.pointerId, pt);
  tap = pointers.size === 1 ? { id: e.pointerId, x: pt.x, y: pt.y, t: performance.now() } : null;
  viewer.classList.add("dragging");
  startGesture();
});

viewer.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const pt = localPoint(e);
  pointers.set(e.pointerId, pt);
  if (tap && tap.id === e.pointerId && Math.hypot(pt.x - tap.x, pt.y - tap.y) > TAP_SLOP) tap = null;
  const pts = [...pointers.values()];
  if (gesture.type === "pan" && pts.length === 1) {
    view.x = gesture.vx + (pts[0].x - gesture.sx);
    view.y = gesture.vy + (pts[0].y - gesture.sy);
    applyView();
  } else if (gesture.type === "pinch" && pts.length >= 2) {
    const [a, b] = pts;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const newScale = Math.min(MAX_SCALE, Math.max(minScale(), gesture.scale * (dist / gesture.dist)));
    // ピンチ開始時に指の中心にあった場所を、今の指の中心に合わせる
    const cx = (gesture.mx - gesture.vx) / gesture.scale;
    const cy = (gesture.my - gesture.vy) / gesture.scale;
    view.scale = newScale;
    view.x = mx - cx * newScale;
    view.y = my - cy * newScale;
    applyView();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const isTap = !!(tap && tap.id === e.pointerId && e.type === "pointerup" && performance.now() - tap.t < TAP_TIME);
  const t = tap;
  if (tap && tap.id === e.pointerId) tap = null;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) viewer.classList.remove("dragging");
  startGesture(); // 指が1本残ったら、そこから移動を続ける
  if (isTap && pointers.size === 0) handleTap(t.x, t.y);
}
viewer.addEventListener("pointerup", endPointer);
viewer.addEventListener("pointercancel", endPointer);

// iPhone Safari の独自ジェスチャー（画面全体の拡大）を止める
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ---- 画面サイズが変わったとき（回転など） ----
window.addEventListener("resize", () => {
  if (!pages.length) return;
  fitScale = (viewer.clientWidth - 16) / contentW;
  applyView();
});

// ---- キーボード（パソコン） ----
window.addEventListener("keydown", (e) => {
  if (!pages.length) return;
  if (e.key === "Escape" && selection) { setSelection(null); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selection && selection.kind === "bar" && equipMode) {
    e.preventDefault();
    deleteBar(selection.p, selection.rowIndex, selection.barId);
    return;
  }
  const cx = viewer.clientWidth / 2;
  const cy = viewer.clientHeight / 2;
  if (e.key === "+" || e.key === ";") zoomAt(view.scale * 1.25, cx, cy);
  else if (e.key === "-") zoomAt(view.scale / 1.25, cx, cy);
  else if (e.key === "0") fitToWidth();
});

// ======================================================================
// 読み取り（日付の列・行と項目名）と重ね表示
// ======================================================================
const SVG_NS = "http://www.w3.org/2000/svg";
const WD = "日月火水木金土";

// 読み取りの設定。year：工程表の最初の月の年（null＝自動で推定）。
// 将来、画面の入力欄で年を指定できるようにするときは、ここに入れて startAnalysis() を呼び直す。
const readOptions = { year: null };
let overlayOn = true;   // 重ね表示のオン・オフ
let analyzeToken = 0;
let reportText = "";

function resetAnalysis() {
  analyzeToken++;
  reportText = "";
  setOverlayButton("読取", true);
  readPanel.classList.add("hidden");
  // 設備の行・バー
  selection = null;
  barDrag = null;
  equipReady = false;
  equipMode = false;
  hideTip();
  setEquipButton();
  updateEquipPanel();
}

async function startAnalysis() {
  const token = ++analyzeToken;
  setOverlayButton("読取中", true);
  const list = pages;
  for (const p of list) {
    try {
      p.result = await analyzePage(p.page, pdfjsLib, readOptions);
    } catch (err) {
      console.error(err);
      p.result = { error: String((err && err.message) || err), warnings: [] };
    }
    if (token !== analyzeToken) return;
    drawOverlay(p);
  }
  window.__readResults = list.map((p) => p.result); // 調べもの用（ブラウザのコンソールで見られる）
  setOverlayButton("読取", false);
  updatePanel(list);
  // 設備の行を差し込めるようにする（行が読めたページだけ）
  for (const p of list) {
    p.insH = computeInsH(p);
    updateCuts(p);
    drawEquip(p);
  }
  equipReady = list.some((p) => p.insH > 0);
  equipMode = equipReady; // 読み取りが終わったら、すぐ設備の行を入れられる状態にする
  setEquipButton();
  updateEquipPanel();
}

function setOverlayButton(label, disabled) {
  btnOverlay.textContent = label;
  btnOverlay.disabled = disabled;
  btnOverlay.classList.toggle("on", overlayOn && !disabled);
  btnOverlay.setAttribute("aria-pressed", overlayOn && !disabled ? "true" : "false");
}

btnOverlay.addEventListener("click", () => {
  overlayOn = !overlayOn;
  for (const p of pages) if (p.overlay) p.overlay.style.display = overlayOn ? "" : "none";
  readPanel.classList.toggle("hidden", !overlayOn || !reportText);
  setOverlayButton("読取", false);
  updateDock();
});
btnReadDetail.addEventListener("click", () => {
  const open = readDetail.classList.toggle("hidden") === false;
  btnReadDetail.textContent = open ? "閉じる" : "詳しく";
  updateDock();
});
btnReadCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(getReportText());
    btnReadCopy.textContent = "コピーしました";
  } catch {
    btnReadCopy.textContent = "コピーできません";
  }
  setTimeout(() => { btnReadCopy.textContent = "結果をコピー"; }, 1500);
});

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function setA(el, attrs) {
  for (const k in attrs) el.setAttribute(k, attrs[k]);
}
function showEl(el, on) {
  if (on) el.removeAttribute("display");
  else el.setAttribute("display", "none");
}
const r1 = (v) => Math.round(v * 10) / 10;

// 読み取った列・行を、PDFと同じ座標（pt）の SVG で重ねる。
// ステージごと拡大縮小されるので、ずれていれば拡大して目で確かめられる。
// 設備の行を差し込んだページでは、差し込んだ分だけ下にずらして描く。
function drawOverlay(p) {
  if (p.overlay) { p.overlay.remove(); p.overlay = null; }
  const r = p.result;
  if (!r || !r.dates) return;
  const d = r.dates;
  const rows = r.rows;
  const M = (y, after) => mapY(p, y, after);
  const svg = svgEl("svg", { class: "overlay", viewBox: `0 0 ${p.width} ${p.dispH}`, preserveAspectRatio: "none" });
  const top = d.headerTop;
  const bottom = rows && rows.items.length ? M(rows.tableBottom, true) : d.headerBottom;

  // 行：1行おきに薄く塗る＋境目の赤線＋右側に番号と項目名
  if (rows && rows.items.length) {
    const x0 = rows.tableLeft;
    const x1 = d.gridRight;
    const g = svgEl("g", {}, svg);
    rows.items.forEach((row, i) => {
      const y0 = M(row.y0, true);
      const y1 = M(row.y1, false);
      if (i % 2 === 1) svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "ov-rowband" }, g);
      svgEl("line", { x1: x0, y1: y0, x2: x1, y2: y0, class: "ov-rowline" }, g);
      svgEl("line", { x1: x0, y1: y1, x2: x1, y2: y1, class: "ov-rowline" }, g);
      const t = svgEl("text", { x: x1 + 2, y: (y0 + y1) / 2 + 1.6, class: "ov-rowlabel" }, g);
      t.textContent = `${row.no} ${row.name || "（項目名なし）"}`;
    });
    // 項目名の欄（緑の点線）
    const nTop = M(rows.tableTop, true);
    svgEl("rect", {
      x: rows.nameArea.x0 - 1, y: nTop, width: rows.nameArea.x1 - rows.nameArea.x0 + 1,
      height: bottom - nTop, class: "ov-namearea",
    }, g);
    // まとまり名（棟など）：左側に括弧と名前。まとまりの最後の行の下に差し込んだ設備の行も、そのまとまりに含める
    for (const gr of rows.groups) {
      const gx = x0 - 2;
      const gy0 = M(gr.y0, true);
      const gy1 = M(gr.y1, true);
      svgEl("path", { d: `M${gx + 1.5},${gy0 + 0.5} H${gx} V${gy1 - 0.5} H${gx + 1.5}`, class: "ov-groupline" }, g);
      const t = svgEl("text", { x: gx - 1.5, y: (gy0 + gy1) / 2 + 1.8, class: "ov-grouplabel" }, g);
      t.textContent = gr.text;
    }
  }

  // 列：1列おきに薄く塗る＋境目の青線＋上に日付
  const gc = svgEl("g", {}, svg);
  d.columns.forEach((c, i) => {
    if (i % 2 === 0) svgEl("rect", { x: c.x0, y: top, width: c.x1 - c.x0, height: bottom - top, class: "ov-colband" }, gc);
    const bad = c.wdRead !== null && c.wdCalc !== null && c.wdRead !== c.wdCalc;
    if (bad) svgEl("rect", { x: c.x0, y: top, width: c.x1 - c.x0, height: d.headerBottom - top, class: "ov-bad" }, gc);
  });
  const xs = d.columns.map((c) => c.x0).concat(d.columns[d.columns.length - 1].x1);
  for (const x of xs) svgEl("line", { x1: x, y1: top, x2: x, y2: bottom, class: "ov-colline" }, gc);
  d.columns.forEach((c, i) => {
    const wd = c.wdCalc !== null ? c.wdCalc : c.wdRead;
    const bad = c.wdRead !== null && c.wdCalc !== null && c.wdRead !== c.wdCalc;
    const cls = "ov-day" + (bad ? " ov-day-bad" : wd === 0 ? " ov-day-sun" : wd === 6 ? " ov-day-sat" : "") + (c.filled ? " ov-day-filled" : "");
    const t = svgEl("text", { x: c.cx, y: top - 1.5, class: cls }, gc);
    t.textContent = String(c.day) + (bad ? "!" : "");
    if (i === 0 || c.day === 1) {
      const m = svgEl("text", { x: c.x0, y: top - 6.5, class: "ov-month" }, gc);
      m.textContent = c.month ? `${c.year}/${c.month}/${c.day}` : `?/${c.day}`;
    }
  });

  svg.style.display = overlayOn ? "" : "none";
  p.el.appendChild(svg);
  p.overlay = svg;
}

function fmtCol(c) {
  const wd = c.wdCalc !== null ? WD[c.wdCalc] : c.wdRead !== null ? WD[c.wdRead] : "?";
  return c.month ? `${c.year}/${c.month}/${c.day}(${wd})` : `?月${c.day}日(${wd})`;
}

// 下の帯（まとめ）と「詳しく」の中身を作る
function updatePanel(list) {
  const lines = [];
  let summary = "";
  list.forEach((p, idx) => {
    const r = p.result;
    lines.push(`■ ${idx + 1}ページ目`);
    if (!r || r.error) {
      lines.push(`  読み取りに失敗：${(r && r.error) || "不明"}`);
      if (!summary) summary = "読み取りに失敗しました";
      return;
    }
    const d = r.dates;
    if (d) {
      const n = d.columns.length;
      const first = d.columns[0];
      const last = d.columns[n - 1];
      lines.push(`【日付】${n}列　${fmtCol(first)} 〜 ${fmtCol(last)}`);
      lines.push(`  年：${d.year}（${d.yearSource}）` + (d.created ? `　作成日の表示：${d.created.year}/${d.created.month}/${d.created.day}` : ""));
      lines.push("  月ごと：" + d.months.map((m) => `${m.month ? `${m.year}年${m.month}月` : "?月"} ${m.from}〜${m.to}日（${m.count}列・${m.src}）`).join("／"));
      lines.push(`  曜日：${d.weekdayRow ? `読めた ${d.wdTotal}列のうち、合わない列 ${d.wdMismatch}` : "曜日の行は見つからず"}`);
      lines.push(`  列の幅：約${r1(d.pitch)}pt　縦の罫線に合わせた境目：${d.snapped}/${d.boundCount}　文字が無く補った列：${d.filledCount}`);
      lines.push(`  列の位置（x, pt）：${r1(d.gridLeft)} 〜 ${r1(d.gridRight)}`);
    } else {
      lines.push("【日付】読めませんでした");
    }
    const rows = r.rows;
    if (rows) {
      const named = rows.items.filter((x) => x.name).length;
      lines.push(`【行】${rows.items.length}行（項目名あり ${named}行）　境目の求め方：${rows.method}`);
      if (rows.groups.length) lines.push("  まとまり：" + rows.groups.map((g) => g.text).join("／"));
      for (const it of rows.items) {
        lines.push(`  ${it.no}. ${it.group ? `［${it.group}］` : ""}${it.name || "（項目名なし）"}　y=${r1(it.y0)}〜${r1(it.y1)}`);
      }
    }
    lines.push(`  （文字 ${r.textCount}個、罫線 横${r.lineCount.h}本・縦${r.lineCount.v}本 を検出）`);
    if (r.warnings.length) {
      lines.push("【注意】");
      for (const w of r.warnings) lines.push("  ・" + w);
    }
    if (!summary) {
      summary = d
        ? `日付 ${d.columns.length}列（${fmtCol(d.columns[0])}〜${fmtCol(d.columns[d.columns.length - 1])}）`
          + `／行 ${rows ? rows.items.length : 0}行`
          + (r.warnings.length ? `／注意 ${r.warnings.length}件` : "")
        : "日付が読めませんでした";
      if (list.length > 1) summary = `1ページ目：${summary}（全${list.length}ページ）`;
    }
  });
  reportText = lines.join("\n");
  readSummary.textContent = summary;
  readDetailText.textContent = getReportText();
  readPanel.classList.toggle("hidden", !overlayOn);
  updateDock();
}

// 「結果をコピー」で写す文字（読み取り結果＋設備の行の一覧）
function getReportText() {
  const eq = equipReport();
  return eq ? `${reportText}\n${eq}` : reportText;
}
function refreshReportText() {
  if (reportText) readDetailText.textContent = getReportText();
}

// 下の帯（設備・読取）がどちらも隠れているときは、帯の入れ物ごと隠す
function updateDock() {
  const any = !equipPanel.classList.contains("hidden") || !readPanel.classList.contains("hidden");
  dock.classList.toggle("hidden", !any);
}

// ======================================================================
// 設備の行の差し込み＋バーの配置
// ======================================================================
// データ（今はメモリ上だけ。保存は第2段階）：
//   p.equip：Map（元の行の番号 0始まり → { rowIndex, bars: [{ id, start, end }] }）
//   start・end：日付の列の番号（0始まり、両端を含む）。1列＝1日。
// 選択：selection = null
//   | { kind: "row",   p, rowIndex }            元の行
//   | { kind: "equip", p, rowIndex, col }       差し込んだ設備の行（col：タップした日の列。日付の欄の外なら null）
//   | { kind: "bar",   p, rowIndex, barId }     バー
let equipMode = false;   // 設備の行・バーを編集できる状態か（「設備」ボタン）
let equipReady = false;  // 読み取りが終わり、差し込める行があるか
let selection = null;
let barDrag = null;      // バーをドラッグ中の情報
let barSeq = 0;

function setEquipButton() {
  btnEquip.disabled = !equipReady;
  btnEquip.classList.toggle("on", equipMode && equipReady);
  btnEquip.setAttribute("aria-pressed", equipMode && equipReady ? "true" : "false");
}

btnEquip.addEventListener("click", () => {
  if (!equipReady) return;
  equipMode = !equipMode;
  if (!equipMode) selection = null;
  for (const p of pages) if (p.equipSvg) p.equipSvg.classList.toggle("editing", equipMode);
  setEquipButton();
  applySelectionVisuals();
  updateEquipPanel();
  applyView();
});

function hasEquipData() {
  return pages.some((p) => p.equip.size > 0);
}

// 差し込む行の高さ：元の行の高さの中央値 × EQUIP_ROW_RATIO（8〜40pt）
function computeInsH(p) {
  const r = p.result;
  const rows = r && r.dates && r.rows;
  if (!rows || !rows.items.length) return 0;
  const hs = rows.items.map((it) => it.y1 - it.y0).sort((a, b) => a - b);
  const med = hs[hs.length >> 1];
  return Math.min(40, Math.max(8, med * EQUIP_ROW_RATIO));
}

// 行の呼び名（棟名付き）：例「第二十二アパート／14階 (2部屋)」
function rowFullName(p, i) {
  const row = p.result.rows.items[i];
  const name = row.name || `（項目名なし・${row.no}行目）`;
  const pg = pages.length > 1 ? `${p.no}ページ目 ` : "";
  return pg + (row.group ? `${row.group}／${name}` : name);
}

function colDate(c, withYear) {
  const wd = c.wdCalc !== null ? WD[c.wdCalc] : c.wdRead !== null ? WD[c.wdRead] : "";
  const w = wd ? `(${wd})` : "";
  if (!c.month) return `?月${c.day}日${w}`;
  return `${withYear ? c.year + "/" : ""}${c.month}/${c.day}${w}`;
}
// 例「2026/11/5(木)〜11/12(木)（8日間）」
function barRangeText(p, bar, withYear) {
  const cols = p.result.dates.columns;
  const a = cols[bar.start];
  const b = cols[bar.end];
  const days = bar.end - bar.start + 1;
  const endYear = withYear || (a.year && b.year && a.year !== b.year);
  return `${colDate(a, withYear)}〜${colDate(b, endYear)}（${days}日間）`;
}
// バーの上に出す短い表示。例「11/5〜11/12」
function barShortLabel(cols, bar) {
  const s = (c) => (c.month ? `${c.month}/${c.day}` : `${c.day}日`);
  return bar.start === bar.end ? s(cols[bar.start]) : `${s(cols[bar.start])}〜${s(cols[bar.end])}`;
}

function equipCounts() {
  let rowsN = 0;
  let barsN = 0;
  for (const p of pages) {
    rowsN += p.equip.size;
    for (const ins of p.equip.values()) barsN += ins.bars.length;
  }
  return { rowsN, barsN };
}

function equipReport() {
  const lines = [];
  for (const p of pages) {
    if (!p.result || !p.result.rows) continue;
    for (const c of p.cuts) {
      const ins = p.equip.get(c.rowIndex);
      const bars = [...ins.bars].sort((a, b) => a.start - b.start || a.end - b.end);
      lines.push(`  ・${rowFullName(p, c.rowIndex)}／${EQUIP_LABEL}：バー${bars.length}本`
        + (bars.length ? "　" + bars.map((b) => barRangeText(p, b, false)).join("、") : ""));
    }
  }
  if (!lines.length) return "";
  return `【設備の行】${lines.length}行（※まだ保存はできません。表示と操作のみ）\n${lines.join("\n")}`;
}

// ---- 列・棟の欄の色を、描いた画像から調べる ----
// 設備の行にも、元の表と同じ土日・祝日の色（黄色・橙色の列）と、棟の欄の色を付けるため。
// 各列について表の全行から色を拾い、一番多い色をその列の色とする（バーや文字の色は少数なので外れる）。
// 多くの列と同じ色（ふつうの列）は塗らない。
function ensureColors(p) {
  if (p.colors || !p.canvas || !p.canvas.width) return;
  const r = p.result;
  if (!r || !r.dates || !r.rows || !r.rows.items.length) return;
  const W = Math.max(1, Math.round(p.width));
  const H = Math.max(1, Math.round(p.height));
  let data;
  try {
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(p.canvas, 0, 0, W, H); // 1pt＝1px に縮めてから1回で読む（速さのため）
    data = ctx.getImageData(0, 0, W, H).data;
    cv.width = cv.height = 0;
  } catch (err) {
    console.warn("色の読み取りに失敗", err);
    p.colors = { cols: [], groups: [] };
    return;
  }
  const get = (x, y) => {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
    const i = (yi * W + xi) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const modeOf = (pts) => {
    const bins = new Map();
    for (const [x, y] of pts) {
      const c = get(x, y);
      const k = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
      let b = bins.get(k);
      if (!b) { b = { k, n: 0, r: 0, g: 0, b: 0 }; bins.set(k, b); }
      b.n++; b.r += c[0]; b.g += c[1]; b.b += c[2];
    }
    let best = null;
    for (const b of bins.values()) if (!best || b.n > best.n) best = b;
    return best ? { k: best.k, rgb: [best.r / best.n, best.g / best.n, best.b / best.n] } : null;
  };
  const rgbStr = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const d = r.dates;
  const rows = r.rows;
  const ys = [];
  for (const row of rows.items) for (let y = row.y0 + 1.5; y < row.y1 - 1; y += 2.5) ys.push(y);
  const colModes = d.columns.map((c) => {
    const w = c.x1 - c.x0;
    const pts = [];
    for (const fx of [0.3, 0.5, 0.7]) for (const y of ys) pts.push([c.x0 + w * fx, y]);
    return modeOf(pts);
  });
  // ふつうの列の色＝一番多くの列で出た色
  const cnt = new Map();
  for (const m of colModes) if (m) cnt.set(m.k, (cnt.get(m.k) || 0) + 1);
  let normalK = null;
  let normalN = -1;
  for (const [k, n] of cnt) if (n > normalN) { normalN = n; normalK = k; }
  const normal = colModes.find((m) => m && m.k === normalK);
  const cols = colModes.map((m) => (m && normal && dist(m.rgb, normal.rgb) > 40 ? rgbStr(m.rgb) : null));

  const sx0 = rows.tableLeft;
  const sx1 = rows.nameCellLeft;
  const groups = rows.groups.map((g) => {
    if (!(sx1 - sx0 >= 2)) return null;
    const pts = [];
    for (const fx of [0.15, 0.3, 0.7, 0.85]) for (let y = g.y0 + 1; y < g.y1 - 1; y += 2) pts.push([sx0 + (sx1 - sx0) * fx, y]);
    const m = modeOf(pts);
    return m ? rgbStr(m.rgb) : null;
  });
  p.colors = { cols, groups };
}

// ---- 設備の行とバーの描画（ページごとの SVG。PDFと同じ pt 座標で、ページと一緒に拡大縮小される）----
function drawEquip(p) {
  if (p.equipSvg) p.equipSvg.remove();
  p.equipSvg = null;
  p.barEls = new Map();
  p.selRect = p.cellRect = null;
  const r = p.result;
  if (!r || !r.dates || !r.rows || !r.rows.items.length) return;
  ensureColors(p);
  const svg = svgEl("svg", {
    class: "equip-layer" + (equipMode ? " editing" : ""),
    viewBox: `0 0 ${p.width} ${p.dispH}`,
    preserveAspectRatio: "none",
  });
  for (const c of p.cuts) drawEquipRow(p, svg, c);
  p.selRect = svgEl("rect", { class: "eq-selrow", display: "none" }, svg);
  p.cellRect = svgEl("rect", { class: "eq-cell", display: "none" }, svg);
  p.el.appendChild(svg);
  p.equipSvg = svg;
  updateAllBars(p);
}

function drawEquipRow(p, svg, cut) {
  const r = p.result;
  const d = r.dates;
  const rows = r.rows;
  const row = rows.items[cut.rowIndex];
  const y0 = cut.dTop;
  const h = p.insH;
  const y1 = y0 + h;
  const mid = (row.y0 + row.y1) / 2;
  const gIdx = rows.groups.findIndex((g) => mid >= g.y0 && mid <= g.y1);
  const hasSide = gIdx >= 0 && rows.nameCellLeft > rows.tableLeft + 1;
  const x0 = hasSide ? rows.nameCellLeft : rows.tableLeft;
  const x1 = d.gridRight;
  const g = svgEl("g", { class: "eq-row" }, svg);

  // 棟名の欄：棟の欄の色でつなげる（元の行の下の罫線の半分が見えないよう、少し上まで塗る）
  if (hasSide) {
    const fill = (p.colors && p.colors.groups[gIdx]) || "#ffffff";
    svgEl("rect", { x: rows.tableLeft, y: y0 - 0.6, width: rows.nameCellLeft - rows.tableLeft, height: h + 0.6, fill }, g);
  }
  // 設備の行の地の色（薄い青）＋土日・祝日の列の色
  svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: h, class: "eq-base" }, g);
  if (p.colors) {
    d.columns.forEach((c, i) => {
      const f = p.colors.cols[i];
      if (f) svgEl("rect", { x: c.x0, y: y0, width: c.x1 - c.x0, height: h, fill: f }, g);
    });
  }
  // 罫線：日付の列の細い線＋行の上下・欄の境の線
  let grid = "";
  for (const c of d.columns.slice(1)) grid += `M${c.x0},${y0}V${y1}`;
  svgEl("path", { d: grid, class: "eq-gridline" }, g);
  const leftTop = hasSide ? y0 - 0.6 : y0;
  svgEl("path", {
    d: `M${x0},${y0}H${x1}M${x0},${y1}H${x1}M${rows.tableLeft},${leftTop}V${y1}M${x0},${y0}V${y1}M${d.gridLeft},${y0}V${y1}M${x1},${y0}V${y1}`,
    class: "eq-border",
  }, g);
  // 項目名の欄：「設備工事」（完成イメージに合わせて右寄せ）
  const fs = Math.max(3, Math.min(7, h * 0.5));
  const t = svgEl("text", { x: d.gridLeft - 1.5, y: y0 + h / 2 + fs * 0.36, "font-size": fs, class: "eq-name" }, g);
  t.textContent = EQUIP_LABEL;
  // バー
  const bg = svgEl("g", { class: "eq-bars" }, g);
  const ins = p.equip.get(cut.rowIndex);
  for (const bar of ins.bars) createBarEls(p, bg, cut.rowIndex, bar);
}

// バー1本分の部品を作る（位置は positionBar で決める。ドラッグ中は部品を作り直さず位置だけ変える）
function createBarEls(p, parent, rowIndex, bar) {
  const g = svgEl("g", { class: "eq-bar" }, parent);
  const els = {
    sel: svgEl("rect", { class: "eq-bar-sel", display: "none" }, g),
    line: svgEl("line", { class: "eq-bar-line" }, g),
    tick: svgEl("line", { class: "eq-bar-line" }, g),
    head: svgEl("polygon", { class: "eq-bar-head" }, g),
    label: svgEl("text", { class: "eq-bar-label" }, g),
    hL: svgEl("circle", { class: "eq-handle", display: "none" }, g),
    hR: svgEl("circle", { class: "eq-handle", display: "none" }, g),
    hitBody: svgEl("rect", { class: "eq-hit eq-hit-body" }, g),
    hitL: svgEl("rect", { class: "eq-hit eq-hit-end" }, g),
    hitR: svgEl("rect", { class: "eq-hit eq-hit-end" }, g),
  };
  for (const [el, mode] of [[els.hitBody, "move"], [els.hitL, "left"], [els.hitR, "right"]]) {
    el.addEventListener("pointerdown", (e) => onBarDown(e, p, rowIndex, bar.id, mode));
    el.addEventListener("pointermove", onBarMove);
    el.addEventListener("pointerup", onBarUp);
    el.addEventListener("pointercancel", onBarUp);
    el.addEventListener("lostpointercapture", onBarUp);
  }
  p.barEls.set(bar.id, els);
}

// 日付が重なるバーは、行の中で段を分けて並べる（重ならなければ1段）
function assignLanes(bars) {
  const sorted = [...bars].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  const laneEnds = [];
  const lane = new Map();
  for (const b of sorted) {
    let l = laneEnds.findIndex((e) => e < b.start);
    if (l < 0) { l = laneEnds.length; laneEnds.push(b.end); } else laneEnds[l] = b.end;
    lane.set(b.id, l);
  }
  return { lane, count: Math.max(1, laneEnds.length) };
}

function updateRowBars(p, rowIndex) {
  const ins = p.equip.get(rowIndex);
  const cut = p.cutByRow.get(rowIndex);
  if (!ins || !cut) return;
  const { lane, count } = assignLanes(ins.bars);
  for (const bar of ins.bars) {
    const els = p.barEls.get(bar.id);
    if (els) positionBar(p, cut, bar, els, lane.get(bar.id), count);
  }
}
function updateAllBars(p) {
  for (const c of p.cuts) updateRowBars(p, c.rowIndex);
}
function refreshBarHits() {
  if (barDrag) return;
  for (const p of pages) updateAllBars(p);
}

// バーの見た目：完成イメージの工程の線に合わせ、「始まりの縦の短い線＋横線＋終わりの矢印」、
// 線の上に日付（第2段階で作業内容を出す場所）。
function positionBar(p, cut, bar, els, lane, laneCount) {
  const cols = p.result.dates.columns;
  const x0 = cols[bar.start].x0;
  const x1 = cols[bar.end].x1;
  const w = x1 - x0;
  const laneH = p.insH / laneCount;
  const top = cut.dTop + lane * laneH;
  const ly = top + laneH * 0.66;
  const sw = Math.max(0.5, Math.min(1.3, laneH * 0.14));
  const a = Math.max(0.6, Math.min(laneH * 0.32, 2.8, w * 0.45));
  const fs = Math.max(2.2, Math.min(4.2, laneH * 0.38));
  setA(els.line, { x1: x0 + 0.4, y1: ly, x2: x1 - a * 0.8, y2: ly, "stroke-width": sw });
  setA(els.tick, { x1: x0 + 0.4, y1: ly - a * 0.6, x2: x0 + 0.4, y2: ly + a * 0.6, "stroke-width": sw });
  setA(els.head, { points: `${x1},${ly} ${x1 - a},${ly - a * 0.55} ${x1 - a},${ly + a * 0.55}` });
  setA(els.label, { x: x0 + 1, y: ly - sw / 2 - fs * 0.3, "font-size": fs });
  els.label.textContent = barShortLabel(cols, bar);
  setA(els.sel, { x: x0 - 0.5, y: top + 0.3, width: w + 1, height: Math.max(0.5, laneH - 0.6) });
  const hr = Math.max(0.8, Math.min(2.2, laneH * 0.28));
  setA(els.hL, { cx: x0, cy: ly, r: hr });
  setA(els.hR, { cx: x1, cy: ly, r: hr });
  // つかめる範囲：端は画面で HIT_PX 分（半分はバーの外へはみ出す）。短いバーでも真ん中は「移動」に残す
  const hw = HIT_PX / view.scale;
  const inner = Math.min(hw / 2, w / 3);
  setA(els.hitBody, { x: x0, y: top, width: w, height: laneH });
  setA(els.hitL, { x: x0 - hw / 2, y: top, width: hw / 2 + inner, height: laneH });
  setA(els.hitR, { x: x1 - inner, y: top, width: hw / 2 + inner, height: laneH });
}

// ---- 選択 ----
function setSelection(sel) {
  selection = sel;
  applySelectionVisuals();
  updateEquipPanel();
}

function applySelectionVisuals() {
  for (const p of pages) {
    if (!p.equipSvg) continue;
    const s = selection && selection.p === p ? selection : null;
    const d = p.result.dates;
    const rows = p.result.rows;
    let band = null;
    let cell = null;
    if (s && s.kind === "row") {
      const row = rows.items[s.rowIndex];
      if (row) band = [mapY(p, row.y0, true), mapY(p, row.y1, false)];
    } else if (s) {
      const c = p.cutByRow.get(s.rowIndex);
      if (c) {
        band = [c.dTop, c.dTop + p.insH];
        if (s.kind === "equip" && s.col !== null) {
          const col = d.columns[s.col];
          cell = [col.x0, col.x1, c.dTop, c.dTop + p.insH];
        }
      }
    }
    showEl(p.selRect, !!band);
    if (band) setA(p.selRect, { x: rows.tableLeft, y: band[0], width: d.gridRight - rows.tableLeft, height: band[1] - band[0] });
    showEl(p.cellRect, !!cell);
    if (cell) setA(p.cellRect, { x: cell[0], y: cell[2], width: cell[1] - cell[0], height: cell[3] - cell[2] });
    for (const [id, els] of p.barEls) {
      const on = !!(s && s.kind === "bar" && s.barId === id);
      showEl(els.sel, on);
      showEl(els.hL, on);
      showEl(els.hR, on);
    }
  }
}

// 画面をタップしたとき：元の行 → その行を選ぶ／設備の行 → その行（とタップした日）を選ぶ
function handleTap(sx, sy) {
  if (!equipMode || !equipReady) return;
  const X = (sx - view.x) / view.scale;
  const Y = (sy - view.y) / view.scale;
  const p = pages.find((pp) => Y >= pp.top && Y < pp.top + pp.dispH);
  if (!p || !p.insH) { setSelection(null); return; }
  const d = p.result.dates;
  const rows = p.result.rows;
  const lx = X - p.left;
  const ly = Y - p.top;
  if (lx < rows.tableLeft - 2 || lx > d.gridRight + 2) { setSelection(null); return; }
  const h = hitPage(p, ly);
  if (h.kind === "equip") {
    const col = lx >= d.gridLeft && lx < d.gridRight ? colPos(d, lx) : null;
    setSelection({ kind: "equip", p, rowIndex: h.rowIndex, col });
    return;
  }
  const i = rows.items.findIndex((row) => h.y >= row.y0 && h.y < row.y1);
  setSelection(i >= 0 ? { kind: "row", p, rowIndex: i } : null);
}

// x（ページ内の pt）が何列目か。日付の欄の外は列の幅で外挿する（ドラッグの移動量に使う）
function colPos(d, x) {
  const cols = d.columns;
  const n = cols.length;
  if (x < cols[0].x0) return -Math.ceil((cols[0].x0 - x) / d.pitch);
  if (x >= cols[n - 1].x1) return n - 1 + Math.ceil((x - cols[n - 1].x1 + 1e-9) / d.pitch);
  for (let i = 0; i < n; i++) if (x < cols[i].x1) return i;
  return n - 1;
}
// x に一番近い列の境目（key＝"x0"：列の左端／"x1"：列の右端）
function nearestEdge(cols, x, key) {
  let bi = 0;
  let bd = Infinity;
  cols.forEach((c, i) => {
    const dd = Math.abs(c[key] - x);
    if (dd < bd) { bd = dd; bi = i; }
  });
  return bi;
}
function localX(p, clientX) {
  const rect = viewer.getBoundingClientRect();
  return (clientX - rect.left - view.x) / view.scale - p.left;
}

// ---- バーのドラッグ（移動・伸縮）----
function onBarDown(e, p, rowIndex, barId, mode) {
  if (!equipMode) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.stopPropagation(); // 画面の移動（パン）にしない
  e.preventDefault();
  if (barDrag) return;
  const ins = p.equip.get(rowIndex);
  const bar = ins && ins.bars.find((b) => b.id === barId);
  if (!bar) return;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
  barDrag = {
    id: e.pointerId, p, rowIndex, bar, mode,
    cx: e.clientX, cy: e.clientY, x: localX(p, e.clientX),
    start: bar.start, end: bar.end, moved: false,
  };
  setSelection({ kind: "bar", p, rowIndex, barId });
}

function onBarMove(e) {
  if (!barDrag || e.pointerId !== barDrag.id) return;
  e.stopPropagation();
  if (!barDrag.moved && Math.hypot(e.clientX - barDrag.cx, e.clientY - barDrag.cy) < 4) return;
  barDrag.moved = true;
  const { p, bar, mode } = barDrag;
  const d = p.result.dates;
  const cols = d.columns;
  const n = cols.length;
  const x = localX(p, e.clientX);
  if (mode === "move") {
    const len = barDrag.end - barDrag.start;
    const delta = colPos(d, x) - colPos(d, barDrag.x);
    const s = Math.min(n - 1 - len, Math.max(0, barDrag.start + delta));
    bar.start = s;
    bar.end = s + len;
  } else if (mode === "left") {
    bar.start = Math.min(nearestEdge(cols, x, "x0"), bar.end);
  } else {
    bar.end = Math.max(nearestEdge(cols, x, "x1"), bar.start);
  }
  updateRowBars(p, barDrag.rowIndex);
  showTip(e.clientX, e.clientY, barRangeText(p, bar, false), e.pointerType);
  updateEquipPanel();
}

function onBarUp(e) {
  if (!barDrag || e.pointerId !== barDrag.id) return;
  e.stopPropagation();
  const { bar } = barDrag;
  const changed = barDrag.moved && (bar.start !== barDrag.start || bar.end !== barDrag.end);
  barDrag = null;
  hideTip();
  if (changed) refreshReportText();
  updateEquipPanel();
}

// ドラッグ中の日付の吹き出し（指で隠れないよう、指の少し上に出す）
function showTip(clientX, clientY, text, pointerType) {
  const rect = viewer.getBoundingClientRect();
  const lift = pointerType === "mouse" ? 28 : 64;
  const x = Math.min(rect.width - 8, Math.max(8, clientX - rect.left));
  const y = Math.max(8, clientY - rect.top - lift);
  dragTip.textContent = text;
  dragTip.style.left = x + "px";
  dragTip.style.top = y + "px";
  dragTip.classList.remove("hidden");
}
function hideTip() {
  dragTip.classList.add("hidden");
}

// ---- 行・バーの追加と取り消し ----
// 差し込み・取り消しのあとは、短冊・重ね表示・設備の行を作り直し、ページの並びを決め直す
function relayoutEquip() {
  for (const p of pages) updateCuts(p);
  layoutPages();
  for (const p of pages) {
    updatePageImage(p);
    drawOverlay(p);
    drawEquip(p);
  }
  applyView();
  refreshReportText();
}

function insertEquipRow(p, i) {
  if (!p.insH || p.equip.has(i)) return;
  p.equip.set(i, { rowIndex: i, bars: [] });
  relayoutEquip();
  setSelection({ kind: "equip", p, rowIndex: i, col: null });
}

function removeEquipRow(p, i) {
  const ins = p.equip.get(i);
  if (!ins) return;
  if (ins.bars.length && !confirm(`「${rowFullName(p, i)}」の設備の行には、バーが${ins.bars.length}本あります。\nバーごと行を取り消しますか？`)) return;
  p.equip.delete(i);
  relayoutEquip();
  setSelection({ kind: "row", p, rowIndex: i });
}

function addBar(p, i, col) {
  const ins = p.equip.get(i);
  if (!ins) return;
  const n = p.result.dates.columns.length;
  const start = Math.min(n - 1, Math.max(0, col));
  const bar = { id: ++barSeq, start, end: Math.min(n - 1, start + DEFAULT_BAR_DAYS - 1) };
  ins.bars.push(bar);
  drawEquip(p);
  setSelection({ kind: "bar", p, rowIndex: i, barId: bar.id });
  refreshReportText();
}

function deleteBar(p, i, barId) {
  const ins = p.equip.get(i);
  if (!ins) return;
  ins.bars = ins.bars.filter((b) => b.id !== barId);
  drawEquip(p);
  setSelection({ kind: "equip", p, rowIndex: i, col: null });
  refreshReportText();
}

function findBar(p, i, barId) {
  const ins = p.equip.get(i);
  return ins ? ins.bars.find((b) => b.id === barId) : null;
}

// ---- 下の帯（設備）----
function addAction(label, fn, cls = "", aria = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-small" + (cls ? " " + cls : "");
  b.textContent = label;
  if (aria) b.setAttribute("aria-label", aria);
  b.addEventListener("click", fn);
  equipActions.appendChild(b);
}

function updateEquipPanel() {
  const show = equipMode && equipReady;
  equipPanel.classList.toggle("hidden", !show);
  equipActions.textContent = "";
  if (show) {
    const s = selection;
    if (!s) {
      const { rowsN, barsN } = equipCounts();
      equipInfo.textContent = `表の行をタップして選ぶと、その下に「${EQUIP_LABEL}」の行を入れられます。（設備の行 ${rowsN}行・バー ${barsN}本）`;
    } else {
      const p = s.p;
      const base = rowFullName(p, s.rowIndex);
      if (s.kind === "row") {
        equipInfo.textContent = `選択：${base}`;
        if (p.equip.has(s.rowIndex)) {
          addAction("設備の行を選ぶ", () => setSelection({ kind: "equip", p, rowIndex: s.rowIndex, col: null }));
          addAction("設備の行を取り消す", () => removeEquipRow(p, s.rowIndex), "danger");
        } else {
          addAction("この下に設備の行を入れる", () => insertEquipRow(p, s.rowIndex), "primary");
        }
      } else if (s.kind === "equip") {
        const ins = p.equip.get(s.rowIndex);
        const cols = p.result.dates.columns;
        equipInfo.textContent = `${base}／${EQUIP_LABEL}　バー${ins ? ins.bars.length : 0}本　`
          + (s.col !== null ? `選んだ日：${colDate(cols[s.col], true)}` : "（日付の欄をタップすると、その日にバーを置けます）");
        if (s.col !== null) addAction("ここにバーを置く", () => addBar(p, s.rowIndex, s.col), "primary");
        addAction("設備の行を取り消す", () => removeEquipRow(p, s.rowIndex), "danger");
      } else if (s.kind === "bar") {
        const bar = findBar(p, s.rowIndex, s.barId);
        if (!bar) {
          selection = null;
          updateEquipPanel();
          return;
        }
        equipInfo.textContent = `${base}／${EQUIP_LABEL}　${barRangeText(p, bar, true)}`;
        if (!barDrag) addAction("バーを削除", () => deleteBar(p, s.rowIndex, s.barId), "danger");
      }
      if (!barDrag) addAction("×", () => setSelection(null), "", "選択を解除");
    }
  }
  updateDock();
}

// ---- PWA：サービスワーカー登録（http/https のときだけ） ----
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("サービスワーカー登録失敗", err));
}
