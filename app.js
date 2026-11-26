// 設備工程管理アプリ
// 第1段階
//   ・PDFの読み込み・表示・拡大縮小・移動
//   ・日付と行の読み取り＋重ね表示
//   ・設備の行の差し込み（行の境目で画像を短冊に切り分け、差し込んだ分だけ下をずらして表示）
//   ・設備の行へのバーの配置（ドラッグで移動、両端で伸縮、1行に複数）
// 第2段階（前半）
//   ・バーの編集（作業内容・開始日・終了日・下請け業者）の画面
//   ・業者マスタ（登録・編集・削除、業者ごとの色）。バーは業者の色で表示
//   ・設備工程の端末内への保存と、同じPDFを開いたときの復元（store.js）
//   ・バーの始まり端・終わり端の形（無し／●／○／←／→）を選べる
// Googleカレンダー連携
//   ・PDFごとの「現場名」（初期値はファイル名）。保存・復元の対象
//   ・「カレンダーと同期」で、そのPDFのバー全体を専用カレンダー「設備工程」の終日予定と双方向に一致させる（gcal.js）
//     カレンダー側の変更・削除・新規予定を取り込んでから、アプリ側の内容を送る。競合は「最後に変更した方を優先」
// PDFの描画には PDF.js（CDN）を使う。元のPDF画像は書き換えず、表示上の並べ替えだけで行を差し込む。
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { analyzePage } from "./reader.js";
import * as store from "./store.js";
import * as gcal from "./gcal.js";

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
const DEFAULT_BAR_CAP = "none"; // 新しく置くバーの端の形（始まり端・終わり端とも。store.BAR_CAPS の値）
// 両端とも「無し」のバーを、端の形を選べるようにする前の見た目（始まりの縦線＋終わりの矢印）で描くか。
// false＝「無し」は文字どおり何も付けない（ただの線）。確認事項の回答しだいで true に切り替える。
const CAP_LEGACY_WHEN_NONE = false;
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
// 編集画面（シート）
const sheetBackdrop = document.getElementById("sheet-backdrop");
const barSheetEl = document.getElementById("bar-sheet");
const barRowEl = document.getElementById("bar-sheet-row");
const barTaskEl = document.getElementById("bar-task");
const barStartEl = document.getElementById("bar-start");
const barEndEl = document.getElementById("bar-end");
const barStartSel = document.getElementById("bar-start-sel");
const barEndSel = document.getElementById("bar-end-sel");
const barDaysEl = document.getElementById("bar-days");
const barStartCapEl = document.getElementById("bar-start-cap");
const barEndCapEl = document.getElementById("bar-end-cap");
const barVendorEl = document.getElementById("bar-vendor");
const barErrEl = document.getElementById("bar-error");
const vendorSheetEl = document.getElementById("vendor-sheet");
const vendorListEl = document.getElementById("vendor-list");
const vendorFormTitle = document.getElementById("vendor-form-title");
const vendorNameEl = document.getElementById("vendor-name");
const vendorColorsEl = document.getElementById("vendor-colors");
const vendorErrEl = document.getElementById("vendor-error");
const btnVendorSave = document.getElementById("vendor-save");
const btnVendorFormCancel = document.getElementById("vendor-form-cancel");
// 現場名・Googleカレンダー連携
const sitePanel = document.getElementById("site-panel");
const siteNameEl = document.getElementById("site-name");
const btnGcalSync = document.getElementById("btn-gcal-sync");
const btnGcalSettings = document.getElementById("btn-gcal-settings");
const gcalStatusEl = document.getElementById("gcal-status");
const gcalResultEl = document.getElementById("gcal-result");
const gcalSheetEl = document.getElementById("gcal-sheet");
const gcalStateEl = document.getElementById("gcal-state");
const gcalClientEl = document.getElementById("gcal-client-id");
const gcalMsgEl = document.getElementById("gcal-msg");
const btnGcalConnect = document.getElementById("gcal-connect");
const btnGcalDisconnect = document.getElementById("gcal-disconnect");

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
  // 設備の行とバーは変更のたびに端末へ保存しているので、ふつうは確認しない（同じPDFを開き直せば元に戻る）。
  // 保存に失敗している場合だけ、消えることを確認する。
  if (hasEquipData() && saveStatus && !saveStatus.ok
      && !confirm("設備の行とバーを端末に保存できていません。\n別のPDFを開くと、保存できていない変更は消えます。開きますか？")) return;
  closeSheets();
  showMessage("読み込み中…");
  fileNameEl.textContent = file.name;
  resetAnalysis();
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    // PDFの同一性（保存分を引き当てる目印）。PDF.js に渡すとデータが移されて読めなくなるので、先に計算する
    const fileHash = await store.hashBytes(data);
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    docInfo = {
      id: fileHash, sig: null, replaceId: null,
      fileName: file.name, fileSize: file.size, numPages: pdfDoc.numPages, range: null,
      siteName: null,   // 現場名（null＝ファイル名のまま）
      syncKey: null,    // Googleカレンダーの予定に付ける、このPDFの目印（初めて同期するときに作る）
      lastSyncAt: null, // 最後に同期できた時刻（ミリ秒）
    };
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
      equip: new Map(), cuts: [], cutByRow: new Map(), insH: 0, colors: null, rowKeys: [],
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
  // 編集画面を開いているときは、Esc で閉じるだけ（文字入力中の Delete でバーが消えないように）
  if (isSheetOpen()) {
    if (e.key === "Escape") cancelSheet();
    return;
  }
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
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
  // 保存・復元
  docInfo = null;
  unplaced = [];
  calPending = [];
  pendingAssignUid = null;
  pendingMsg = "";
  restoreNote = "";
  saveStatus = null;
  syncNote = null;
  setEquipButton();
  updateEquipPanel();
  updateSitePanel();
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
  // 保存済みの設備の行とバーがあれば復元する
  prepareDocKeys(list);
  if (restoreSaved()) relayoutEquip();
  equipReady = list.some((p) => p.insH > 0);
  equipMode = equipReady; // 読み取りが終わったら、すぐ設備の行を入れられる状態にする
  // 描いた時点ではまだ編集できない状態だったので、復元したバーもつかめるよう切り替える
  for (const p of list) if (p.equipSvg) p.equipSvg.classList.toggle("editing", equipMode);
  setEquipButton();
  updateEquipPanel();
  updateSitePanel(); // 現場名と同期の帯（読み取りが終わってから。保存分の現場名を復元したあと）
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
  const any = !equipPanel.classList.contains("hidden") || !readPanel.classList.contains("hidden")
    || !sitePanel.classList.contains("hidden");
  dock.classList.toggle("hidden", !any);
}

// ======================================================================
// 設備の行の差し込み＋バーの配置
// ======================================================================
// データ（変更のたびに端末へ保存。保存の形は store.js の説明を参照）：
//   p.equip：Map（元の行の番号 0始まり → { rowIndex, bars: [{ id, start, end, task, vendorId, startCap, endCap, uid, gcalId, updatedAt, gcalUpdated, lastSyncSnapshot }], keep }）
//   uid：保存しても変わらないバーのid（カレンダーの予定の目印）。gcalId：対応するGoogleカレンダーの予定ID（未同期は null）。
//   updatedAt：ローカル最終変更時刻（ミリ秒。保存時はISO文字列）。gcalUpdated：前回同期時に見た予定の updated。
//   lastSyncSnapshot：前回同期時点の { task, vendorId, start, end }（日付はISO文字列）。双方向同期の変更判定に使う。
//   start・end：日付の列の番号（0始まり、両端を含む）。1列＝1日。保存するときは日付（YYYY-MM-DD）に直す。
//   task：作業内容（文字）。vendorId：業者のid（未設定は null）。
//   startCap・endCap：始まり端・終わり端の形（"none"｜"dot"｜"ring"｜"left"｜"right"。store.BAR_CAPS）。
//   keep：保存分のうち、この工程表の日付の範囲に入らず表示できなかったバー（消さずに保存し直す）。
// 選択：selection = null
//   | { kind: "row",   p, rowIndex }            元の行
//   | { kind: "equip", p, rowIndex, col }       差し込んだ設備の行（col：タップした日の列。日付の欄の外なら null）
//   | { kind: "bar",   p, rowIndex, barId }     バー
let equipMode = false;   // 設備の行・バーを編集できる状態か（「設備」ボタン）
let equipReady = false;  // 読み取りが終わり、差し込める行があるか
let selection = null;
let barDrag = null;      // バーをドラッグ中の情報
let barSeq = 0;

// 保存・復元
let docInfo = null;      // 開いているPDF：{ id（中身のハッシュ）, sig（中身の目印）, replaceId, fileName, fileSize, numPages, range }
let unplaced = [];       // 保存分のうち、行が見つからず表示できなかった設備の行（消さずに保存し直す）
let calPending = [];     // カレンダーから取り込んだが配置先の行が決まらなかったバー（保存形のまま保持。帯の一覧から割り当てる）
let pendingAssignUid = null; // 未配置バーの割り当て先の行を選んでいる最中のバーの uid
let pendingMsg = "";     // 未配置バーの割り当てに関するお知らせ（下の帯に出す）
let restoreNote = "";    // 復元したときのお知らせ（下の帯に出す）
let saveStatus = null;   // null（まだ保存していない）| { ok: true, at: Date } | { ok: false, msg }

