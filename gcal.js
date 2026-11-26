// Googleカレンダー連携（サーバーなし）
//
// しくみ：
//   ・Google Identity Services（GIS）の「トークンクライアント」で、利用者のアクセストークンを受け取る。
//     クライアントIDは利用者が Google Cloud Console で作り、アプリの「連携設定」で入れる（localStorage に保存）。
//   ・Calendar API（https://www.googleapis.com/calendar/v3）を fetch で直接呼ぶ。
//   ・予定は専用カレンダー「設備工程」だけに作る。ほかのカレンダーには触らない。
//   ・双方向同期：カレンダー側の変更・削除・新規予定の取り込みは app.js の同期処理が行う
//     （このファイルは API の呼び出しと予定の形だけを担当する）。
//   ・アプリが作った予定には extendedProperties.private に目印を付ける：
//       setsubiKotei="1"、setsubiDoc＝PDFごとの同期キー、setsubiBar＝バーごとのid
//     → 同期のときは「このPDFの目印が付いた予定」だけを読み、作成・更新・削除する。
//
// トークン：メモリの中だけに持つ（端末に保存しない）。有効期限（ふつう1時間）が切れたら、
//   「同期」ボタンを押したときに、そのクリックの中で静かに取り直す（prompt: ""）。
//   取り直せなければ「連携設定」で接続し直してもらう。

const KEY_CFG = "setsubi-kotei.v1.gcal"; // { clientId, connected, calendarId }
export const SCOPE = "https://www.googleapis.com/auth/calendar";
export const CAL_NAME = "設備工程";
const API = "https://www.googleapis.com/calendar/v3";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const TAG_APP = "setsubiKotei";
const TAG_DOC = "setsubiDoc";
const TAG_BAR = "setsubiBar";

// エラーの種類（kind）：
//   "noclient"（クライアントID未設定）｜"gis"（Googleのログイン部品が読めない）｜"auth"（接続できない）
//   ｜"denied"（許可されなかった）｜"expired"（期限切れ）｜"network"（通信失敗）｜"http"（APIのエラー）｜"abort"
export class GcalError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

let cfg = readCfg();
let token = null; // { value, expiresAt（ミリ秒）}

function readCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY_CFG) || "{}");
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}
function writeCfg() {
  try {
    localStorage.setItem(KEY_CFG, JSON.stringify(cfg));
  } catch (err) {
    console.warn("連携設定を保存できませんでした", err);
  }
}

// ---- 設定 ----
export function getClientId() {
  return typeof cfg.clientId === "string" ? cfg.clientId : "";
}
export function isValidClientId(s) {
  return /^[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(s);
}
// クライアントIDを変えたら、接続・専用カレンダーの記録は消す（別のプロジェクト・アカウントの可能性があるため）
export function setClientId(id) {
  id = (id || "").trim();
  if (id !== getClientId()) {
    token = null;
    cfg = id ? { clientId: id } : {};
    writeCfg();
  }
  if (id) loadGis().catch(() => {});
}

export function hasToken(marginMs = 60_000) {
  return !!(token && token.expiresAt - marginMs > Date.now());
}
export function tokenMinutesLeft() {
  return token ? Math.max(0, Math.floor((token.expiresAt - Date.now()) / 60000)) : 0;
}
// 一度でも接続して、まだ「解除」していないか（トークンの期限が切れていても true）
export function wasConnected() {
  return !!cfg.connected;
}

// ---- Google Identity Services の読み込み ----
let gisPromise = null;
export function gisReady() {
  return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
}
export function loadGis() {
  if (gisReady()) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => {
      if (gisReady()) resolve();
      else { gisPromise = null; reject(new GcalError("gis", "Googleのログイン部品を読み込めませんでした。")); }
    };
    s.onerror = () => {
      gisPromise = null;
      s.remove();
      reject(new GcalError("gis", "Googleのログイン部品を読み込めませんでした（インターネットの接続を確認してください）。"));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/**
 * アクセストークンを受け取る。
 * ※ ボタンを押した処理の中で（await より前に）呼ぶこと。Googleの画面（ポップアップ）がブロックされないようにするため。
 * @param interactive true＝「接続」ボタン（アカウントを選んでもらう）／false＝静かに取り直す（許可済みなら画面はすぐ閉じる）
 */
export function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!getClientId()) {
      reject(new GcalError("noclient", "クライアントIDが設定されていません。「連携設定」で入れてください。"));
      return;
    }
    if (!gisReady()) {
      loadGis().catch(() => {});
      reject(new GcalError("gis", "Googleのログイン部品を読み込み中です（または読み込めません）。インターネットにつながっているか確認し、数秒待ってからもう一度押してください。"));
      return;
    }
    const oauth2 = window.google.accounts.oauth2;
    // Googleの画面から何も返ってこないまま止まらないよう、2分で打ち切る
    const timer = setTimeout(() => {
      reject(new GcalError("auth", "Googleの画面から応答がありませんでした。もう一度押してください。"));
    }, 120_000);
    let client;
    try {
      client = oauth2.initTokenClient({
        client_id: getClientId(),
        scope: SCOPE,
        callback: (resp) => {
          clearTimeout(timer);
          if (!resp || resp.error) {
            const code = resp && resp.error;
            reject(new GcalError(code === "access_denied" ? "denied" : "auth",
              code === "access_denied"
                ? "Googleカレンダーへのアクセスが許可されませんでした。"
                : `Googleに接続できませんでした（${(resp && (resp.error_description || resp.error)) || "不明な理由"}）。`));
            return;
          }
          if (!oauth2.hasGrantedAllScopes(resp, SCOPE)) {
            reject(new GcalError("denied", "Googleカレンダーへのアクセスが許可されませんでした。接続し直して、カレンダーへのアクセスにチェックを入れてください。"));
            return;
          }
          token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
          cfg.connected = true;
          writeCfg();
          resolve();
        },
        error_callback: (err) => {
          clearTimeout(timer);
          const t = err && err.type;
          reject(new GcalError("auth",
            t === "popup_closed" ? "Googleの画面が閉じられたため、接続していません。"
              : t === "popup_failed_to_open" ? "Googleの画面（ポップアップ）を開けませんでした。ポップアップのブロックを解除してください。"
                : `Googleに接続できませんでした（${t || "不明な理由"}）。`));
        },
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new GcalError("auth", `Googleに接続できませんでした（${(err && err.message) || err}）。クライアントIDが正しいか確認してください。`));
      return;
    }
    client.requestAccessToken({ prompt: interactive ? "select_account" : "" });
  });
}

