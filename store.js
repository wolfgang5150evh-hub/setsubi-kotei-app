// 端末内への保存（第2段階：設備工程のデータ化と保存）
//
// 保存先：localStorage（文字だけの小さなデータなので、同期で確実に書ける localStorage にした。
//   量が増えて足りなくなったら、この1ファイルの中身を IndexedDB に差し替えればよい）。
//
// 保存するもの：
//   1. 業者マスタ   KEY_VENDORS → [{ id, name, color }]
//   2. 設備工程     KEY_DOCS    → { [PDFのid]: 記録 }
//      記録 = {
//        id,        PDFのid（ファイルの中身のハッシュ "sha256:…"）
//        sig,       中身の目印（ページ数・各ページの日付の範囲・列数・行数・項目名の一覧のハッシュ）
//        fileName, fileSize, numPages,
//        range:     { from: "2026-10-23", to: "2026-12-21" }（工程表の日付の範囲）
//        createdAt, updatedAt（ミリ秒）
//        rows: [{
//          key,     差し込んだ建築の行の呼び名（棟名付き）。例「第二十二アパート／14階 (2部屋)」
//                   同じ呼び名が2つ目以降なら末尾に「#2」など。項目名のない行は「（項目名なし）」
//          group, name, page, rowNo,（参考：棟名・項目名・ページ・何行目か）
//          bars: [{ task（作業内容）, vendorId（業者のid。未設定は null）,
//                   start, end（日付 "YYYY-MM-DD"。両端を含む。月が読めなかったときだけ null）,
//                   startCol, endCol（参考：日付の列の番号。日付が null のときの予備）,
//                   startCap, endCap（始まり端・終わり端の形。BAR_CAPS の値。
//                     この項目が無い古い保存データは "none"＝無し として読む → normCap）}]
//        }]
//      }
//   → 設備工程は「日付」と「差し込んだ建築の行の項目名（棟名付き）」で引ける（findBars）。
//     次の段階（新しい月のPDFへの入れ直し）は、この key と日付を使って行を探す。

const PREFIX = "setsubi-kotei.v1.";
const KEY_VENDORS = PREFIX + "vendors";
const KEY_DOCS = PREFIX + "docs";

// 業者の色の候補（白・黄色・橙色の列の上でも見分けやすい濃いめの色）
export const VENDOR_COLORS = [
  { color: "#d32f2f", name: "赤" },
  { color: "#ef6c00", name: "橙" },
  { color: "#795548", name: "茶" },
  { color: "#2e7d32", name: "緑" },
  { color: "#00897b", name: "青緑" },
  { color: "#0288d1", name: "水色" },
  { color: "#1565c0", name: "青" },
  { color: "#283593", name: "紺" },
  { color: "#6a1b9a", name: "紫" },
  { color: "#ad1457", name: "赤紫" },
  { color: "#c51162", name: "桃" },
  { color: "#37474f", name: "墨" },
];

// バーの端の形（始まり端・終わり端で共通の5種類）。value が保存される値
//   ← → は記号の向きのまま描く（← は常に左向き、→ は常に右向き）。
//   つまり 始まり端の「←」・終わり端の「→」が外向き、始まり端の「→」・終わり端の「←」が内向き。
export const BAR_CAPS = [
  { value: "none", label: "無し" },
  { value: "dot", label: "●（塗りの丸）" },
  { value: "ring", label: "○（白抜きの丸）" },
  { value: "left", label: "←" },
  { value: "right", label: "→" },
];
// 保存データの値を端の形にそろえる（項目が無い・知らない値は「無し」）
export function normCap(v) {
  return BAR_CAPS.some((c) => c.value === v) ? v : "none";
}

function readJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch (err) {
    console.warn("保存データの読み込みに失敗", key, err);
    return fallback;
  }
}
// 書けないとき（容量不足・プライベートモードなど）は例外をそのまま投げる（呼び出し側で「保存できませんでした」と出す）
function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function newId(prefix = "") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- 業者マスタ ----
export function loadVendors() {
  const v = readJSON(KEY_VENDORS, []);
  return Array.isArray(v) ? v.filter((x) => x && x.id && typeof x.name === "string") : [];
}
export function saveVendors(list) {
  writeJSON(KEY_VENDORS, list);
}