// 業者マスタ
const UNSET_COLOR = "#8a8a8a"; // 業者未設定のバーの色（破線で表示）
let vendors = store.loadVendors();
let lastVendorId = null;       // 直前に選んだ業者（新しく置くバーに使う）
function vendorById(id) {
  return (id && vendors.find((v) => v.id === id)) || null;
}
store.requestPersist();

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
      lines.push(`  ・${rowFullName(p, c.rowIndex)}／${EQUIP_LABEL}：バー${bars.length}本`);
      for (const b of bars) {
        const v = vendorById(b.vendorId);
        const sc = store.normCap(b.startCap);
        const ec = store.normCap(b.endCap);
        const capLabel = (k) => store.BAR_CAPS.find((c) => c.value === k).label;
        const caps = sc === "none" && ec === "none" ? "" : `　端：${capLabel(sc)}／${capLabel(ec)}`;
        lines.push(`      ${barRangeText(p, b, false)}　${b.task ? `「${b.task}」` : "（作業内容なし）"}　${v ? v.name : "業者未設定"}${caps}`);
      }
      if (ins.keep && ins.keep.length) lines.push(`      ほかに日付の範囲外のバー ${ins.keep.length}本（保存のみ）`);
    }
  }
  if (unplaced.length) lines.push(`  ・行が見つからず表示していない設備の行：${unplaced.map((r) => r.key).join("、")}（保存のみ）`);
  if (!lines.length) return "";
  return `【設備の行】${lines.length}行（端末に保存）\n${lines.join("\n")}`;
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
    // 端の形（始まり端・終わり端）：矢印・縦線は polygon、丸は circle。使わないほうは隠す
    capS: { poly: svgEl("polygon", { class: "eq-bar-head" }, g), circ: svgEl("circle", { class: "eq-bar-cap" }, g) },
    capE: { poly: svgEl("polygon", { class: "eq-bar-head" }, g), circ: svgEl("circle", { class: "eq-bar-cap" }, g) },
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

// 端の形1つ分の形を決める。
//   kind：store.BAR_CAPS の値（＋前の見た目用の "tick"＝縦の短い線）
//   edge：バーの端の x（pt）。dir：バーの内側へ向かう向き（始まり端 +1／終わり端 -1）
//   形はすべてバーの日付の範囲（edge から内側）に収める（隣の日のマスにはみ出さない）
// 戻り値：{ lineX（横線をどこで止めるか）, poly（polygon の points。無ければ null）, circ（{ cx, r, ring }。無ければ null）}
function capGeom(kind, edge, dir, ly, a, r, sw) {
  if (kind === "dot" || kind === "ring") {
    const cx = edge + dir * r;
    // 塗りの丸は中心まで線を引く（丸で隠れる）。白抜きの丸は丸の内側に線が見えないよう、丸の手前で止める
    return { lineX: kind === "dot" ? cx : cx + dir * r, poly: null, circ: { cx, r, ring: kind === "ring" } };
  }
  if (kind === "left" || kind === "right") {
    const arrow = kind === "left" ? -1 : 1;   // 矢印の向き（記号どおり）
    const outward = arrow === -dir;            // バーの外向きか
    const tipX = outward ? edge : edge + dir * a;
    const baseX = outward ? edge + dir * a : edge;
    const h = a * 0.55;
    return {
      // 外向き：線は矢印の根元の少し先まで（すき間が出ないように）。内向き：線は端まで通し、矢印を上に重ねる
      lineX: outward ? edge + dir * a * 0.8 : edge,
      poly: `${tipX},${ly} ${baseX},${ly - h} ${baseX},${ly + h}`,
      circ: null,
    };
  }
  if (kind === "tick") {
    const hx = sw / 2;
    const x = edge + dir * hx;
    const t = a * 0.6;
    return { lineX: edge, poly: `${x - hx},${ly - t} ${x + hx},${ly - t} ${x + hx},${ly + t} ${x - hx},${ly + t}`, circ: null };
  }
  return { lineX: edge, poly: null, circ: null }; // 無し
}

function applyCap(capEls, geom, color, sw, ly) {
  showEl(capEls.poly, !!geom.poly);
  if (geom.poly) {
    setA(capEls.poly, { points: geom.poly });
    capEls.poly.style.fill = color;
  }
  showEl(capEls.circ, !!geom.circ);
  if (geom.circ) {
    const ring = geom.circ.ring;
    setA(capEls.circ, { cx: geom.circ.cx, cy: ly, r: ring ? Math.max(0.2, geom.circ.r - sw * 0.4) : geom.circ.r, "stroke-width": ring ? sw * 0.8 : 0 });
    capEls.circ.style.fill = ring ? "#ffffff" : color;
    capEls.circ.style.stroke = ring ? color : "none";
  }
}

// バーの見た目：横線＋両端の形（無し／●／○／←／→。バーごとに選べる）、線の上に作業内容（無ければ日付）。
function positionBar(p, cut, bar, els, lane, laneCount) {
  const cols = p.result.dates.columns;
  const x0 = cols[bar.start].x0;
  const x1 = cols[bar.end].x1;
  const w = x1 - x0;
  const laneH = p.insH / laneCount;
  const top = cut.dTop + lane * laneH;
  const ly = top + laneH * 0.66;
  const sw = Math.max(0.5, Math.min(1.3, laneH * 0.14));
  const a = Math.max(0.6, Math.min(laneH * 0.32, 2.8, w * 0.45));   // 矢印の長さ
  const cr = Math.max(0.5, Math.min(Math.max(sw * 1.6, a * 0.5), w * 0.22)); // 丸の半径（線の太さの約1.6倍。短いバーでは小さく）
  const fs = Math.max(2.2, Math.min(4.2, laneH * 0.38));
  // 端の形（保存データに無い・知らない値は「無し」）
  let sk = store.normCap(bar.startCap);
  let ek = store.normCap(bar.endCap);
  if (CAP_LEGACY_WHEN_NONE && sk === "none" && ek === "none") { sk = "tick"; ek = "right"; }
  const L = x0 + 0.4;
  const R = x1 - 0.4;
  const gs = capGeom(sk, L, 1, ly, a, cr, sw);
  const ge = capGeom(ek, R, -1, ly, a, cr, sw);
  setA(els.line, { x1: gs.lineX, y1: ly, x2: Math.max(gs.lineX, ge.lineX), y2: ly, "stroke-width": sw });
  setA(els.label, { x: x0 + 1, y: ly - sw / 2 - fs * 0.3, "font-size": fs });
  // 業者の色で表示（未設定は灰色の破線）。端の形も同じ色
  const v = vendorById(bar.vendorId);
  const color = v ? v.color : UNSET_COLOR;
  els.line.style.stroke = color;
  els.line.style.strokeDasharray = v ? "" : `${r1(sw * 2.5)} ${r1(sw * 1.5)}`;
  applyCap(els.capS, gs, color, sw, ly);
  applyCap(els.capE, ge, color, sw, ly);
  els.label.style.fill = color;
  els.label.textContent = bar.task ? bar.task : barShortLabel(cols, bar);
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
  const wasSelected = !!(selection && selection.kind === "bar" && selection.p === p && selection.barId === barId);
  barDrag = {
    id: e.pointerId, p, rowIndex, bar, mode,
    cx: e.clientX, cy: e.clientY, x: localX(p, e.clientX),
    start: bar.start, end: bar.end, moved: false, wasSelected,
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
  const { bar, p, rowIndex } = barDrag;
  const changed = barDrag.moved && (bar.start !== barDrag.start || bar.end !== barDrag.end);
  // 選んであるバーを、動かさずにもう一度タップしたら編集画面を開く
  const openEdit = e.type === "pointerup" && !barDrag.moved && barDrag.wasSelected;
  barDrag = null;
  hideTip();
  if (changed) { bar.updatedAt = Date.now(); equipChanged(); }
  updateEquipPanel();
  if (openEdit) openBarSheet(p, rowIndex, bar.id, false);
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
  p.equip.set(i, { rowIndex: i, bars: [], keep: [] });
  relayoutEquip();
  equipChanged();
  setSelection({ kind: "equip", p, rowIndex: i, col: null });
}

function removeEquipRow(p, i) {
  const ins = p.equip.get(i);
  if (!ins) return;
  const n = ins.bars.length + (ins.keep ? ins.keep.length : 0);
  if (n && !confirm(`「${rowFullName(p, i)}」の設備の行には、バーが${n}本あります。\nバーごと行を取り消しますか？（保存分からも消えます）`)) return;
  p.equip.delete(i);
  relayoutEquip();
  equipChanged();
  setSelection({ kind: "row", p, rowIndex: i });
}

// 「ここにバーを置く」：置いたらすぐ編集画面を開き、作業内容・業者を入れてもらう
function addBar(p, i, col) {
  const ins = p.equip.get(i);
  if (!ins) return;
  const n = p.result.dates.columns.length;
  const start = Math.min(n - 1, Math.max(0, col));
  const bar = {
    id: ++barSeq, start, end: Math.min(n - 1, start + DEFAULT_BAR_DAYS - 1),
    task: "", vendorId: vendorById(lastVendorId) ? lastVendorId : null,
    startCap: DEFAULT_BAR_CAP, endCap: DEFAULT_BAR_CAP,
    uid: store.newId("b"), gcalId: null,
    updatedAt: Date.now(), gcalUpdated: null, lastSyncSnapshot: null,
  };
  ins.bars.push(bar);
  drawEquip(p);
  equipChanged();
  setSelection({ kind: "bar", p, rowIndex: i, barId: bar.id });
  openBarSheet(p, i, bar.id, true);
}

function deleteBar(p, i, barId) {
  const ins = p.equip.get(i);
  if (!ins) return;
  ins.bars = ins.bars.filter((b) => b.id !== barId);
  drawEquip(p);
  equipChanged();
  setSelection({ kind: "equip", p, rowIndex: i, col: null });
}

// 設備の行・バーが変わったら：端末に保存し、「詳しく」の一覧も直す
function equipChanged() {
  saveDoc();
  refreshReportText();
}

function findBar(p, i, barId) {
  const ins = p.equip.get(i);
  return ins ? ins.bars.find((b) => b.id === barId) : null;
}

// ---- 未配置バー（カレンダーから取り込んだが、配置先の行が決まらなかったバー）----
function pendingLabel(b) {
  const d = (iso) => (iso ? iso.slice(5).replace("-", "/") : "?");
  return `${b.task || "（作業内容なし）"}（${d(b.start)}〜${d(b.end)}）`;
}
// 未配置バーを、選んだ行の下の設備の行へ割り当てる
function assignPending(p, rowIndex) {
  const idx = calPending.findIndex((b) => b.uid === pendingAssignUid);
  if (idx < 0) { pendingAssignUid = null; updateEquipPanel(); return; }
  const pb = calPending[idx];
  const cols = p.result.dates.columns;
  const s = dateToCol(cols, pb.start, null);
  const e = dateToCol(cols, pb.end, null);
  if (s === null || e === null || e < s) {
    pendingMsg = `「${pendingLabel(pb)}」は、この工程表の日付の範囲外のため割り当てられませんでした。`;
    pendingAssignUid = null;
    updateEquipPanel();
    return;
  }
  const isNewRow = !p.equip.has(rowIndex);
  if (isNewRow) p.equip.set(rowIndex, { rowIndex, bars: [], keep: [] });
  const bar = {
    id: ++barSeq, start: s, end: e, task: pb.task || "", vendorId: pb.vendorId || null,
    startCap: store.normCap(pb.startCap), endCap: store.normCap(pb.endCap),
    uid: pb.uid || store.newId("b"), gcalId: pb.gcalId || null,
    updatedAt: pb.updatedAt ? (Date.parse(pb.updatedAt) || Date.now()) : Date.now(),
    gcalUpdated: pb.gcalUpdated || null, lastSyncSnapshot: pb.lastSyncSnapshot || null,
  };
  p.equip.get(rowIndex).bars.push(bar);
  calPending.splice(idx, 1);
  pendingAssignUid = null;
  pendingMsg = `未配置バー「${pendingLabel(pb)}」を「${rowFullName(p, rowIndex)}」の設備の行へ割り当てました。`;
  if (isNewRow) relayoutEquip(); else drawEquip(p);
  equipChanged();
  setSelection({ kind: "bar", p, rowIndex, barId: bar.id });
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
      equipInfo.textContent = (restoreNote ? restoreNote + "\n" : "")
        + `表の行をタップして選ぶと、その下に「${EQUIP_LABEL}」の行を入れられます。（設備の行 ${rowsN}行・バー ${barsN}本）\n`
        + saveStatusText();
      if (pendingMsg) equipInfo.textContent += "\n" + pendingMsg;
      if (calPending.length) {
        equipInfo.textContent += `\n未配置バー ${calPending.length}本（カレンダーから取り込み）：`
          + calPending.map((b) => "\n・" + pendingLabel(b)).join("");
        if (pendingAssignUid) {
          equipInfo.textContent += "\n割り当て先の行をタップしてください。";
          addAction("割り当てをやめる", () => { pendingAssignUid = null; updateEquipPanel(); });
        } else {
          for (const b of calPending) {
            addAction(`「${b.task || "（作業内容なし）"}」を割り当てる`, () => { pendingAssignUid = b.uid; pendingMsg = ""; updateEquipPanel(); });
          }
        }
      }
      addAction("業者の登録・編集", () => openVendorSheet(false));
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
        if (pendingAssignUid) addAction("未配置バーをこの行へ割り当てる", () => assignPending(p, s.rowIndex), "primary");
      } else if (s.kind === "equip") {
        const ins = p.equip.get(s.rowIndex);
        const cols = p.result.dates.columns;
        equipInfo.textContent = `${base}／${EQUIP_LABEL}　バー${ins ? ins.bars.length : 0}本　`
          + (s.col !== null ? `選んだ日：${colDate(cols[s.col], true)}` : "（日付の欄をタップすると、その日にバーを置けます）");
        if (s.col !== null) addAction("ここにバーを置く", () => addBar(p, s.rowIndex, s.col), "primary");
        if (pendingAssignUid) addAction("未配置バーをこの行へ割り当てる", () => assignPending(p, s.rowIndex), "primary");
        addAction("設備の行を取り消す", () => removeEquipRow(p, s.rowIndex), "danger");
      } else if (s.kind === "bar") {
        const bar = findBar(p, s.rowIndex, s.barId);
        if (!bar) {
          selection = null;
          updateEquipPanel();
          return;
        }
        const v = vendorById(bar.vendorId);
        equipInfo.textContent = `${base}／${EQUIP_LABEL}\n${barRangeText(p, bar, true)}　`
          + `${bar.task ? `「${bar.task}」` : "（作業内容なし）"}　業者：${v ? v.name : "未設定"}`;
        if (!barDrag) {
          addAction("編集", () => openBarSheet(p, s.rowIndex, s.barId, false), "primary");
          addAction("バーを削除", () => deleteBar(p, s.rowIndex, s.barId), "danger");
        }
      }
      if (saveStatus && !saveStatus.ok) equipInfo.textContent += "\n" + saveStatusText();
      if (!barDrag) addAction("×", () => setSelection(null), "", "選択を解除");
    }
  }
  updateDock();
}