// 接続を解除する（受け取った許可を取り消す。作成済みの予定はカレンダーに残る）
export function disconnect() {
  const t = token && token.value;
  token = null;
  delete cfg.connected;
  delete cfg.calendarId;
  writeCfg();
  return new Promise((resolve) => {
    if (t && gisReady()) {
      try { window.google.accounts.oauth2.revoke(t, () => resolve(true)); } catch { resolve(false); }
    } else {
      resolve(false); // トークンが手元に無いので、Google側の許可は残る（Googleアカウントの設定から外せる）
    }
  });
}

// ---- Calendar API ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { query = null, body = null } = {}) {
  if (!hasToken(0)) throw new GcalError("expired", "Googleカレンダーとの接続の有効期限が切れました。");
  const url = new URL(API + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const headers = { Authorization: `Bearer ${token.value}` };
      if (body) headers["Content-Type"] = "application/json";
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    } catch {
      throw new GcalError("network", navigator.onLine === false
        ? "インターネットにつながっていません。"
        : "Googleカレンダーと通信できませんでした（電波・接続を確認してください）。");
    }
    if (res.status === 401) {
      token = null;
      throw new GcalError("expired", "Googleカレンダーとの接続の有効期限が切れました。", 401);
    }
    if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
    let info = null;
    try { info = await res.json(); } catch { /* 本文なし */ }
    const reason = (info && info.error && info.error.errors && info.error.errors[0] && info.error.errors[0].reason) || "";
    const msg = (info && info.error && info.error.message) || res.statusText || "";
    // 混み合い・一時的なエラーは、少し待って3回まで繰り返す
    const busy = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(reason));
    if (busy && attempt < 3) {
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(reason + " " + msg)) {
      throw new GcalError("http", "Google Cloud のプロジェクトで「Google Calendar API」が有効になっていません。Google Cloud Console で有効にしてください。", 403);
    }
    if (res.status === 403 && /insufficient/i.test(reason + " " + msg)) {
      throw new GcalError("denied", "Googleカレンダーへのアクセスが許可されていません。「連携設定」で接続し直してください。", 403);
    }
    throw new GcalError("http", `Googleカレンダーがエラーを返しました（${res.status}${msg ? "：" + msg : ""}）。`, res.status);
  }
}

const enc = encodeURIComponent;

/**
 * 専用カレンダー「設備工程」を用意する（覚えているidが無効なら、自分が持ち主のカレンダーから同じ名前を探し、無ければ作る）。
 * @returns { id, created }
 */