// ---- 設備工程（PDFごとの記録）----
function loadDocs() {
  const d = readJSON(KEY_DOCS, {});
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/**
 * 開いたPDFの保存分を探す。
 *   1. 同じファイル（中身のハッシュが同じ。ファイル名が変わっていても当たる）
 *   2. 同じ中身の目印（ページ数・日付の範囲・行の項目名がすべて同じ。PDFを作り直した・送り直した場合）
 * @returns { rec, how: "file" | "content" } または null
 */
export function findDoc(id, sig) {
  const docs = loadDocs();
  if (id && docs[id]) return { rec: docs[id], how: "file" };
  if (sig) {
    let best = null;
    for (const r of Object.values(docs)) {
      if (r && r.sig === sig && (!best || (r.updatedAt || 0) > (best.updatedAt || 0))) best = r;
    }
    if (best) return { rec: best, how: "content" };
  }
  return null;
}

// 記録を書く。replaceId：中身の目印で見つけた古い記録（別ファイル）を、今のファイルの記録に置き換えるとき
export function putDoc(rec, replaceId = null) {
  const docs = loadDocs();
  const old = docs[rec.id] || (replaceId && docs[replaceId]);
  rec.createdAt = (old && old.createdAt) || Date.now();
  rec.updatedAt = Date.now();
  if (replaceId && replaceId !== rec.id) delete docs[replaceId];
  docs[rec.id] = rec;
  writeJSON(KEY_DOCS, docs);
}

export function deleteDoc(id) {
  const docs = loadDocs();
  if (!(id in docs)) return;
  delete docs[id];
  writeJSON(KEY_DOCS, docs);
}

export function listDocs() {
  return Object.values(loadDocs()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 業者が何本のバーで使われているか（保存済みの全PDF）
export function countVendorUse(vendorId) {
  let n = 0;
  for (const r of Object.values(loadDocs())) {
    for (const row of (r && r.rows) || []) for (const b of row.bars || []) if (b.vendorId === vendorId) n++;
  }
  return n;
}

// 業者を消したとき、保存済みのバーからその業者を外す（「未設定」にする）
export function clearVendorRefs(vendorId) {
  const docs = loadDocs();
  let changed = false;
  for (const r of Object.values(docs)) {
    for (const row of (r && r.rows) || []) {
      for (const b of row.bars || []) if (b.vendorId === vendorId) { b.vendorId = null; changed = true; }
    }
  }
  if (changed) writeJSON(KEY_DOCS, docs);
}

/**
 * 日付と項目名（棟名付き）でバーを引く（次の段階の入れ直しで使う入口）。
 * @param rowKey 例「第二十二アパート／14階 (2部屋)」（省略可）
 * @param date   例「2026-11-05」（省略可。その日を含むバーだけ）
 * @returns [{ docId, fileName, rowKey, bar }]
 */
export function findBars({ rowKey = null, date = null } = {}) {
  const out = [];
  for (const r of listDocs()) {
    for (const row of r.rows || []) {
      if (rowKey && row.key !== rowKey) continue;
      for (const bar of row.bars || []) {
        if (date && !(bar.start && bar.end && bar.start <= date && date <= bar.end)) continue;
        out.push({ docId: r.id, fileName: r.fileName, rowKey: row.key, bar });
      }
    }
  }
  return out;
}

// ---- ハッシュ（PDFの同一性の判定に使う）----
// ファイルの中身（バイト列）の SHA-256。使えない環境（http の別端末など）では FNV-1a（64bit 相当）で代用する。
export async function hashBytes(bytes) {
  try {
    if (globalThis.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (err) {
    console.warn("SHA-256 が使えないため簡易ハッシュで代用", err);
  }
  // FNV-1a を2系統（初期値違い）で回して 64bit 相当にする
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) + i;
  }
  return "fnv:" + bytes.length.toString(36) + ":" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

// 文字列の短いハッシュ（中身の目印に使う。FNV-1a 32bit）
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ブラウザに「この保存データを勝手に消さないで」と頼む（対応していない環境では何もしない）
export function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* 何もしない */ }
}