// ======================================================================
// 保存と復元（第2段階）
// ======================================================================
// ・変更（行の差し込み・取り消し、バーの追加・移動・伸縮・編集・削除）のたびに自動で保存する。
// ・PDFを開いて読み取りが終わったら、保存分を探して復元する。
//   探し方：①同じファイル（中身のハッシュ）→ ②同じ中身の目印（ページ数・日付の範囲・項目名の一覧）
// ・行は「棟名付きの項目名」（rowKeys）で、バーは「日付」で当てはめる。
const pad2 = (n) => String(n).padStart(2, "0");
function colISO(c) {
  return c && c.year && c.month ? `${c.year}-${pad2(c.month)}-${pad2(c.day)}` : null;
}

// 行の呼び名（保存のキー）：「棟名／項目名」。同じ呼び名が2つ目以降は「#2」などを付けて区別する
function rowKeyBase(row) {
  return (row.group ? row.group + "／" : "") + (row.name || "（項目名なし）");
}

// 各ページの行のキーと、PDFの中身の目印（sig）を作る
function prepareDocKeys(list) {
  const seen = new Map();
  const parts = [];
  let from = null;
  let to = null;
  for (const p of list) {
    p.rowKeys = [];
    const r = p.result;
    if (!r || !r.dates || !r.rows) { parts.push("-"); continue; }
    r.rows.items.forEach((row, i) => {
      const base = rowKeyBase(row);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      p.rowKeys[i] = n > 1 ? `${base}#${n}` : base;
    });
    const cols = r.dates.columns;
    const a = colISO(cols[0]);
    const b = colISO(cols[cols.length - 1]);
    if (!from && a) from = a;
    if (b) to = b;
    parts.push(`${a || "?" + cols[0].day}~${b || "?" + cols[cols.length - 1].day}/${cols.length}/${r.rows.items.length}/${store.hashText(p.rowKeys.join("\n"))}`);
  }
  if (docInfo) {
    docInfo.sig = `${list.length}p|${parts.join("|")}`;
    docInfo.range = { from, to };
  }
}

function findRowByKey(key) {
  for (const p of pages) {
    if (!p.insH) continue;
    const i = p.rowKeys.indexOf(key);
    if (i >= 0) return { p, i };
  }
  return null;
}

// 保存した日付 → 列の番号（無ければ null）。日付が無い保存分（月が読めなかった表）は列の番号で
function dateToCol(cols, iso, col) {
  if (iso) {
    const i = cols.findIndex((c) => colISO(c) === iso);
    return i >= 0 ? i : null;
  }
  return Number.isInteger(col) && col >= 0 && col < cols.length ? col : null;
}

// 保存分を探して復元する。行を1つでも復元したら true
function restoreSaved() {
  if (!docInfo || !docInfo.sig) return false;
  let found = null;
  try {
    found = store.findDoc(docInfo.id, docInfo.sig);
  } catch (err) {
    console.warn("保存分の読み込みに失敗", err);
  }
  if (!found) return false;
  const rec = found.rec;
  docInfo.replaceId = rec.id !== docInfo.id ? rec.id : null;
  // 現場名・カレンダー同期の目印（設備の行が無くても復元する）
  docInfo.siteName = typeof rec.siteName === "string" && rec.siteName.trim() ? rec.siteName.trim() : null;
  docInfo.syncKey = typeof rec.syncKey === "string" && rec.syncKey ? rec.syncKey : null;
  docInfo.lastSyncAt = Number.isFinite(rec.lastSyncAt) ? rec.lastSyncAt : null;
  // カレンダーから取り込んだ未配置バー（この項目が無い古い保存データでは空）
  calPending = (Array.isArray(rec.pendingBars) ? rec.pendingBars : [])
    .filter((b) => b && typeof b === "object" && (b.gcalId || b.uid));
  pendingAssignUid = null;
  pendingMsg = "";
  unplaced = [];
  let nRows = 0;
  let nBars = 0;
  let kept = 0;
  for (const r of rec.rows || []) {
    const t = findRowByKey(r.key);
    if (!t || t.p.equip.has(t.i)) { unplaced.push(r); continue; }
    const cols = t.p.result.dates.columns;
    const ins = { rowIndex: t.i, bars: [], keep: [] };
    for (const b of r.bars || []) {
      const s = dateToCol(cols, b.start, b.startCol);
      const e = dateToCol(cols, b.end, b.endCol);
      if (s === null || e === null || e < s) { ins.keep.push(b); kept++; continue; }
      // 端の形が無い古い保存データは「無し」として読む
      ins.bars.push({
        id: ++barSeq, start: s, end: e, task: b.task || "", vendorId: b.vendorId || null,
        startCap: store.normCap(b.startCap), endCap: store.normCap(b.endCap),
        // カレンダー同期用（この項目が無い古い保存データには新しく id を付ける。次の保存で書き込まれる）
        uid: typeof b.uid === "string" && b.uid ? b.uid : store.newId("b"),
        gcalId: typeof b.gcalId === "string" && b.gcalId ? b.gcalId : null,
        // 双方向同期用（無い古い保存データは「前回同期後の変更なし」として扱う）
        updatedAt: b.updatedAt ? (Date.parse(b.updatedAt) || null) : null,
        gcalUpdated: typeof b.gcalUpdated === "string" && b.gcalUpdated ? b.gcalUpdated : null,
        lastSyncSnapshot: (b.lastSyncSnapshot && typeof b.lastSyncSnapshot === "object")
          ? { task: b.lastSyncSnapshot.task || "", vendorId: b.lastSyncSnapshot.vendorId || null, start: b.lastSyncSnapshot.start || null, end: b.lastSyncSnapshot.end || null }
          : null,
      });
      nBars++;
    }
    t.p.equip.set(t.i, ins);
    nRows++;
  }
  const notes = [];
  if (!(rec.rows || []).length) {
    // 現場名だけの保存分（設備の行は無い）
  } else if (found.how === "file") notes.push(`前回保存した設備の行 ${nRows}行・バー ${nBars}本を復元しました。`);
  else notes.push(`同じ内容のPDF（${rec.fileName || "名前不明"}）で保存した設備の行 ${nRows}行・バー ${nBars}本を復元しました。`);
  if (calPending.length) notes.push(`※ カレンダーから取り込んだ未配置のバーが ${calPending.length}本あります（下の帯の一覧から割り当てられます）。`);
  if (unplaced.length) notes.push(`※ 行が見つからない設備の行が ${unplaced.length}行あり、表示していません（保存データには残しています）。`);
  if (kept) notes.push(`※ 工程表の日付の範囲外のバーが ${kept}本あり、表示していません（保存データには残しています）。`);
  restoreNote = notes.join("\n");
  return nRows > 0;
}