export async function ensureCalendar() {
  if (cfg.calendarId) {
    try {
      const c = await api("GET", `/calendars/${enc(cfg.calendarId)}`);
      if (c && c.id) return { id: c.id, created: false };
    } catch (err) {
      if (!(err.status === 404 || err.status === 410)) throw err;
    }
    delete cfg.calendarId; // 消された・別のアカウント → 探し直す
    writeCfg();
  }
  let pageToken = null;
  do {
    const list = await api("GET", "/users/me/calendarList", { query: { minAccessRole: "owner", maxResults: 250, pageToken } });
    const hit = ((list && list.items) || []).find((c) => c.summary === CAL_NAME && !c.deleted);
    if (hit) {
      cfg.calendarId = hit.id;
      writeCfg();
      return { id: hit.id, created: false };
    }
    pageToken = list && list.nextPageToken;
  } while (pageToken);
  const cal = await api("POST", "/calendars", {
    body: {
      summary: CAL_NAME,
      description: "設備工程管理アプリと同期する専用のカレンダーです。アプリで作った予定は目印付きです。カレンダー側で変更・削除した内容や、場所が現場名と一致する新規予定は、次の同期でアプリに取り込まれます。",
      timeZone: "Asia/Tokyo",
    },
  });
  cfg.calendarId = cal.id;
  writeCfg();
  return { id: cal.id, created: true };
}

// このPDF（同期キー）の目印が付いた予定をすべて読む
export async function listDocEvents(calId, docKey) {
  const out = [];
  let pageToken = null;
  do {
    const r = await api("GET", `/calendars/${enc(calId)}/events`, {
      query: { privateExtendedProperty: `${TAG_DOC}=${docKey}`, maxResults: 2500, showDeleted: "false", pageToken },
    });
    out.push(...((r && r.items) || []));
    pageToken = r && r.nextPageToken;
  } while (pageToken);
  return out;
}

// 専用カレンダーの予定をすべて読む（目印なしの新規予定の取り込み判定に使う。ほかのカレンダーには触らない）
export async function listAllEvents(calId) {
  const out = [];
  let pageToken = null;
  do {
    const r = await api("GET", `/calendars/${enc(calId)}/events`, {
      query: { maxResults: 2500, showDeleted: "false", singleEvents: "true", pageToken },
    });
    out.push(...((r && r.items) || []));
    pageToken = r && r.nextPageToken;
  } while (pageToken);
  return out;
}

export function createEvent(calId, body) {
  return api("POST", `/calendars/${enc(calId)}/events`, { body });
}
// 全体を置き換える（カレンダー側で時刻付きの予定に変えられていても、終日予定に戻せるように）
export function updateEvent(calId, eventId, body) {
  return api("PUT", `/calendars/${enc(calId)}/events/${enc(eventId)}`, { body });
}
export async function deleteEvent(calId, eventId) {
  try {
    await api("DELETE", `/calendars/${enc(calId)}/events/${enc(eventId)}`);
  } catch (err) {
    if (err.status === 404 || err.status === 410) return; // すでに無い
    throw err;
  }
}

// ---- 予定の形 ----
// "2026-11-13" の前日 "2026-11-12"（終日予定の end（翌日指定）を取り込むときに使う）
export function prevDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// "2026-11-12" の翌日 "2026-11-13"（Calendar API の終日予定の end は「終わりの翌日」を指定する）
export function nextDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// 終日予定の本文。start・end は両端を含む日付（"YYYY-MM-DD"）
// summary＝「作業内容（業者名）」、location＝現場名（現場名はタイトルではなく「場所」に入れる。ユーザー指示）
export function makeEvent({ summary, location = "", description, start, end, docKey, barUid }) {
  return {
    summary,
    location,
    description,
    start: { date: start },
    end: { date: nextDay(end) },
    extendedProperties: { private: { [TAG_APP]: "1", [TAG_DOC]: docKey, [TAG_BAR]: barUid } },
  };
}

export function eventDocKey(ev) {
  return (ev && ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private[TAG_DOC]) || null;
}
export function isAppEvent(ev) {
  return !!((ev && ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private[TAG_APP]) === "1");
}

export function eventBarUid(ev) {
  return (ev && ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private[TAG_BAR]) || null;
}

// カレンダーの予定が、作りたい内容と同じか（同じなら更新しない）
export function sameEvent(ev, body) {
  return (ev.summary || "") === body.summary
    && (ev.location || "") === (body.location || "")
    && (ev.description || "") === body.description
    && !!ev.start && ev.start.date === body.start.date && !ev.start.dateTime
    && !!ev.end && ev.end.date === body.end.date && !ev.end.dateTime
    && eventBarUid(ev) === body.extendedProperties.private[TAG_BAR];
}