// 今の設備の行とバーを、保存する形に直す
function serializeRows() {
  const out = [];
  for (const p of pages) {
    if (!p.result || !p.result.rows || !p.result.dates) continue;
    const cols = p.result.dates.columns;
    for (const c of p.cuts) {
      const ins = p.equip.get(c.rowIndex);
      const row = p.result.rows.items[c.rowIndex];
      const bars = [...ins.bars]
        .sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id)
        .map((b) => ({
          task: b.task || "", vendorId: b.vendorId || null,
          start: colISO(cols[b.start]), end: colISO(cols[b.end]), startCol: b.start, endCol: b.end,
          startCap: store.normCap(b.startCap), endCap: store.normCap(b.endCap),
          uid: b.uid || null, gcalId: b.gcalId || null,
          updatedAt: b.updatedAt ? new Date(b.updatedAt).toISOString() : null,
          gcalUpdated: b.gcalUpdated || null,
          lastSyncSnapshot: b.lastSyncSnapshot || null,
        }));
      out.push({
        key: p.rowKeys[c.rowIndex], group: row.group || "", name: row.name || "", page: p.no, rowNo: row.no,
        bars: bars.concat(ins.keep || []),
      });
    }
  }
  return out.concat(unplaced);
}

function saveDoc() {
  if (!docInfo || !docInfo.sig) return;
  try {
    const rows = serializeRows();
    // 現場名を付けた・カレンダーと同期したPDFは、設備の行が無くても記録を残す
    // （同期の目印を消すと、カレンダーに作った予定をあとで消せなくなるため）
    if (rows.length || docInfo.siteName || docInfo.syncKey || calPending.length) {
      store.putDoc({
        id: docInfo.id, sig: docInfo.sig, fileName: docInfo.fileName, fileSize: docInfo.fileSize,
        numPages: docInfo.numPages, range: docInfo.range, rows,
        siteName: docInfo.siteName || null, syncKey: docInfo.syncKey || null, lastSyncAt: docInfo.lastSyncAt || null,
        pendingBars: calPending,
      }, docInfo.replaceId);
    } else {
      // 設備の行がすべて無くなったら、このPDFの記録ごと消す
      store.deleteDoc(docInfo.id);
      if (docInfo.replaceId) store.deleteDoc(docInfo.replaceId);
    }
    docInfo.replaceId = null;
    saveStatus = { ok: true, at: new Date() };
  } catch (err) {
    console.error("保存に失敗", err);
    saveStatus = { ok: false, msg: String((err && err.message) || err) };
  }
}

function saveStatusText() {
  if (!saveStatus) return "変更は自動で端末に保存され、同じPDFを開き直すと元に戻ります。";
  if (saveStatus.ok) return `端末に保存済み（${pad2(saveStatus.at.getHours())}:${pad2(saveStatus.at.getMinutes())}）。同じPDFを開き直すと元に戻ります。`;
  return `※ 端末に保存できませんでした（${saveStatus.msg}）。空き容量やプライベートブラウズを確認してください。`;
}

// ======================================================================
// 編集画面（シート）：バーの編集・業者マスタ
// ======================================================================
let barSheet = null;      // 編集中のバー：{ p, rowIndex, barId, cols, dateMode }
let vendorBack = false;   // 業者の画面を閉じたら、バーの編集画面に戻るか
let vendorEditId = null;  // 業者の画面で編集中の業者（null＝新しく登録）
let vendorColor = null;   // 業者の画面で選んでいる色
let lastAddedVendorId = null;

function isSheetOpen() {
  return !sheetBackdrop.classList.contains("hidden");
}
const ALL_SHEETS = [barSheetEl, vendorSheetEl, gcalSheetEl];
function showSheet(el) {
  sheetBackdrop.classList.remove("hidden");
  for (const s of ALL_SHEETS) s.classList.toggle("hidden", s !== el);
}
function closeSheets() {
  sheetBackdrop.classList.add("hidden");
  for (const s of ALL_SHEETS) s.classList.add("hidden");
  barSheet = null;
  vendorBack = false;
}
// Esc・背景のタップ：今の画面を閉じる（業者の画面からはバーの編集画面に戻る）
function cancelSheet() {
  if (!vendorSheetEl.classList.contains("hidden")) closeVendorSheet();
  else closeSheets();
}
sheetBackdrop.addEventListener("click", (e) => {
  if (e.target === sheetBackdrop) cancelSheet();
});

// ---- バーの編集 ----
function openBarSheet(p, rowIndex, barId, isNew) {
  const bar = findBar(p, rowIndex, barId);
  if (!bar) return;
  const cols = p.result.dates.columns;
  // 全部の列に年月日が読めていれば日付の入力欄、読めない列があれば列の一覧から選ぶ形にする
  const dateMode = cols.every((c) => colISO(c));
  barSheet = { p, rowIndex, barId, cols, dateMode };
  document.getElementById("bar-sheet-title").textContent = isNew ? "バーを置きました：内容を入れてください" : "バーの編集";
  barRowEl.textContent = `${rowFullName(p, rowIndex)}／${EQUIP_LABEL}`;
  barTaskEl.value = bar.task || "";
  for (const [inp, sel, v] of [[barStartEl, barStartSel, bar.start], [barEndEl, barEndSel, bar.end]]) {
    inp.classList.toggle("hidden", !dateMode);
    sel.classList.toggle("hidden", dateMode);
    if (dateMode) {
      inp.min = colISO(cols[0]);
      inp.max = colISO(cols[cols.length - 1]);
      inp.value = colISO(cols[v]);
    } else {
      sel.textContent = "";
      cols.forEach((c, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = colDate(c, true);
        sel.appendChild(o);
      });
      sel.value = String(v);
    }
  }
  barStartCapEl.value = store.normCap(bar.startCap);
  barEndCapEl.value = store.normCap(bar.endCap);
  fillVendorSelect(bar.vendorId);
  barErrEl.textContent = "";
  updateBarDays();
  showSheet(barSheetEl);
}

// 端の形の選択肢（始まり端・終わり端とも同じ5つ）
for (const sel of [barStartCapEl, barEndCapEl]) {
  for (const c of store.BAR_CAPS) {
    const o = document.createElement("option");
    o.value = c.value;
    o.textContent = c.label;
    sel.appendChild(o);
  }
}

function fillVendorSelect(selectedId) {
  barVendorEl.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = vendors.length ? "（未設定）" : "（未設定：先に業者を登録してください）";
  barVendorEl.appendChild(none);
  for (const v of vendors) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `● ${v.name}`;
    o.style.color = v.color;
    barVendorEl.appendChild(o);
  }
  barVendorEl.value = vendorById(selectedId) ? selectedId : "";
  updateVendorSwatch();
}
function updateVendorSwatch() {
  const v = vendorById(barVendorEl.value);
  barVendorEl.style.borderLeftColor = v ? v.color : UNSET_COLOR;
}

// 入力欄から列の番号を読む。null＝未入力、-1＝工程表にない日付
function readBarCol(inp, sel) {
  if (!barSheet) return null;
  if (!barSheet.dateMode) return sel.value === "" ? null : Number(sel.value);
  if (!inp.value) return null;
  const i = barSheet.cols.findIndex((c) => colISO(c) === inp.value);
  return i >= 0 ? i : -1;
}
function rangeText(cols) {
  return `${colDate(cols[0], true)}〜${colDate(cols[cols.length - 1], true)}`;
}
function checkBarDates() {
  const cols = barSheet.cols;
  const s = readBarCol(barStartEl, barStartSel);
  const e = readBarCol(barEndEl, barEndSel);
  if (s === null || e === null) return { err: "開始日と終了日を入れてください。" };
  if (s === -1 || e === -1) return { err: `この工程表にない日付です。${rangeText(cols)} の間で選んでください。` };
  if (e < s) return { err: "終了日が開始日より前になっています。" };
  return { s, e };
}
function updateBarDays() {
  if (!barSheet) return;
  const r = checkBarDates();
  if (r.err) {
    barDaysEl.textContent = r.err;
    barDaysEl.classList.add("warn");
  } else {
    const cols = barSheet.cols;
    barDaysEl.textContent = `${colDate(cols[r.s], false)}〜${colDate(cols[r.e], false)}（${r.e - r.s + 1}日間）`;
    barDaysEl.classList.remove("warn");
  }
}
for (const el of [barStartEl, barEndEl, barStartSel, barEndSel]) {
  el.addEventListener("input", updateBarDays);
  el.addEventListener("change", updateBarDays);
}
barVendorEl.addEventListener("change", updateVendorSwatch);
barTaskEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commitBarSheet(); }
});

function commitBarSheet() {
  if (!barSheet) return;
  const { p, rowIndex, barId } = barSheet;
  const bar = findBar(p, rowIndex, barId);
  if (!bar) { closeSheets(); return; }
  const r = checkBarDates();
  if (r.err) { barErrEl.textContent = r.err; return; }
  bar.task = barTaskEl.value.trim();
  bar.start = r.s;
  bar.end = r.e;
  bar.vendorId = barVendorEl.value || null;
  bar.startCap = store.normCap(barStartCapEl.value);
  bar.endCap = store.normCap(barEndCapEl.value);
  bar.updatedAt = Date.now();
  if (bar.vendorId) lastVendorId = bar.vendorId;
  closeSheets();
  drawEquip(p);
  equipChanged();
  setSelection({ kind: "bar", p, rowIndex, barId });
}

document.getElementById("bar-ok").addEventListener("click", commitBarSheet);
document.getElementById("bar-cancel").addEventListener("click", closeSheets);
document.getElementById("bar-delete").addEventListener("click", () => {
  if (!barSheet) return;
  const { p, rowIndex, barId } = barSheet;
  closeSheets();
  deleteBar(p, rowIndex, barId);
});
document.getElementById("bar-vendor-manage").addEventListener("click", () => openVendorSheet(true));

// ---- 業者マスタ ----
function openVendorSheet(fromBar) {
  vendorBack = !!(fromBar && barSheet);
  lastAddedVendorId = null;
  resetVendorForm();
  renderVendorList();
  showSheet(vendorSheetEl);
}
function closeVendorSheet() {
  if (vendorBack && barSheet) {
    // バーの編集画面に戻る（入力途中の内容はそのまま。新しく登録した業者があれば選んでおく）
    fillVendorSelect(lastAddedVendorId || barVendorEl.value);
    vendorBack = false;
    showSheet(barSheetEl);
  } else {
    closeSheets();
  }
}
document.getElementById("vendor-close").addEventListener("click", closeVendorSheet);

function renderVendorList() {
  vendorListEl.textContent = "";
  if (!vendors.length) {
    const li = document.createElement("li");
    li.className = "vendor-empty";
    li.textContent = "まだ登録がありません。下の欄から登録してください。";
    vendorListEl.appendChild(li);
    return;
  }
  for (const v of vendors) {
    const li = document.createElement("li");
    li.className = "vendor-item" + (v.id === vendorEditId ? " editing" : "");
    const sw = document.createElement("span");
    sw.className = "vendor-swatch";
    sw.style.background = v.color;
    const name = document.createElement("span");
    name.className = "vendor-name";
    name.textContent = v.name;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn-small";
    edit.textContent = "編集";
    edit.addEventListener("click", () => startEditVendor(v));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-small danger";
    del.textContent = "削除";
    del.addEventListener("click", () => deleteVendor(v));
    li.append(sw, name, edit, del);
    vendorListEl.appendChild(li);
  }
}

function renderColorChoices() {
  vendorColorsEl.textContent = "";
  for (const c of store.VENDOR_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "color-choice" + (c.color === vendorColor ? " selected" : "");
    b.style.background = c.color;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", c.color === vendorColor ? "true" : "false");
    b.setAttribute("aria-label", c.name);
    b.title = c.name;
    // 他の業者が使っている色には小さな印（同じ色も選べるが、見分けにくくなるため）
    const usedBy = vendors.filter((v) => v.color === c.color && v.id !== vendorEditId);
    if (usedBy.length) {
      b.classList.add("used");
      b.title += `（使用中：${usedBy.map((v) => v.name).join("、")}）`;
    }
    b.addEventListener("click", () => { vendorColor = c.color; renderColorChoices(); });
    vendorColorsEl.appendChild(b);
  }
}

function resetVendorForm() {
  vendorEditId = null;
  vendorNameEl.value = "";
  // まだ誰も使っていない色を最初に選んでおく
  const free = store.VENDOR_COLORS.find((c) => !vendors.some((v) => v.color === c.color));
  vendorColor = (free || store.VENDOR_COLORS[vendors.length % store.VENDOR_COLORS.length]).color;
  vendorFormTitle.textContent = "新しい業者を登録";
  btnVendorSave.textContent = "登録";
  btnVendorFormCancel.classList.add("hidden");
  vendorErrEl.textContent = "";
  renderColorChoices();
}

function startEditVendor(v) {
  vendorEditId = v.id;
  vendorNameEl.value = v.name;
  vendorColor = v.color;
  vendorFormTitle.textContent = `「${v.name}」を編集`;
  btnVendorSave.textContent = "変更を保存";
  btnVendorFormCancel.classList.remove("hidden");
  vendorErrEl.textContent = "";
  renderColorChoices();
  renderVendorList();
  vendorNameEl.focus();
}

function saveVendor() {
  const name = vendorNameEl.value.trim();
  if (!name) { vendorErrEl.textContent = "業者名を入れてください。"; return; }
  if (vendors.some((v) => v.name === name && v.id !== vendorEditId)) {
    vendorErrEl.textContent = "同じ名前の業者がすでに登録されています。";
    return;
  }
  const before = vendors;
  if (vendorEditId) {
    vendors = vendors.map((v) => (v.id === vendorEditId ? { ...v, name, color: vendorColor } : v));
  } else {
    const v = { id: store.newId("v"), name, color: vendorColor };
    vendors = [...vendors, v];
    lastAddedVendorId = v.id;
  }
  try {
    store.saveVendors(vendors);
  } catch (err) {
    vendors = before;
    vendorErrEl.textContent = "端末に保存できませんでした：" + ((err && err.message) || err);
    return;
  }
  resetVendorForm();
  renderVendorList();
  vendorsChanged();
}

function deleteVendor(v) {
  let n = 0;
  try { n = store.countVendorUse(v.id); } catch { /* 数えられなくても消せる */ }
  const msg = `業者「${v.name}」を削除しますか？`
    + (n ? `\n\n保存済みのバー ${n}本で使われています。削除すると、そのバーは「業者未設定」（灰色の破線）になります。` : "");
  if (!confirm(msg)) return;
  const before = vendors;
  vendors = vendors.filter((x) => x.id !== v.id);
  try {
    store.saveVendors(vendors);
    store.clearVendorRefs(v.id);
  } catch (err) {
    vendors = before;
    vendorErrEl.textContent = "端末に保存できませんでした：" + ((err && err.message) || err);
    return;
  }
  // 開いているPDFのバー（表示できなかった保存分も含む）からも外す
  const clear = (b) => { if (b.vendorId === v.id) b.vendorId = null; };
  for (const p of pages) {
    for (const ins of p.equip.values()) { ins.bars.forEach(clear); (ins.keep || []).forEach(clear); }
  }
  for (const r of unplaced) (r.bars || []).forEach(clear);
  if (lastVendorId === v.id) lastVendorId = null;
  if (lastAddedVendorId === v.id) lastAddedVendorId = null;
  if (hasEquipData()) saveDoc();
  if (vendorEditId === v.id) resetVendorForm();
  else renderColorChoices();
  renderVendorList();
  vendorsChanged();
}

// 業者の名前・色が変わったら、バーを描き直す
function vendorsChanged() {
  for (const p of pages) if (p.equipSvg) drawEquip(p);
  applySelectionVisuals();
  refreshReportText();
  updateEquipPanel();
}

btnVendorSave.addEventListener("click", saveVendor);
btnVendorFormCancel.addEventListener("click", () => { resetVendorForm(); renderVendorList(); });
vendorNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveVendor(); }
});

// ======================================================================
// 現場名とGoogleカレンダー連携
// ======================================================================
// ・現場名：PDF（保存ドキュメント）ごと。初期値はファイル名（拡張子なし）。変えたら保存する。
// ・「カレンダーと同期」：そのPDFのバー全体を、専用カレンダー「設備工程」の終日予定と双方向に一致させる。
//   1. 専用カレンダーを用意（無ければ作る）
//   2. 先にカレンダー→アプリを取り込む（pull）：
//      ・目印付き予定について、前回同期時のスナップショット／gcalUpdated と予定の updated を比べ、
//        カレンダー側だけが変わっていればバーを更新。両方が変わっていれば「最後に変更した方を優先」
//        （バーの updatedAt と予定の updated を比較し、新しい方を勝たせる）。
//      ・カレンダー側で削除された予定は、バーがローカル変更されていなければバーを削除し、
//        変更されていれば削除を取り消して手順3で予定を作り直す。
//      ・カレンダー側の新規予定（目印付きで未知の uid、または目印なしで場所が現場名と一致するもの）を
//        新規バーとして取り込む。説明欄の「項目：」で配置先の行を特定し、無ければ設備行を自動で差し込む。
//        特定できなければ「未配置バー」として保存し、帯の一覧から割り当て直せるようにする。
//   3. 次にアプリ→カレンダー（push）：バーごとに、対応する予定があれば内容が違うときだけ更新、無ければ作成。
//   4. 3がすべて成功したときだけ、どのバーにも対応しない目印付き予定を削除する。
//   途中でエラー（期限切れ・通信失敗など）になったら、そこで止める。作った予定のIDはその都度バーに記録するので、
//   もう一度同期しても二重にはならない。削除は最後にしか行わないので、途中で止まって予定が消えることはない。
//   ※ 現場名（location）はアプリ側を正とし、取り込みでは書き換えない（違いは push でアプリ側に戻す）。
//   ※ バーの端の形などカレンダーに無い情報は、取り込み更新時もローカルの値を保持する。
let syncing = false;
let syncNote = null; // null | { kind: "ok" | "error" | "busy", text }

function defaultSiteName() {
  const n = docInfo ? (docInfo.fileName || "").replace(/\.[^./\\]+$/, "").trim() : "";
  return n || "現場名なし";
}
function siteNameOf() {
  return (docInfo && docInfo.siteName) || defaultSiteName();
}

let siteSaveTimer = 0;
// final：入力を終えたとき（空なら初期値＝ファイル名に戻す）
function commitSiteName(final) {
  clearTimeout(siteSaveTimer);
  if (!docInfo || !docInfo.sig) return;
  const v = siteNameEl.value.trim();
  if (final && !v) siteNameEl.value = defaultSiteName();
  const next = v && v !== defaultSiteName() ? v : null;
  if (next === (docInfo.siteName || null)) return;
  docInfo.siteName = next;
  saveDoc();
  updateEquipPanel(); // 保存できなかったときの表示
  updateSitePanel();
}
siteNameEl.addEventListener("input", () => {
  clearTimeout(siteSaveTimer);
  siteSaveTimer = setTimeout(() => commitSiteName(false), 600);
});
siteNameEl.addEventListener("change", () => commitSiteName(true));
siteNameEl.addEventListener("blur", () => commitSiteName(true));
siteNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); siteNameEl.blur(); }
});

function gcalStateText() {
  if (!gcal.getClientId()) return "Googleカレンダー：未設定（「連携設定」でクライアントIDを入れて接続してください）";
  if (gcal.hasToken(0)) return `Googleカレンダー：接続中（同期先：専用カレンダー「${gcal.CAL_NAME}」）`;
  if (gcal.wasConnected()) return "Googleカレンダー：接続済み（有効期限切れ。同期のときに自動で接続し直します）";
  return "Googleカレンダー：未接続（「連携設定」で「接続」を押してください）";
}
function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function updateSitePanel() {
  const show = !!(docInfo && docInfo.sig);
  sitePanel.classList.toggle("hidden", !show);
  if (show) {
    if (document.activeElement !== siteNameEl) siteNameEl.value = siteNameOf();
    siteNameEl.placeholder = defaultSiteName();
    btnGcalSync.disabled = syncing;
    btnGcalSync.textContent = syncing ? "同期中…" : "カレンダーと同期";
    gcalStatusEl.textContent = gcalStateText() + "　"
      + (docInfo.lastSyncAt ? `前回の同期：${fmtTime(docInfo.lastSyncAt)}` : "このPDFはまだ同期していません。");
    gcalResultEl.textContent = syncNote ? syncNote.text : "";
    gcalResultEl.className = "gcal-result" + (syncNote && syncNote.kind !== "ok" ? " " + syncNote.kind : "");
  }
  updateDock();
}
function setSyncNote(kind, text) {
  syncNote = { kind, text };
  updateSitePanel();
}
// 接続の残り時間などの表示を、1分ごとに更新する
setInterval(() => {
  if (!syncing && !sitePanel.classList.contains("hidden")) updateSitePanel();
  if (isSheetOpen() && !gcalSheetEl.classList.contains("hidden")) renderGcalSheet();
}, 60_000);

// 予定のタイトル：「作業内容（業者名）」。業者が未設定なら「作業内容」のみ。
// 現場名はタイトルに入れず、予定の「場所」（location）に入れる（2026-11-26 ユーザー指示）
function eventTitle(bar) {
  const v = vendorById(bar.vendorId);
  return `${bar.task || EQUIP_LABEL}${v ? `（${v.name}）` : ""}`;
}
// 予定の説明欄：棟名付きの項目名・業者名・期間など
function eventDescription(p, rowIndex, bar, site) {
  const v = vendorById(bar.vendorId);
  return [
    `項目：${rowFullName(p, rowIndex)}／${EQUIP_LABEL}`,
    `業者：${v ? v.name : "未設定"}`,
    `期間：${barRangeText(p, bar, true)}`,
    `作業内容：${bar.task || "（未入力）"}`,
    `現場：${site}`,
    "",
    "※ 設備工程管理アプリと同期した予定です。カレンダー側で変更・削除すると、次の同期でアプリに取り込まれます。",
  ].join("\n");
}

// ---- 「カレンダーと同期」ボタン ----
// ※ 接続の取り直し（Googleの画面）はクリックの中で await より前に始める必要があるので、ここは同期的に進める
btnGcalSync.addEventListener("click", () => {
  if (syncing || !docInfo || !docInfo.sig) return;
  commitSiteName(true); // 入力途中の現場名を先に確定
  if (!gcal.getClientId()) {
    setSyncNote("error", "Googleカレンダー連携がまだ設定されていないため、同期していません。「連携設定」でクライアントIDを入れて「接続」してください。");
    openGcalSheet("先に、Google Cloud Console で作ったOAuthクライアントIDを入れて「接続」を押してください（作り方は下の「クライアントIDの作り方」）。", false);
    return;
  }
  if (!gcal.wasConnected() && !gcal.hasToken()) {
    setSyncNote("error", "Googleカレンダーに未接続のため、同期していません。「連携設定」で「接続」を押してください。");
    openGcalSheet("「接続」を押して、Googleアカウントでカレンダーへのアクセスを許可してください。", false);
    return;
  }
  if (navigator.onLine === false) {
    setSyncNote("error", "インターネットにつながっていないため、同期していません（カレンダーの予定は変えていません）。");
    return;
  }
  if (saveStatus && !saveStatus.ok) {
    setSyncNote("error", "端末への保存ができていないため、同期を止めました（予定とバーの対応を記録できないため）。");
    return;
  }
  if (gcal.hasToken()) { runSync(); return; }
  // 有効期限切れ：このクリックの中で静かに取り直す（許可済みなら、Googleの画面は出てもすぐ閉じる）
  const doc = docInfo;
  syncing = true;
  setSyncNote("busy", "Googleカレンダーに接続し直しています…");
  gcal.requestToken(false).then(() => {
    syncing = false;
    if (docInfo === doc) runSync(); else updateSitePanel();
  }, (err) => {
    syncing = false;
    if (docInfo !== doc) { updateSitePanel(); return; }
    setSyncNote("error", "Googleカレンダーとの接続の有効期限が切れていて、自動で接続し直せませんでした。同期はしていません（カレンダーの予定は変えていません）。\n"
      + `「連携設定」で「接続」を押し直してください。（${err.message}）`);
  });
});

// ---- 双方向同期の補助 ----
// バーの「前回同期時点」の姿（保存形：日付はISO文字列）
function barSnapshotOf(bar, cols) {
  return { task: bar.task || "", vendorId: bar.vendorId || null, start: colISO(cols[bar.start]), end: colISO(cols[bar.end]) };
}
function snapEq(a, b) {
  return !!a && !!b && (a.task || "") === (b.task || "") && (a.vendorId || null) === (b.vendorId || null)
    && a.start === b.start && a.end === b.end;
}
// ローカル側が前回同期後に変わったか（スナップショットが無い古い保存データは「変更なし」として扱う）
function barLocallyChanged(bar, cols) {
  if (!bar.lastSyncSnapshot) return false;
  return !snapEq(bar.lastSyncSnapshot, barSnapshotOf(bar, cols));
}
// タイトル「作業内容（業者名）」の解析。末尾の括弧内は業者名として分離する
function parseEventTitle(summary) {
  const s = (summary || "").trim();
  const m = s.match(/[（(]([^（）()]*)[）)]\s*$/);
  if (m && m[1].trim()) {
    return { task: s.slice(0, m.index).trim(), vendorName: m[1].trim() };
  }
  return { task: s, vendorName: null };
}
// 業者名から業者を引く。無ければ自動登録する（未使用の色から割り当てる）
function ensureVendorByName(name) {
  const found = vendors.find((v) => v.name === name);
  if (found) return found;
  const free = store.VENDOR_COLORS.find((c) => !vendors.some((v) => v.color === c.color));
  const v = { id: store.newId("v"), name, color: (free || store.VENDOR_COLORS[vendors.length % store.VENDOR_COLORS.length]).color };
  vendors = [...vendors, v];
  try { store.saveVendors(vendors); } catch (err) { console.warn("業者の自動登録を保存できませんでした", err); }
  return v;
}
// 予定の日付範囲（両端を含むISO文字列）。終日予定は end が翌日指定なので1日戻す
function tokyoDateOf(dt) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dt);
    const g = (t) => (parts.find((x) => x.type === t) || {}).value || "";
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch { return dt.toISOString().slice(0, 10); }
}
function eventDateRange(ev) {
  if (!ev || !ev.start) return null;
  let start = null;
  let end = null;
  if (ev.start.date) {
    start = ev.start.date;
    end = ev.end && ev.end.date ? gcal.prevDay(ev.end.date) : start;
  } else if (ev.start.dateTime) {
    const sd = new Date(ev.start.dateTime);
    if (Number.isNaN(sd.getTime())) return null;
    start = tokyoDateOf(sd);
    if (ev.end && ev.end.dateTime) {
      const ed = new Date(ev.end.dateTime);
      end = tokyoDateOf(ed);
      // 終了が東京時間でちょうど0時のときは、その前日までが期間
      const tp = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(ed);
      if (tp === "00:00" || tp === "24:00") end = gcal.prevDay(end);
    } else end = start;
  }
  if (!start || !end || end < start) return null;
  return { start, end };
}
// 説明欄の「項目：…」から配置先の行の呼び名を取り出す（末尾の「／設備工事」を外す）
function eventRowKey(ev) {
  const desc = (ev && ev.description) || "";
  for (const line of desc.split("\n")) {
    const t = line.trim();
    if (t.startsWith("項目：") || t.startsWith("項目:")) {
      let v = t.slice(3).trim();
      if (v.endsWith(`／${EQUIP_LABEL}`)) v = v.slice(0, -(`／${EQUIP_LABEL}`).length);
      v = v.replace(/^\d+ページ目\s+/, ""); // 複数ページのとき rowFullName に付く前置き
      return v || null;
    }
  }
  return null;
}
function findRowByDescKey(key) {
  if (!key) return null;
  for (const p of pages) {
    if (!p.rowKeys) continue;
    for (let i = 0; i < p.rowKeys.length; i++) {
      if (p.rowKeys[i] === key || p.rowKeys[i].startsWith(key + "#")) return { p, i };
    }
  }
  return null;
}
// カレンダーの予定の内容をバーに取り込む（端の形などカレンダーに無い情報は保持する）
function applyEventToBar(bar, p, ev) {
  const cols = p.result.dates.columns;
  const range = eventDateRange(ev);
  const { task, vendorName } = parseEventTitle(ev.summary);
  bar.task = task;
  bar.vendorId = vendorName ? ensureVendorByName(vendorName).id : null;
  let datesApplied = !range;
  if (range) {
    const s = dateToCol(cols, range.start, null);
    const e = dateToCol(cols, range.end, null);
    if (s !== null && e !== null && e >= s) { bar.start = s; bar.end = e; datesApplied = true; }
    // 工程表の範囲外の日付は取り込まない（タイトル・業者だけ取り込み、日付は push でアプリ側に戻る。仮決め：進捗メモ参照）
  }
  bar.updatedAt = (ev.updated && Date.parse(ev.updated)) || Date.now();
  if (datesApplied) {
    // 取り込んだ内容を「同期済み」として記録し、続く push で無駄に更新し直さない
    bar.gcalUpdated = ev.updated || null;
    bar.lastSyncSnapshot = barSnapshotOf(bar, cols);
  }
}

async function runSync() {
  const doc = docInfo;
  if (!doc || !doc.sig || syncing) return;
  syncing = true;
  // pull：カレンダーから／push：カレンダーへ
  const n = {
    pullAdd: 0, pullUpd: 0, pullDel: 0,
    created: 0, updated: 0, deleted: 0, same: 0, conflicts: 0,
  };
  const checkDoc = () => {
    if (docInfo !== doc) throw new gcal.GcalError("abort", "別のPDFを開いたため、同期を途中で止めました。");
  };
  const saveIfSame = () => { if (docInfo === doc) saveDoc(); };
  setSyncNote("busy", "Googleカレンダーと同期しています…");
  let calCreated = false;
  let noDate = 0;
  try {
    if (!doc.syncKey) {
      doc.syncKey = store.newId("d");
      saveDoc();
      if (!saveStatus || !saveStatus.ok) throw new gcal.GcalError("save", "端末に保存できないため、同期を止めました。");
    }
    const site = siteNameOf();

    const cal = await gcal.ensureCalendar();
    calCreated = cal.created;
    checkDoc();
    const tagged = await gcal.listDocEvents(cal.id, doc.syncKey);
    checkDoc();
    const allEvents = await gcal.listAllEvents(cal.id);
    checkDoc();
    const taggedById = new Map(tagged.map((ev) => [ev.id, ev]));
    const allById = new Map(allEvents.map((ev) => [ev.id, ev]));
    const taggedByUid = new Map();
    for (const ev of tagged) {
      const u = gcal.eventBarUid(ev);
      if (u && !taggedByUid.has(u)) taggedByUid.set(u, ev);
    }
    const findEvForBar = (bar) => (bar.gcalId && (taggedById.get(bar.gcalId) || allById.get(bar.gcalId)))
      || taggedByUid.get(bar.uid) || null;

    // ===== 手順2：カレンダー→アプリ（pull）=====
    // 既知の uid・予定ID（表示中バー＋表示していない保存分＋未配置バー）
    const knownUids = new Set();
    const knownEvIds = new Set();
    const collectKnown = (b) => { if (!b) return; if (b.uid) knownUids.add(b.uid); if (b.gcalId) knownEvIds.add(b.gcalId); };
    for (const p of pages) for (const ins of p.equip.values()) { ins.bars.forEach(collectKnown); (ins.keep || []).forEach(collectKnown); }
    for (const r of unplaced) (r.bars || []).forEach(collectKnown);
    calPending.forEach(collectKnown);

    // 2a・2b：既存バーの更新と、カレンダー側削除の反映
    for (const p of pages) {
      if (!p.result || !p.result.dates) continue;
      const cols = p.result.dates.columns;
      for (const ins of [...p.equip.values()]) {
        const keptBars = [];
        for (const bar of ins.bars) {
          if (!bar.uid) bar.uid = store.newId("b");
          const ev = findEvForBar(bar);
          const wasSynced = !!(bar.gcalId || bar.gcalUpdated || bar.lastSyncSnapshot);
          if (!ev) {
            if (wasSynced && bar.gcalId && !allById.has(bar.gcalId)) {
              // 2b：カレンダー側で削除された
              if (barLocallyChanged(bar, cols)) {
                bar.gcalId = null; // 削除を取り消し、手順3で作り直す
                bar.gcalUpdated = null;
                bar.lastSyncSnapshot = null;
                keptBars.push(bar);
              } else {
                n.pullDel++; // バーも削除する
              }
              continue;
            }
            keptBars.push(bar);
            continue;
          }
          // カレンダー側が変わったか
          let calChanged;
          if (bar.gcalUpdated) calChanged = ev.updated !== bar.gcalUpdated;
          else if (bar.lastSyncSnapshot) {
            const r = eventDateRange(ev);
            const { task, vendorName } = parseEventTitle(ev.summary);
            const evSnap = { task, vendorId: vendorName ? (vendors.find((v) => v.name === vendorName) || {}).id || null : null, start: r && r.start, end: r && r.end };
            calChanged = !snapEq(bar.lastSyncSnapshot, evSnap);
          } else calChanged = false; // 古い保存データ：変更なしとして扱う
          const localChanged = barLocallyChanged(bar, cols);
          if (calChanged && !localChanged) {
            applyEventToBar(bar, p, ev);
            n.pullUpd++;
          } else if (calChanged && localChanged) {
            n.conflicts++;
            const evTime = (ev.updated && Date.parse(ev.updated)) || 0;
            if (!(bar.updatedAt && bar.updatedAt > evTime)) {
              applyEventToBar(bar, p, ev); // カレンダーの方が新しい（同点もカレンダー優先）
              n.pullUpd++;
            }
            // ローカルの方が新しければバーをそのままにし、手順3でカレンダーへ上書きする
          }
          keptBars.push(bar);
        }
        ins.bars = keptBars;
      }
    }

    // 2c：カレンダー側の新規予定の取り込み
    const importEvent = (ev) => {
      if (calPending.some((b) => b.gcalId === ev.id)) return;
      const range = eventDateRange(ev);
      if (!range) return;
      const { task, vendorName } = parseEventTitle(ev.summary);
      const vendorId = vendorName ? ensureVendorByName(vendorName).id : null;
      const uid = gcal.eventBarUid(ev) || store.newId("b");
      const snapshot = { task, vendorId, start: range.start, end: range.end };
      const target = findRowByDescKey(eventRowKey(ev));
      let placed = false;
      if (target) {
        const cols = target.p.result.dates.columns;
        const s = dateToCol(cols, range.start, null);
        const e = dateToCol(cols, range.end, null);
        if (s !== null && e !== null && e >= s) {
          if (!target.p.equip.has(target.i)) target.p.equip.set(target.i, { rowIndex: target.i, bars: [], keep: [] });
          target.p.equip.get(target.i).bars.push({
            id: ++barSeq, start: s, end: e, task, vendorId,
            startCap: DEFAULT_BAR_CAP, endCap: DEFAULT_BAR_CAP,
            uid, gcalId: ev.id,
            updatedAt: (ev.updated && Date.parse(ev.updated)) || Date.now(),
            gcalUpdated: ev.updated || null, lastSyncSnapshot: snapshot,
          });
          placed = true;
        }
      }
      if (placed) n.pullAdd++;
      else {
        calPending.push({
          task, vendorId, start: range.start, end: range.end, startCol: null, endCol: null,
          startCap: DEFAULT_BAR_CAP, endCap: DEFAULT_BAR_CAP,
          uid, gcalId: ev.id,
          updatedAt: ev.updated || new Date().toISOString(),
          gcalUpdated: ev.updated || null, lastSyncSnapshot: snapshot,
        });
      }
    };
    for (const ev of tagged) {
      const u = gcal.eventBarUid(ev);
      if (u && knownUids.has(u)) continue;
      if (knownEvIds.has(ev.id)) continue;
      importEvent(ev);
      if (u) knownUids.add(u);
      knownEvIds.add(ev.id);
    }
    for (const ev of allEvents) {
      if (gcal.isAppEvent(ev)) continue; // 目印付きは上で処理（ほかのPDFの目印付き予定には触らない）
      if (knownEvIds.has(ev.id)) continue;
      if ((ev.location || "") !== site) continue; // 場所が現場名と一致するものだけ
      importEvent(ev);
      knownEvIds.add(ev.id);
    }
    if (n.pullAdd || n.pullUpd || n.pullDel || calPending.length) {
      relayoutEquip();
      saveIfSame();
    }

    // ===== 手順3：アプリ→カレンダー（push）=====
    const want = [];
    const keepIds = new Set(); // 消さない予定：表示していない保存分・日付が読めないバー・未配置バーに対応する予定
    for (const p of pages) {
      if (!p.result || !p.result.dates || !p.result.rows) continue;
      const cols = p.result.dates.columns;
      for (const c of p.cuts) {
        const ins = p.equip.get(c.rowIndex);
        if (!ins) continue;
        for (const bar of ins.bars) {
          if (!bar.uid) bar.uid = store.newId("b");
          const s = colISO(cols[bar.start]);
          const e = colISO(cols[bar.end]);
          if (!s || !e) {
            noDate++;
            if (bar.gcalId) keepIds.add(bar.gcalId);
            continue;
          }
          want.push({
            bar, p, cols,
            body: gcal.makeEvent({
              summary: eventTitle(bar), location: site, description: eventDescription(p, c.rowIndex, bar, site),
              start: s, end: e, docKey: doc.syncKey, barUid: bar.uid,
            }),
          });
        }
        for (const b of ins.keep || []) if (b.gcalId) keepIds.add(b.gcalId);
      }
    }
    for (const r of unplaced) for (const b of r.bars || []) if (b.gcalId) keepIds.add(b.gcalId);
    for (const b of calPending) if (b.gcalId) keepIds.add(b.gcalId);

    const used = new Set();
    for (const w of want) {
      checkDoc();
      let ev = (w.bar.gcalId && (taggedById.get(w.bar.gcalId) || allById.get(w.bar.gcalId)))
        || taggedByUid.get(w.bar.uid) || null;
      if (ev && used.has(ev.id)) ev = null;
      const snap = barSnapshotOf(w.bar, w.cols);
      if (ev) {
        used.add(ev.id);
        if (w.bar.gcalId !== ev.id) { w.bar.gcalId = ev.id; }
        // 前回同期から両方とも変わっていなければ、説明文の書式差などで無駄に更新しない
        const untouched = w.bar.lastSyncSnapshot && snapEq(w.bar.lastSyncSnapshot, snap)
          && w.bar.gcalUpdated && ev.updated === w.bar.gcalUpdated;
        if (untouched || gcal.sameEvent(ev, w.body)) {
          n.same++;
          w.bar.gcalUpdated = ev.updated || w.bar.gcalUpdated;
          w.bar.lastSyncSnapshot = snap;
        } else {
          const res = await gcal.updateEvent(cal.id, ev.id, w.body);
          n.updated++;
          w.bar.gcalUpdated = (res && res.updated) || ev.updated || w.bar.gcalUpdated;
          w.bar.lastSyncSnapshot = snap;
        }
        saveIfSame();
      } else {
        const made = await gcal.createEvent(cal.id, w.body);
        used.add(made.id);
        w.bar.gcalId = made.id;
        w.bar.gcalUpdated = (made && made.updated) || w.bar.gcalUpdated;
        w.bar.lastSyncSnapshot = snap;
        n.created++;
        saveIfSame(); // 予定IDをすぐ記録（途中で止まっても、次の同期で二重に作らない）
      }
    }
    // バーが消えた予定の削除（作成・更新がすべて成功したときだけ。対象はこのPDFの目印付き予定のみ）
    for (const ev of tagged) {
      if (used.has(ev.id) || keepIds.has(ev.id)) continue;
      checkDoc();
      await gcal.deleteEvent(cal.id, ev.id);
      n.deleted++;
    }
    checkDoc();
    doc.lastSyncAt = Date.now();
    saveDoc();
    let text = `同期しました（${fmtTime(doc.lastSyncAt)}）：カレンダーから 追加 ${n.pullAdd}件・更新 ${n.pullUpd}件・削除 ${n.pullDel}件／カレンダーへ 作成 ${n.created}件・更新 ${n.updated}件・削除 ${n.deleted}件（変更なし ${n.same}件、競合で上書き ${n.conflicts}件、未配置 ${calPending.length}件）`;
    if (calCreated) text += `\n専用カレンダー「${gcal.CAL_NAME}」を新しく作りました。`;
    if (noDate) text += `\n※ 日付（月）が読めない列にあるバー ${noDate}本は同期していません。`;
    if (keepIds.size) text += `\n※ 同期の対象外のバー（表示していない保存分・日付が読めないもの・未配置）の予定 ${keepIds.size}件は、そのまま残しています。`;
    if (calPending.length) text += `\n※ 未配置バーは、画面下の帯の一覧から行を選んで割り当てられます。`;
    if (saveStatus && !saveStatus.ok) text += "\n※ 予定IDを端末に保存できませんでした。";
    syncNote = { kind: saveStatus && !saveStatus.ok ? "error" : "ok", text };
  } catch (err) {
    console.error("カレンダーの同期に失敗", err);
    if (docInfo === doc) {
      const known = err instanceof gcal.GcalError;
      const reason = known ? err.message : `思わぬエラーが起きました（${(err && err.message) || err}）。`;
      const hint = !known ? ""
        : err.kind === "expired" ? "もう一度「カレンダーと同期」を押してください（自動で接続し直します）。"
          : err.kind === "network" ? "電波のよい所で、もう一度「カレンダーと同期」を押してください。"
            : err.kind === "denied" ? "「連携設定」で「接続」を押し直してください。"
              : "";
      const done = n.pullAdd + n.pullUpd + n.pullDel + n.created + n.updated + n.deleted;
      syncNote = {
        kind: "error",
        text: `同期を途中で止めました。${reason}${hint ? "\n" + hint : ""}\n`
          + (done
            ? `（止まるまでに：カレンダーから 追加 ${n.pullAdd}件・更新 ${n.pullUpd}件・削除 ${n.pullDel}件／カレンダーへ 作成 ${n.created}件・更新 ${n.updated}件・削除 ${n.deleted}件。作った予定はバーと対応づけて記録済みなので、もう一度同期しても二重にはなりません。消える予定の削除は、全部の作成・更新が済んでから行います）`
            : "（カレンダーの予定は変えていません）"),
      };
    }
  } finally {
    syncing = false;
    if (docInfo === doc) {
      refreshReportText();
      updateEquipPanel();
      updateSitePanel();
    }
  }
}

// ---- 連携設定の画面 ----
function setGcalMsg(text, kind = "error") {
  gcalMsgEl.textContent = text;
  gcalMsgEl.classList.toggle("info", kind === "info");
}
function renderGcalSheet() {
  let s;
  if (!gcal.getClientId()) s = "状態：未設定（クライアントIDを入れてください）";
  else if (gcal.hasToken(0)) s = `状態：接続中（あと約${gcal.tokenMinutesLeft()}分有効。切れたら、同期のときに自動で取り直します）`;
  else if (gcal.wasConnected()) s = "状態：接続済み・有効期限切れ（同期のときに自動で接続し直します。うまくいかないときは「接続」を押してください）";
  else s = "状態：未接続";
  gcalStateEl.textContent = s;
  btnGcalDisconnect.disabled = !(gcal.wasConnected() || gcal.hasToken(0));
  btnGcalConnect.textContent = gcal.hasToken(0) ? "接続し直す" : "接続";
}
function openGcalSheet(note = "", isError = false) {
  gcalClientEl.value = gcal.getClientId();
  setGcalMsg(note, isError ? "error" : "info");
  renderGcalSheet();
  gcal.loadGis().catch(() => {}); // 「接続」を押したときにすぐGoogleの画面を出せるよう、先に読み込んでおく
  showSheet(gcalSheetEl);
}
// 入力欄のクライアントIDを保存する（形が違えば false）
function applyClientIdInput() {
  const v = gcalClientEl.value.trim();
  if (v && !gcal.isValidClientId(v)) {
    setGcalMsg("クライアントIDの形が違います。「〜.apps.googleusercontent.com」で終わる文字を、そのまま貼り付けてください。");
    return false;
  }
  if (v !== gcal.getClientId()) {
    gcal.setClientId(v);
    syncNote = null;
    setGcalMsg(v ? "クライアントIDを保存しました。「接続」を押してください。" : "クライアントIDを消しました。", "info");
  }
  renderGcalSheet();
  updateSitePanel();
  return true;
}
gcalClientEl.addEventListener("change", applyClientIdInput);
gcalClientEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); gcalClientEl.blur(); }
});
btnGcalConnect.addEventListener("click", () => {
  if (!applyClientIdInput()) return;
  if (!gcal.getClientId()) { setGcalMsg("クライアントIDを入れてください。"); return; }
  setGcalMsg("Googleの画面で、アカウントを選んでカレンダーへのアクセスを許可してください…", "info");
  gcal.requestToken(true).then(async () => {
    renderGcalSheet();
    updateSitePanel();
    setGcalMsg(`接続しました。専用カレンダー「${gcal.CAL_NAME}」を確認しています…`, "info");
    try {
      const c = await gcal.ensureCalendar();
      setGcalMsg(`接続しました。専用カレンダー「${gcal.CAL_NAME}」を${c.created ? "新しく作りました" : "確認しました"}。`
        + "画面下の「カレンダーと同期」で予定を送れます。", "info");
    } catch (err) {
      setGcalMsg(`接続はできましたが、専用カレンダーを用意できませんでした。${err.message}`);
    }
  }, (err) => {
    setGcalMsg(err.message);
    renderGcalSheet();
    updateSitePanel();
  });
});
btnGcalDisconnect.addEventListener("click", async () => {
  if (!confirm("Googleカレンダーとの接続を解除しますか？\n（作成済みの予定は、カレンダー「設備工程」に残ります）")) return;
  const revoked = await gcal.disconnect();
  syncNote = null;
  renderGcalSheet();
  updateSitePanel();
  setGcalMsg(revoked
    ? "接続を解除しました。"
    : "接続を解除しました。（Google側の許可も外すには、Googleアカウントの「サードパーティ製のアプリとサービス」から外してください）", "info");
});
document.getElementById("gcal-close").addEventListener("click", closeSheets);
btnGcalSettings.addEventListener("click", () => openGcalSheet());
// クライアントIDが設定済みなら、Googleのログイン部品を先に読み込んでおく（同期ボタンですぐ接続し直せるように）
if (gcal.getClientId()) gcal.loadGis().catch(() => {});

// ---- PWA：サービスワーカー登録（http/https のときだけ） ----
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("サービスワーカー登録失敗", err));
}
