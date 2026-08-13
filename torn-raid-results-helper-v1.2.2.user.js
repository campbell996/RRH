// ==UserScript==
// @name         Torn Raid Results Helper
// @namespace    BFTD.TornRaidResultsHelper
// @author       BackFromTheDead_Gaming Campbell
// @version      1.2.2
// @description  Fully local Torn raid results helper with RWPH-style hit weights, Pay Per Hit payouts, and a manual Payments Copy Panel. No backend, licence, paywall or automatic payment system.
// @license      Copyright BackFromTheDead_Gaming Campbell. All Rights Reserved. Personal use only. Redistribution, resale, or modified reposting is not permitted without permission.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @connect      api.torn.com
// ==/UserScript==

(function () {
  "use strict";

  const APP = {
    name: "Raid Results Helper",
    short: "RRH",
    version: "1.2.2",
    apiMinGapMs: 1250,
    apiMaxRetries: 4,
    raidHistoryCacheMs: 2 * 60 * 1000,
    factionCacheMs: 5 * 60 * 1000,
    apiBase: "https://api.torn.com/v2",
    resultTtl: 10 * 60 * 1000,
  };

  const KEY = {
    api: "rrh_api_key",
    panelOpen: "rrh_panel_open",
    panelLayout: "rrh_panel_layout",
    form: "rrh_form_state",
    memberAdjustments: "rrh_member_adjustments",
    lastResults: "rrh_last_results",
    apiCache: "rrh_api_response_cache_v1",
    payRows: "rrh_payments_copy_rows",
  };

  let raidHistory = [];
  let loadedRaidReport = null;
  let loadedRaidAttacks = [];
  let ownFaction = null;
  let loading = false;
  let apiQueue = Promise.resolve();
  let apiLastStartedAt = 0;

  function getValue(key, fallback = "") {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch (_) {}
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }

  function setValue(key, value) {
    try {
      if (typeof GM_setValue === "function") { GM_setValue(key, value); return; }
    } catch (_) {}
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function getJson(key, fallback) {
    try {
      const raw = getValue(key, "");
      if (!raw) return fallback;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) { return fallback; }
  }

  function setJson(key, value) { setValue(key, JSON.stringify(value)); }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
  function int(v, fallback = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; }

  function money(v) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num(v));
  }

  function compact(v, digits = 2) {
    const n = num(v);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(digits)}t`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}b`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}m`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(digits)}k`;
    return n.toFixed(digits);
  }

  function parseMoney(text) {
    const s = String(text || "").trim().toLowerCase().replaceAll(",", "").replaceAll("$", "");
    if (!s) return 0;
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([kmbt])?$/i);
    if (!m) return NaN;
    const base = Number(m[1]);
    const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1;
    return base * mult;
  }

  function formatDate(unix) {
    if (!unix) return "Ongoing";
    try { return new Date(Number(unix) * 1000).toLocaleString(); } catch (_) { return String(unix); }
  }

  function isFactionPage() {
    return /factions\.php/i.test(location.pathname) || /faction/i.test(location.hash || "");
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

  function apiKeyTag(apiKey) {
    let h = 2166136261;
    for (const ch of String(apiKey || "")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function apiCacheGet(cacheKey, maxAgeMs) {
    if (!cacheKey || !maxAgeMs) return null;
    const all = getJson(KEY.apiCache, {});
    const hit = all?.[cacheKey];
    if (!hit || !hit.savedAt || (Date.now() - Number(hit.savedAt)) > maxAgeMs) return null;
    return hit.data || null;
  }

  function apiCacheSet(cacheKey, data) {
    if (!cacheKey) return;
    const all = getJson(KEY.apiCache, {});
    all[cacheKey] = { savedAt: Date.now(), data };
    const keys = Object.keys(all).sort((a, b) => Number(all[b]?.savedAt || 0) - Number(all[a]?.savedAt || 0));
    for (const key of keys.slice(40)) delete all[key];
    setJson(KEY.apiCache, all);
  }

  function rateLimitMessage(seconds, attempt, maxAttempts) {
    const s = Math.max(1, Math.ceil(seconds));
    setStatus(`Torn API rate limit reached. RRH is waiting ${s}s before retry ${attempt}/${maxAttempts}. Do not keep pressing Load Raids; RRH will retry automatically.`, "bad");
  }

  function apiSingleRequest(url, apiKey) {
    return new Promise((resolve, reject) => {
      const done = (status, text, headersText = "") => {
        let data;
        try { data = JSON.parse(text || "{}"); }
        catch (_) { return reject(Object.assign(new Error(`Torn API returned invalid JSON (HTTP ${status}).`), { status })); }
        const code = Number(data?.error?.code || 0);
        if (status < 200 || status >= 300 || data?.error) {
          const msg = data?.error?.error || data?.error?.message || data?.message || `HTTP ${status}`;
          const err = Object.assign(new Error(msg), { status, code, headersText, data });
          return reject(err);
        }
        resolve(data);
      };

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers: {
            "Authorization": `ApiKey ${apiKey}`,
            "Accept": "application/json",
          },
          timeout: 30000,
          onload: r => done(r.status, r.responseText, r.responseHeaders || ""),
          onerror: () => reject(new Error("Could not connect to the Torn API.")),
          ontimeout: () => reject(new Error("Torn API request timed out.")),
        });
      } else {
        fetch(url, { headers: { "Authorization": `ApiKey ${apiKey}`, "Accept": "application/json" } })
          .then(async r => done(r.status, await r.text(), ""))
          .catch(err => reject(err instanceof Error ? err : new Error("Could not connect to the Torn API.")));
      }
    });
  }

  function apiRequest(path, options = {}) {
    const apiKey = String(getValue(KEY.api, "") || "").trim();
    if (!apiKey) return Promise.reject(new Error("Save your Torn API key first."));

    const url = /^https?:\/\//i.test(String(path || "")) ? String(path) : `${APP.apiBase}${path}`;
    const cacheKey = options.cacheKey || "";
    const effectiveCacheKey = cacheKey ? `${apiKeyTag(apiKey)}:${cacheKey}` : "";
    const cacheMs = Math.max(0, Number(options.cacheMs) || 0);
    const cached = apiCacheGet(effectiveCacheKey, cacheMs);
    if (cached) return Promise.resolve(cached);

    const task = async () => {
      const attempts = Math.max(1, Number(options.maxRetries ?? APP.apiMaxRetries) + 1);
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const gap = Math.max(0, Number(APP.apiMinGapMs) - (Date.now() - apiLastStartedAt));
        if (gap > 0) await sleep(gap);
        apiLastStartedAt = Date.now();
        try {
          const data = await apiSingleRequest(url, apiKey);
          if (effectiveCacheKey && cacheMs) apiCacheSet(effectiveCacheKey, data);
          return data;
        } catch (e) {
          lastError = e;
          const rateLimited = Number(e?.code) === 5 || Number(e?.status) === 429;
          const temporary = Number(e?.code) === 17 || Number(e?.status) >= 500;
          if ((!rateLimited && !temporary) || attempt >= attempts) {
            if (rateLimited) throw new Error("Torn is still rate-limiting this account (error 5). RRH stopped making requests so it does not worsen the block. Try again after the API limit clears, and check whether another Torn script/tool is also using your API quota.");
            throw e;
          }

          // Error 5 is a short user-wide block. Back off instead of creating more blocked requests.
          const waitMs = rateLimited ? [15000, 30000, 45000, 60000][Math.min(attempt - 1, 3)] : Math.min(15000, 3000 * attempt);
          if (rateLimited) rateLimitMessage(waitMs / 1000, attempt, attempts - 1);
          else setStatus(`Torn API temporary error. Retrying in ${Math.ceil(waitMs / 1000)}s (${attempt}/${attempts - 1})...`, "bad");
          await sleep(waitMs);
        }
      }
      throw lastError || new Error("Torn API request failed.");
    };

    // Serialize every RRH API call so raid pagination can never burst requests in parallel.
    const queued = apiQueue.then(task, task);
    apiQueue = queued.catch(() => {});
    return queued;
  }

  function styles() {
    if (document.getElementById("rrh-styles")) return;
    const s = document.createElement("style");
    s.id = "rrh-styles";
    s.textContent = `
      :root {
        --rrh-bg:#07111f; --rrh-bg2:#0b1b30; --rrh-card:#10243d; --rrh-card2:#132b49;
        --rrh-line:#244766; --rrh-text:#e8f3ff; --rrh-muted:#93aec8; --rrh-blue:#1f87d7;
        --rrh-blue2:#0f6cad; --rrh-green:#35c477; --rrh-red:#e45b68; --rrh-gold:#e6b94e;
      }
      #rrh-launcher { position:fixed!important; top:135px!important; right:12px!important; bottom:auto!important; left:auto!important; transform:none!important; margin:0!important; box-sizing:border-box; border:1px solid #2e668e; background:linear-gradient(180deg,#102b47,#071727); color:#dff3ff; min-width:39px; height:34px; border-radius:7px; padding:0 8px; font-weight:900; font-size:12px; letter-spacing:.5px; cursor:pointer; box-shadow:0 5px 18px #0008; z-index:999998!important; }
      #rrh-launcher:hover { border-color:#43aee7; filter:brightness(1.08); }

      #rrh-panel, #rrh-results { box-sizing:border-box; font-family:Arial,Helvetica,sans-serif; color:var(--rrh-text); }
      #rrh-panel * , #rrh-results * { box-sizing:border-box; }
      #rrh-panel { position:fixed; right:18px; top:110px; width:520px; max-width:calc(100vw - 20px); height:720px; max-height:calc(100vh - 125px); z-index:999999; background:linear-gradient(180deg,var(--rrh-bg2),var(--rrh-bg)); border:1px solid #2b5575; border-radius:12px; overflow:hidden; box-shadow:0 20px 60px #000c; resize:both; min-width:390px; min-height:420px; }
      #rrh-panel[hidden] { display:none !important; }
      .rrh-head { height:58px; background:linear-gradient(90deg,#0d2239,#0d3454); border-bottom:1px solid #275678; display:flex; align-items:center; justify-content:space-between; padding:10px 12px; cursor:move; user-select:none; }
      .rrh-brand { display:flex; gap:10px; align-items:center; }
      .rrh-logo { width:37px; height:37px; border-radius:50%; border:2px solid #46a6df; display:flex; align-items:center; justify-content:center; background:#071a2b; font-weight:900; color:#aee2ff; box-shadow:inset 0 0 15px #1687c955; }
      .rrh-title { font-size:16px; font-weight:800; } .rrh-sub { font-size:11px; color:#8fb4d2; margin-top:2px; }
      .rrh-close { width:34px; height:34px; border-radius:7px; border:1px solid #3d6784; background:#10253b; color:#d9ebf7; font-size:22px; cursor:pointer; }
      .rrh-body { height:calc(100% - 58px); overflow:auto; padding:12px; scrollbar-width:thin; }
      .rrh-card { background:linear-gradient(180deg,var(--rrh-card2),var(--rrh-card)); border:1px solid var(--rrh-line); border-radius:9px; padding:11px; margin-bottom:10px; }
      .rrh-card-title { font-weight:800; font-size:13px; margin-bottom:8px; color:#cdeaff; }
      .rrh-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .rrh-grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
      .rrh-field { display:flex; flex-direction:column; gap:5px; color:#9fb8ce; font-size:11px; }
      .rrh-field input,.rrh-field select { width:100%; border:1px solid #315978; background:#071725; color:#eef8ff; border-radius:6px; padding:8px; outline:none; }
      .rrh-field input:focus,.rrh-field select:focus { border-color:#3fa7df; }
      .rrh-actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:9px; }
      .rrh-btn { border:1px solid #2d7eb0; background:linear-gradient(180deg,#1f7fbd,#105987); color:#fff; border-radius:7px; padding:8px 10px; font-weight:700; cursor:pointer; }
      .rrh-btn.secondary { background:#102b43; border-color:#365d7a; color:#dbeeff; }
      .rrh-btn.danger { background:#5b2330; border-color:#8d4250; }
      .rrh-btn:disabled { opacity:.5; cursor:not-allowed; }
      .rrh-status { margin:8px 0 0; border-radius:7px; padding:8px; background:#071725; border:1px solid #234766; color:#a9c4d8; font-size:12px; }
      .rrh-status.good { border-color:#317a59; color:#aeecc9; } .rrh-status.bad { border-color:#8d4350; color:#ffb3bd; }
      .rrh-progress { display:flex; gap:5px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .rrh-step { display:flex; align-items:center; gap:4px; font-size:10px; color:#819db2; }
      .rrh-dot { width:9px; height:9px; border-radius:50%; background:#31495b; border:1px solid #49667b; }
      .rrh-step.done { color:#b4e8c9; } .rrh-step.done .rrh-dot { background:#35c477; border-color:#59db91; box-shadow:0 0 8px #35c47788; }
      .rrh-raid-option { font-size:12px; }
      .rrh-small { font-size:11px; color:var(--rrh-muted); line-height:1.4; }
      .rrh-member-table { width:100%; border-collapse:collapse; font-size:11px; }
      .rrh-member-table th { text-align:left; color:#a8c9e2; border-bottom:1px solid #31536d; padding:6px 4px; position:sticky; top:0; background:#10243d; }
      .rrh-member-table td { border-bottom:1px solid #203f57; padding:6px 4px; vertical-align:middle; }
      .rrh-member-table input[type=number] { width:70px; background:#071725; color:#fff; border:1px solid #2b516d; border-radius:5px; padding:5px; }
      .rrh-member-scroll { max-height:245px; overflow:auto; border:1px solid #254760; border-radius:7px; }
      .rrh-pill { display:inline-block; border:1px solid #345c77; border-radius:20px; padding:3px 7px; font-size:10px; color:#bad7eb; background:#0a1d2d; }
      .rrh-warn { color:#efcf7d; }
      .rrh-hidden { display:none !important; }

      #rrh-results { position:fixed; inset:0; z-index:1000000; background:#050b12f2; overflow:auto; padding:18px; }
      #rrh-results[hidden] { display:none !important; }
      .rrh-results-wrap { max-width:1200px; margin:0 auto; background:linear-gradient(180deg,#0b1b30,#07111f); border:1px solid #285274; border-radius:12px; box-shadow:0 25px 80px #000; overflow:hidden; }
      .rrh-results-toolbar { position:sticky; top:0; z-index:4; display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:11px 13px; background:#0c2237f5; border-bottom:1px solid #315a76; }
      .rrh-results-title { font-size:17px; font-weight:900; }
      .rrh-summary { display:grid; grid-template-columns:repeat(6,minmax(130px,1fr)); gap:8px; padding:12px; }
      .rrh-summary-card { background:#10243d; border:1px solid #284b66; border-radius:8px; padding:10px; }
      .rrh-summary-card span { display:block; color:#91adc3; font-size:10px; margin-bottom:4px; } .rrh-summary-card b { font-size:15px; }
      .rrh-faction-score { margin:0 12px 12px; display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; }
      .rrh-faction-box { background:#0c1d2e; border:1px solid #2a4d68; border-radius:9px; padding:10px; text-align:center; }
      .rrh-faction-box.winner { border-color:#3c8c63; box-shadow:inset 0 0 20px #2a8b4f20; }
      .rrh-vs { color:#7695aa; font-weight:900; }
      .rrh-members { padding:0 12px 12px; display:grid; grid-template-columns:repeat(2,minmax(330px,1fr)); gap:8px; }
      .rrh-member-card { background:#0e2338; border:1px solid #284c67; border-radius:9px; padding:10px; }
      .rrh-member-top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
      .rrh-member-name { font-weight:800; color:#d8efff; } .rrh-id { color:#7190a7; font-size:10px; }
      .rrh-payout { font-size:17px; font-weight:900; color:#95e9bd; text-align:right; }
      .rrh-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:8px; }
      .rrh-stat { background:#071725; border:1px solid #203e55; border-radius:6px; padding:6px; } .rrh-stat span { display:block; color:#7e9ab0; font-size:9px; } .rrh-stat b { font-size:12px; }
      .rrh-nonattack { opacity:.65; }
      @media(max-width:800px){ #rrh-panel{left:8px!important;right:8px!important;top:70px!important;width:auto!important;height:calc(100vh - 80px)!important;max-height:none;resize:none;} .rrh-summary{grid-template-columns:repeat(2,1fr)} .rrh-members{grid-template-columns:1fr}.rrh-grid2,.rrh-grid3{grid-template-columns:1fr}.rrh-faction-score{grid-template-columns:1fr}.rrh-vs{display:none;} }
    `;
    document.head.appendChild(s);
  }

  function pinLauncherToViewport() {
    const b = document.getElementById("rrh-launcher");
    if (!b || !document.body) return;

    // Match RWPH's stable launcher approach: the button belongs directly to document.body
    // and is viewport-fixed. Torn can rebuild faction headers, chat/messages and content
    // without changing the launcher's parent or screen position.
    if (b.parentElement !== document.body) document.body.appendChild(b);
    b.style.setProperty("position", "fixed", "important");
    b.style.setProperty("top", "135px", "important");
    b.style.setProperty("right", "12px", "important");
    b.style.setProperty("bottom", "auto", "important");
    b.style.setProperty("left", "auto", "important");
    b.style.setProperty("transform", "none", "important");
    b.style.setProperty("margin", "0", "important");
    b.style.setProperty("z-index", "999998", "important");
  }

  function createLauncher() {
    if (!isFactionPage()) return;
    let b = document.getElementById("rrh-launcher");
    if (!b) {
      b = document.createElement("button");
      b.id = "rrh-launcher";
      b.type = "button";
      b.textContent = APP.short;
      b.title = `Open ${APP.name}`;
      b.addEventListener("click", togglePanel);
      document.body.appendChild(b);
    }
    pinLauncherToViewport();
  }

  function removeLauncherIfNeeded() {
    if (isFactionPage()) return;
    document.getElementById("rrh-launcher")?.remove();
    const p = document.getElementById("rrh-panel");
    if (p) p.hidden = true;
  }

  function getForm() {
    return Object.assign({
      raidId: "",
      payPerHit: "0",
      raidHitWeight: 1,
      outsideHitWeight: 1,
      retaliationHitWeight: 1,
      assistWeight: 0,
      showNonAttackers: true,
    }, getJson(KEY.form, {}));
  }

  function saveFormFromDom() {
    const form = {
      raidId: document.getElementById("rrh-raid-select")?.value || "",
      payPerHit: document.getElementById("rrh-pay-per-hit")?.value || "0",
      raidHitWeight: Math.max(0, num(document.getElementById("rrh-raid-hit-weight")?.value, 1)),
      outsideHitWeight: Math.max(0, num(document.getElementById("rrh-outside-hit-weight")?.value, 1)),
      retaliationHitWeight: Math.max(0, num(document.getElementById("rrh-retaliation-hit-weight")?.value, 1)),
      assistWeight: Math.max(0, num(document.getElementById("rrh-assist-weight")?.value, 0)),
      showNonAttackers: !!document.getElementById("rrh-show-non")?.checked,
    };
    setJson(KEY.form, form);
    return form;
  }

  function createPanel() {
    if (document.getElementById("rrh-panel")) return;
    const f = getForm();
    const panel = document.createElement("section");
    panel.id = "rrh-panel";
    panel.hidden = getValue(KEY.panelOpen, "0") !== "1";
    panel.innerHTML = `
      <header class="rrh-head" id="rrh-drag">
        <div class="rrh-brand"><div class="rrh-logo">RRH</div><div><div class="rrh-title">Raid Results Helper</div><div class="rrh-sub">Local-only raid calculator • v${APP.version}</div></div></div>
        <button class="rrh-close" id="rrh-close" title="Close">×</button>
      </header>
      <div class="rrh-body">
        <div class="rrh-card">
          <div class="rrh-card-title">Torn API</div>
          <div class="rrh-field"><span>API key (stored only in this userscript/browser)</span><input id="rrh-api" type="password" autocomplete="off" placeholder="Paste Torn API key" value="${esc(getValue(KEY.api, ""))}"></div>
          <div class="rrh-actions"><button class="rrh-btn" id="rrh-save-api">Save Key</button><button class="rrh-btn secondary" id="rrh-test-api">Test Key</button></div>
          <div class="rrh-small" style="margin-top:7px">Uses Torn API v2 directly. No licence server, backend, account system, payment code or purchase check is used.</div>
        </div>

        <div class="rrh-card">
          <div class="rrh-card-title">Raid</div>
          <div class="rrh-field"><span>Raid</span><select id="rrh-raid-select"><option value="">Load raid history first</option></select></div>
          <div class="rrh-actions"><button class="rrh-btn" id="rrh-load-raids">Load Raids</button><button class="rrh-btn secondary" id="rrh-load-report" disabled>Load Selected Raid</button></div>
          <div class="rrh-status" id="rrh-status">Ready.</div>
          <div class="rrh-progress" id="rrh-progress">
            <div class="rrh-step" data-step="key"><i class="rrh-dot"></i>API</div>
            <div class="rrh-step" data-step="faction"><i class="rrh-dot"></i>Faction</div>
            <div class="rrh-step" data-step="history"><i class="rrh-dot"></i>Raids</div>
            <div class="rrh-step" data-step="report"><i class="rrh-dot"></i>Report</div>
            <div class="rrh-step" data-step="attacks"><i class="rrh-dot"></i>Attacks</div>
            <div class="rrh-step" data-step="calc"><i class="rrh-dot"></i>Calculate</div>
          </div>
        </div>

        <div class="rrh-card">
          <div class="rrh-card-title">Raid Result Calculation</div>
          <label class="rrh-field"><span>Pay Per Hit</span><input id="rrh-pay-per-hit" value="${esc(f.payPerHit)}" placeholder="Example: 1m, 750k or 250000"></label>
          <div class="rrh-grid2" style="margin-top:8px">
            <label class="rrh-field"><span>Raid Hit Weight</span><input id="rrh-raid-hit-weight" type="number" min="0" step="0.1" value="${esc(f.raidHitWeight)}"></label>
            <label class="rrh-field"><span>Outside Hit Weight</span><input id="rrh-outside-hit-weight" type="number" min="0" step="0.1" value="${esc(f.outsideHitWeight)}"></label>
            <label class="rrh-field"><span>Retaliation Hit Weight</span><input id="rrh-retaliation-hit-weight" type="number" min="0" step="0.1" value="${esc(f.retaliationHitWeight)}"></label>
            <label class="rrh-field"><span>Assist Weight</span><input id="rrh-assist-weight" type="number" min="0" step="0.1" value="${esc(f.assistWeight)}"></label>
          </div>
          <div class="rrh-small" style="margin-top:7px"><b>Pay Per Hit:</b> each member's final payout is their total weighted contribution × this amount. <b>Raid Hits:</b> successful attacks on the opposing raid faction. <b>Outside Hits:</b> successful attacks on anyone outside the opposing raid faction during the raid. <b>Retals:</b> a retaliation against the raid opponent counts as a Raid Hit plus the Retaliation bonus; a retal against an outside target is treated as an Outside Hit. <b>Assists:</b> read from Torn's attack result and weighted separately.</div>
        </div>

        <div class="rrh-card" id="rrh-members-card">
          <div class="rrh-card-title">Member Management</div>
          <div class="rrh-small" id="rrh-members-note">Load a raid to manage members. Current raids are calculated as a snapshot ending at the time Load Raids was pressed.</div>
          <div class="rrh-member-scroll rrh-hidden" id="rrh-member-scroll"><table class="rrh-member-table"><thead><tr><th>Use</th><th>Member</th><th>Raid Hits</th><th>Outside</th><th>Assists</th><th>Retals</th><th>Damage</th><th>Remove payable hits</th><th>Remove damage</th></tr></thead><tbody id="rrh-member-body"></tbody></table></div>
          <div class="rrh-actions"><label class="rrh-small"><input type="checkbox" id="rrh-show-non" ${f.showNonAttackers ? "checked" : ""}> Include non-attackers in the results page</label></div>
        </div>

        <div class="rrh-card">
          <div class="rrh-actions" style="margin:0"><button class="rrh-btn" style="flex:1" id="rrh-calc" disabled>Calculate Raid Results</button><button class="rrh-btn secondary" id="rrh-reopen" style="display:none">Reopen Results</button></div>
          <div class="rrh-small" style="margin-top:8px">Calculations and recent results stay on this device. RRH never sends cash/items or performs Torn payment actions.</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    restorePanelLayout();
    bindPanel();
    refreshReopenButton();
  }

  function bindPanel() {
    document.getElementById("rrh-close")?.addEventListener("click", closePanel);
    document.getElementById("rrh-save-api")?.addEventListener("click", () => {
      const key = document.getElementById("rrh-api")?.value.trim() || "";
      setValue(KEY.api, key);
      setStatus(key ? "API key saved locally." : "API key cleared.", key ? "good" : "");
    });
    document.getElementById("rrh-test-api")?.addEventListener("click", async () => {
      const key = document.getElementById("rrh-api")?.value.trim() || "";
      setValue(KEY.api, key);
      setLoading(true); resetSteps();
      try {
        const data = await apiRequest("/user/faction", { cacheKey: "user-faction", cacheMs: APP.factionCacheMs });
        markStep("key"); markStep("faction");
        ownFaction = data.faction || null;
        if (!ownFaction?.id) throw new Error("This Torn account is not currently in a faction.");
        setStatus(`API key works. Faction: ${ownFaction.name} [${ownFaction.id}]`, "good");
      } catch (e) { setStatus(e.message, "bad"); }
      finally { setLoading(false); }
    });
    document.getElementById("rrh-load-raids")?.addEventListener("click", loadRaidHistory);
    document.getElementById("rrh-load-report")?.addEventListener("click", loadSelectedRaid);
    document.getElementById("rrh-raid-select")?.addEventListener("change", () => {
      saveFormFromDom();
      const v = document.getElementById("rrh-raid-select").value;
      document.getElementById("rrh-load-report").disabled = !v || loading;
    });
    ["rrh-pay-per-hit","rrh-raid-hit-weight","rrh-outside-hit-weight","rrh-retaliation-hit-weight","rrh-assist-weight","rrh-show-non"].forEach(id => document.getElementById(id)?.addEventListener("change", saveFormFromDom));
    document.getElementById("rrh-calc")?.addEventListener("click", calculateAndShowResults);
    document.getElementById("rrh-reopen")?.addEventListener("click", reopenResults);
    enableDrag(document.getElementById("rrh-panel"), document.getElementById("rrh-drag"));
    const p = document.getElementById("rrh-panel");
    if (p && typeof ResizeObserver !== "undefined") new ResizeObserver(savePanelLayout).observe(p);
  }

  function setStatus(text, type = "") {
    const el = document.getElementById("rrh-status");
    if (!el) return;
    el.textContent = text;
    el.className = `rrh-status ${type}`.trim();
  }

  function setLoading(value) {
    loading = !!value;
    ["rrh-load-raids","rrh-test-api","rrh-save-api","rrh-load-report","rrh-calc"].forEach(id => {
      const b = document.getElementById(id); if (!b) return;
      if (loading) b.disabled = true;
    });
    if (!loading) {
      const raidVal = document.getElementById("rrh-raid-select")?.value;
      const reportReady = !!loadedRaidReport;
      const lr = document.getElementById("rrh-load-report"); if (lr) lr.disabled = !raidVal;
      const calc = document.getElementById("rrh-calc"); if (calc) calc.disabled = !reportReady;
      const lraids = document.getElementById("rrh-load-raids"); if (lraids) lraids.disabled = false;
      const test = document.getElementById("rrh-test-api"); if (test) test.disabled = false;
      const save = document.getElementById("rrh-save-api"); if (save) save.disabled = false;
    }
  }

  function resetSteps() { document.querySelectorAll("#rrh-progress .rrh-step").forEach(x => x.classList.remove("done")); }
  function markStep(step) { document.querySelector(`#rrh-progress .rrh-step[data-step="${step}"]`)?.classList.add("done"); }

  async function ensureFaction() {
    if (ownFaction?.id) return ownFaction;
    const data = await apiRequest("/user/faction", { cacheKey: "user-faction", cacheMs: APP.factionCacheMs });
    markStep("key"); markStep("faction");
    ownFaction = data.faction || null;
    if (!ownFaction?.id) throw new Error("This Torn account is not currently in a faction.");
    return ownFaction;
  }

  async function loadRaidHistory() {
    const key = document.getElementById("rrh-api")?.value.trim() || String(getValue(KEY.api, "") || "").trim();
    if (key) setValue(KEY.api, key);
    setLoading(true); resetSteps(); loadedRaidReport = null; loadedRaidAttacks = []; renderMembers();
    setStatus("Loading your faction and raid history (rate-limit protection enabled)...");
    try {
      await ensureFaction();
      const data = await apiRequest("/faction/raids?limit=100&sort=DESC", { cacheKey: "raid-history", cacheMs: APP.raidHistoryCacheMs });
      markStep("history");
      const loadedAt = Math.floor(Date.now() / 1000);
      raidHistory = (Array.isArray(data.raids) ? data.raids : []).map(r => ({
        ...r,
        _rrhSnapshotEnd: r?.end == null ? loadedAt : int(r.end, loadedAt),
        _rrhWasOngoingWhenLoaded: r?.end == null,
      }));
      populateRaidSelect();
      const finished = raidHistory.filter(r => r?.end != null);
      const current = raidHistory.filter(r => r?.end == null);
      const currentText = current.length ? `; ${current.length} current raid${current.length === 1 ? "" : "s"} snapshot end ${formatDate(loadedAt)}` : "";
      setStatus(`Loaded ${raidHistory.length} raid record${raidHistory.length === 1 ? "" : "s"}; ${finished.length} completed${currentText}.`, "good");
    } catch (e) { setStatus(e.message, "bad"); }
    finally { setLoading(false); }
  }

  function raidLabel(r) {
    const a = r?.aggressor || {}; const d = r?.defender || {};
    const ended = r?.end != null ? formatDate(r.end) : `ONGOING • snapshot end ${formatDate(r?._rrhSnapshotEnd)}`;
    return `#${r.id} • ${a.name || a.id} ${num(a.score).toFixed(2)} vs ${num(d.score).toFixed(2)} ${d.name || d.id} • ${ended}`;
  }

  function populateRaidSelect() {
    const sel = document.getElementById("rrh-raid-select");
    if (!sel) return;
    const saved = getForm().raidId;
    sel.innerHTML = `<option value="">Select a raid</option>` + raidHistory.map(r => `<option class="rrh-raid-option" value="${esc(r.id)}">${esc(raidLabel(r))}</option>`).join("");
    if (saved && raidHistory.some(r => String(r.id) === String(saved))) sel.value = String(saved);
    document.getElementById("rrh-load-report").disabled = !sel.value;
  }

  function buildCurrentRaidSnapshot(raid) {
    if (!raid?.id || !raid?.start) throw new Error("The current raid record is missing its id or start time.");
    const snapshotEnd = int(raid?._rrhSnapshotEnd, 0);
    if (!snapshotEnd || snapshotEnd <= int(raid.start, 0)) throw new Error("The current raid snapshot end time is invalid. Press Load Raids again.");
    const normalizeCurrentSide = side => ({
      id: side?.id,
      name: side?.name || `Faction ${side?.id || ""}`,
      score: num(side?.score),
      chain: int(side?.chain, 0),
      attackers: [],
      non_attackers: [],
    });
    return {
      id: raid.id,
      start: int(raid.start, 0),
      end: snapshotEnd,
      aggressor: normalizeCurrentSide(raid.aggressor),
      defender: normalizeCurrentSide(raid.defender),
      _rrhCurrentSnapshot: true,
      _rrhSnapshotLoadedAt: snapshotEnd,
      _rrhActualEnd: null,
    };
  }

  async function loadSelectedRaid() {
    const id = document.getElementById("rrh-raid-select")?.value;
    if (!id) return setStatus("Select a raid first.", "bad");
    saveFormFromDom();
    setLoading(true); resetSteps(); markStep("key"); markStep("faction"); markStep("history");
    const selectedRaid = raidHistory.find(r => String(r?.id) === String(id));
    const isCurrentSnapshot = !!selectedRaid && selectedRaid?.end == null;
    setStatus(isCurrentSnapshot
      ? `Loading current raid #${id} snapshot through ${formatDate(selectedRaid?._rrhSnapshotEnd)} and classifying faction attacks (requests are throttled)...`
      : `Loading raid #${id} report and classifying faction attacks (requests are throttled)...`);
    try {
      await ensureFaction();
      if (isCurrentSnapshot) {
        loadedRaidReport = buildCurrentRaidSnapshot(selectedRaid);
      } else {
        const data = await apiRequest(`/faction/${encodeURIComponent(id)}/raidreport`, { cacheKey: `raid-report:${id}`, cacheMs: 10 * 60 * 1000 });
        if (!data?.raidreport) throw new Error("Torn returned no raid report for this raid.");
        loadedRaidReport = data.raidreport;
      }
      markStep("report");
      loadedRaidAttacks = await loadRaidAttackLogs(loadedRaidReport);
      markStep("attacks");
      renderMembers();
      const side = getOwnSide(loadedRaidReport);
      const classified = classifyRaidAttacks(loadedRaidReport, loadedRaidAttacks);
      const tracked = [...classified.values()].reduce((n, x) => n + x.trackedAttacks, 0);
      const snapshotText = loadedRaidReport?._rrhCurrentSnapshot ? ` Current raid snapshot end: ${formatDate(loadedRaidReport.end)}.` : "";
      setStatus(`Raid #${id} loaded.${snapshotText} ${loadedRaidAttacks.length} outgoing attack log${loadedRaidAttacks.length === 1 ? "" : "s"} read; ${tracked} raid/outside/assist event${tracked === 1 ? "" : "s"} classified for ${side.name}.`, "good");
    } catch (e) { loadedRaidReport = null; loadedRaidAttacks = []; renderMembers(); setStatus(e.message, "bad"); }
    finally { setLoading(false); }
  }

  function getOwnSide(report) {
    const ownId = String(ownFaction?.id || "");
    const a = report?.aggressor || {};
    const d = report?.defender || {};
    if (String(a.id) === ownId) return normalizeSide(a);
    if (String(d.id) === ownId) return normalizeSide(d);
    // Fallback: /faction/raids should only return raids involving the key owner's faction.
    return normalizeSide(a);
  }

  function normalizeSide(side) {
    return {
      id: side?.id,
      name: side?.name || `Faction ${side?.id || ""}`,
      score: num(side?.score),
      attackers: Array.isArray(side?.attackers) ? side.attackers : [],
      non_attackers: Array.isArray(side?.non_attackers) ? side.non_attackers : [],
    };
  }

  function getOpponentSide(report) {
    const ownId = String(ownFaction?.id || "");
    const a = report?.aggressor || {};
    const d = report?.defender || {};
    if (String(a.id) === ownId) return normalizeSide(d);
    if (String(d.id) === ownId) return normalizeSide(a);
    return normalizeSide(d);
  }

  function isSuccessfulAttack(attack) {
    if (!attack || String(attack.result || "") === "Assist") return false;
    return num(attack.respect_gain, 0) > 0;
  }

  function classifyRaidAttacks(report, attacks) {
    const ownId = String(ownFaction?.id || "");
    const opponent = getOpponentSide(report);
    const opponentId = String(opponent.id || "");
    const byUser = new Map();
    const ensure = (uid, name) => {
      const id = String(uid || "");
      if (!id) return null;
      if (!byUser.has(id)) byUser.set(id, { id, name: name || `User ${id}`, raidHits: 0, outsideHits: 0, assists: 0, retaliationHits: 0, trackedAttacks: 0 });
      else if (name && /^User /.test(byUser.get(id).name || "")) byUser.get(id).name = name;
      return byUser.get(id);
    };

    for (const attack of attacks || []) {
      const attacker = attack?.attacker;
      if (!attacker?.id) continue;
      const attackerFactionId = String(attacker?.faction?.id || "");
      if (ownId && attackerFactionId && attackerFactionId !== ownId) continue;
      const row = ensure(attacker.id, attacker.name);
      if (!row) continue;
      const defenderFactionId = String(attack?.defender?.faction?.id || "");
      const againstRaidOpponent = !!opponentId && defenderFactionId === opponentId;
      const isAssist = String(attack?.result || "") === "Assist";
      const isRetal = num(attack?.modifiers?.retaliation, 1) > 1.000001;

      if (isAssist) {
        row.assists += 1;
        row.trackedAttacks += 1;
        continue;
      }
      if (!isSuccessfulAttack(attack)) continue;

      if (againstRaidOpponent && attack?.is_raid !== false) {
        row.raidHits += 1;
        row.trackedAttacks += 1;
        if (isRetal) row.retaliationHits += 1;
      } else {
        row.outsideHits += 1;
        row.trackedAttacks += 1;
      }
    }
    return byUser;
  }

  async function loadRaidAttackLogs(report) {
    const raidStart = int(report?.start, 0);
    const raidEnd = int(report?.end, 0);
    if (!raidStart || !raidEnd || raidEnd <= raidStart) throw new Error("The selected raid does not have a valid time range for this snapshot.");

    // Torn's detailed faction-attacks endpoint is documented with DESC sorting.
    // Instead of trusting _metadata.links.next (which can repeat), walk backwards
    // through the raid by timestamp. `from` is exclusive and `to` is inclusive,
    // so use raidStart - 1 as the lower bound to retain attacks at the exact start.
    const lowerBound = Math.max(0, raidStart - 1);
    let cursorTo = raidEnd;
    const all = [];
    const seenAttacks = new Set();
    const seenCursors = new Set();
    let pages = 0;

    while (cursorTo > lowerBound) {
      if (seenCursors.has(cursorTo)) {
        throw new Error(`Attack-log timestamp pagination stalled at ${cursorTo} after ${pages} page${pages === 1 ? "" : "s"}. RRH stopped to prevent an infinite request loop.`);
      }
      seenCursors.add(cursorTo);

      const pagePath = `/faction/attacks?filters=outgoing&limit=100&sort=DESC&from=${lowerBound}&to=${cursorTo}`;
      const data = await apiRequest(pagePath, {
        cacheKey: `raid-attacks-desc-v2:${report?.id || raidStart}:${lowerBound}:${cursorTo}`,
        cacheMs: 30 * 60 * 1000,
      });
      const batch = Array.isArray(data?.attacks) ? data.attacks : [];
      if (!batch.length) break;

      let addedThisPage = 0;
      let oldestTimestamp = Number.POSITIVE_INFINITY;

      for (const attack of batch) {
        const started = int(attack?.started, 0);
        const ended = int(attack?.ended, 0);
        // Torn paginates attacks by timestamp. Using the earlier valid attack
        // timestamp makes the manual DESC cursor conservative and monotonic.
        const attackTs = started || ended;
        if (attackTs > 0) oldestTimestamp = Math.min(oldestTimestamp, attackTs);

        // Keep only records that actually overlap the selected raid/snapshot.
        // The API time window should already enforce this; this local guard keeps
        // cached/edge records from leaking into the calculation.
        if (started && (started < raidStart || started > raidEnd)) continue;

        const id = String(attack?.id || attack?.code || `${attack?.started}-${attack?.ended}-${attack?.attacker?.id}-${attack?.defender?.id}`);
        if (seenAttacks.has(id)) continue;
        seenAttacks.add(id);
        all.push(attack);
        addedThisPage += 1;
      }

      pages += 1;
      if (pages === 1 || pages % 5 === 0 || batch.length < 100) {
        setStatus(`Reading raid attack logs: ${pages} page${pages === 1 ? "" : "s"}, ${all.length.toLocaleString()} unique outgoing attack${all.length === 1 ? "" : "s"} loaded. Current cursor: ${cursorTo}.`);
      }

      // Fewer than 100 rows means Torn has exhausted this timestamp window.
      if (batch.length < 100) break;

      if (!Number.isFinite(oldestTimestamp) || oldestTimestamp <= lowerBound) break;

      // Move strictly backwards. Torn's `to` parameter is inclusive, therefore
      // subtract one second so the oldest row from this page is not requested again.
      const nextCursor = oldestTimestamp - 1;
      if (nextCursor >= cursorTo) {
        throw new Error(`Attack-log timestamp cursor did not move backwards after ${pages} page${pages === 1 ? "" : "s"}. RRH stopped to prevent repeated API requests.`);
      }
      cursorTo = nextCursor;

      if (addedThisPage === 0 && cursorTo <= lowerBound) break;
    }

    return all.sort((a, b) => int(a?.started, 0) - int(b?.started, 0) || int(a?.id, 0) - int(b?.id, 0));
  }

  function currentAdjustmentMap() { return getJson(KEY.memberAdjustments, {}); }
  function raidAdjustmentKey() { return String(loadedRaidReport?.id || ""); }

  function getRaidAdjustments() {
    const all = currentAdjustmentMap();
    return Object.assign({}, all[raidAdjustmentKey()] || {});
  }

  function saveRaidAdjustmentsFromDom() {
    if (!loadedRaidReport) return;
    const all = currentAdjustmentMap();
    const rid = raidAdjustmentKey();
    const raid = {};
    document.querySelectorAll("#rrh-member-body tr[data-user]").forEach(tr => {
      const uid = String(tr.dataset.user);
      raid[uid] = {
        excluded: !tr.querySelector(".rrh-use")?.checked,
        removeAttacks: Math.max(0, int(tr.querySelector(".rrh-remove-attacks")?.value, 0)),
        removeDamage: Math.max(0, num(tr.querySelector(".rrh-remove-damage")?.value, 0)),
      };
    });
    all[rid] = raid;
    setJson(KEY.memberAdjustments, all);
  }

  function reportDamageMap(side) {
    const map = new Map();
    for (const a of side?.attackers || []) {
      const u = a?.user || {};
      if (!u.id) continue;
      map.set(String(u.id), { name: u.name || `User ${u.id}`, attacks: Math.max(0, int(a.attacks)), damage: Math.max(0, num(a.damage)) });
    }
    return map;
  }

  function applyManualHitRemoval(counts, requested) {
    let left = Math.max(0, int(requested, 0));
    const out = { ...counts };
    const plainRaid = Math.max(0, out.raidHits - out.retaliationHits);
    let take = Math.min(left, plainRaid); out.raidHits -= take; left -= take;
    take = Math.min(left, out.retaliationHits); out.raidHits -= take; out.retaliationHits -= take; left -= take;
    take = Math.min(left, out.outsideHits); out.outsideHits -= take; left -= take;
    take = Math.min(left, out.assists); out.assists -= take; left -= take;
    return out;
  }

  function buildMemberSourceRows() {
    const side = getOwnSide(loadedRaidReport);
    const classified = classifyRaidAttacks(loadedRaidReport, loadedRaidAttacks);
    const damage = reportDamageMap(side);
    const ids = new Set([...classified.keys(), ...damage.keys()]);
    return [...ids].map(id => {
      const c = classified.get(id) || { id, name: damage.get(id)?.name || `User ${id}`, raidHits:0, outsideHits:0, assists:0, retaliationHits:0, trackedAttacks:0 };
      const d = damage.get(id) || { name: c.name, attacks:0, damage:0 };
      return { id, name: c.name || d.name, raidHits:c.raidHits, outsideHits:c.outsideHits, assists:c.assists, retaliationHits:c.retaliationHits, trackedAttacks:c.trackedAttacks, reportAttacks:d.attacks, rawDamage:d.damage, damageAvailable: !loadedRaidReport?._rrhCurrentSnapshot };
    });
  }

  function renderMembers() {
    const body = document.getElementById("rrh-member-body");
    const scroll = document.getElementById("rrh-member-scroll");
    const note = document.getElementById("rrh-members-note");
    const calc = document.getElementById("rrh-calc");
    if (!body || !scroll || !note || !calc) return;
    if (!loadedRaidReport) {
      body.innerHTML = ""; scroll.classList.add("rrh-hidden"); note.classList.remove("rrh-hidden"); calc.disabled = true; return;
    }
    const adj = getRaidAdjustments();
    const rows = buildMemberSourceRows().sort((a,b) => (b.raidHits+b.outsideHits+b.assists) - (a.raidHits+a.outsideHits+a.assists) || b.rawDamage-a.rawDamage);
    body.innerHTML = rows.map(a => {
      const x = adj[String(a.id)] || {};
      return `<tr data-user="${esc(a.id)}"><td><input class="rrh-use" type="checkbox" ${x.excluded ? "" : "checked"}></td><td><b>${esc(a.name)}</b><div class="rrh-id">[${esc(a.id)}]</div></td><td>${esc(a.raidHits)}</td><td>${esc(a.outsideHits)}</td><td>${esc(a.assists)}</td><td>${esc(a.retaliationHits)}</td><td>${loadedRaidReport?._rrhCurrentSnapshot ? "—" : esc(compact(a.rawDamage))}</td><td><input class="rrh-remove-attacks" type="number" min="0" step="1" value="${esc(x.removeAttacks || 0)}"></td><td><input class="rrh-remove-damage" type="number" min="0" step="0.01" value="${esc(x.removeDamage || 0)}" ${loadedRaidReport?._rrhCurrentSnapshot ? 'disabled title="Raid-report damage is unavailable until the raid finishes"' : ""}></td></tr>`;
    }).join("");
    scroll.classList.remove("rrh-hidden"); note.classList.add("rrh-hidden"); calc.disabled = false;
    body.querySelectorAll("input").forEach(inp => inp.addEventListener("change", saveRaidAdjustmentsFromDom));
  }

  function buildCalculation() {
    if (!loadedRaidReport) throw new Error("Load a raid first.");
    if (!Array.isArray(loadedRaidAttacks)) throw new Error("Raid attack logs are not loaded.");
    saveRaidAdjustmentsFromDom();
    const form = saveFormFromDom();
    const payPerHit = parseMoney(form.payPerHit);
    if (!Number.isFinite(payPerHit) || payPerHit < 0) throw new Error("Pay Per Hit is not valid. Examples: 1m, 750k, 250000.");
    const weights = {
      raidHit: Math.max(0, num(form.raidHitWeight, 1)),
      outsideHit: Math.max(0, num(form.outsideHitWeight, 1)),
      retaliation: Math.max(0, num(form.retaliationHitWeight, 1)),
      assist: Math.max(0, num(form.assistWeight, 0)),
    };
    const side = getOwnSide(loadedRaidReport);
    const adj = getRaidAdjustments();
    const source = buildMemberSourceRows();

    const members = source.map(a => {
      const x = adj[String(a.id)] || {};
      const removed = Math.max(0, int(x.removeAttacks));
      const adjusted = applyManualHitRemoval({ raidHits:a.raidHits, outsideHits:a.outsideHits, assists:a.assists, retaliationHits:a.retaliationHits }, removed);
      const damage = Math.max(0, a.rawDamage - Math.max(0, num(x.removeDamage)));
      const weight = adjusted.raidHits * weights.raidHit + adjusted.outsideHits * weights.outsideHit + adjusted.retaliationHits * weights.retaliation + adjusted.assists * weights.assist;
      return {
        ...a,
        rawRaidHits:a.raidHits, rawOutsideHits:a.outsideHits, rawAssists:a.assists, rawRetaliationHits:a.retaliationHits,
        raidHits:adjusted.raidHits, outsideHits:adjusted.outsideHits, assists:adjusted.assists, retaliationHits:adjusted.retaliationHits,
        removeAttacks:removed, removeDamage:Math.max(0, num(x.removeDamage)), damage,
        weight, payableEvents:adjusted.raidHits + adjusted.outsideHits + adjusted.assists,
        excluded:!!x.excluded,
      };
    });

    const eligible = members.filter(m => !m.excluded);
    const totalWeight = eligible.reduce((s,m) => s + m.weight, 0);
    eligible.forEach(m => { m.payout = m.weight * payPerHit; });
    const totalPayout = eligible.reduce((s,m) => s + m.payout, 0);
    eligible.forEach(m => { m.normalizedShare = totalPayout > 0 ? m.payout / totalPayout : (totalWeight > 0 ? m.weight / totalWeight : 0); });
    members.filter(m => m.excluded).forEach(m => { m.normalizedShare = 0; m.payout = 0; });

    const totals = {
      raidHits: eligible.reduce((s,m)=>s+m.raidHits,0),
      outsideHits: eligible.reduce((s,m)=>s+m.outsideHits,0),
      assists: eligible.reduce((s,m)=>s+m.assists,0),
      retaliationHits: eligible.reduce((s,m)=>s+m.retaliationHits,0),
      payableEvents: eligible.reduce((s,m)=>s+m.payableEvents,0),
      weight: totalWeight,
      totalPayout,
      damage: eligible.reduce((s,m)=>s+m.damage,0),
      eligible: eligible.length,
      excluded: members.length - eligible.length,
    };
    const sorted = [...members].sort((a,b) => b.weight-a.weight || b.raidHits-a.raidHits || b.outsideHits-a.outsideHits || b.damage-a.damage);
    return {
      createdAt: Date.now(), expiresAt: Date.now() + APP.resultTtl,
      raid: loadedRaidReport,
      ownFaction: { id: side.id, name: side.name, score: side.score },
      opponentFaction: getOpponentSide(loadedRaidReport),
      form: { ...form, payPerHit, weights },
      totals,
      members: sorted,
      nonAttackers: side.non_attackers || [],
      attackLogCount: loadedRaidAttacks.length,
    };
  }

  function calculateAndShowResults() {
    try {
      const result = buildCalculation();
      markStep("calc");
      setJson(KEY.lastResults, result);
      refreshReopenButton();
      showResults(result);
      setStatus(`Raid #${result.raid.id} results calculated locally from ${result.attackLogCount} faction attack logs.`, "good");
    } catch (e) { setStatus(e.message, "bad"); }
  }

  function winnerId(report) {
    const a = report?.aggressor || {}; const d = report?.defender || {};
    if (report?._rrhCurrentSnapshot) return null;
    if (num(a.score) > num(d.score)) return a.id;
    if (num(d.score) > num(a.score)) return d.id;
    return null;
  }

  function modeLabel(f) {
    const w = f?.weights || {};
    return `Pay Per Hit ${money(f?.payPerHit || 0)} • Raid ${num(w.raidHit, f?.raidHitWeight ?? 1)} / Outside ${num(w.outsideHit, f?.outsideHitWeight ?? 1)} / Retal ${num(w.retaliation, f?.retaliationHitWeight ?? 1)} / Assist ${num(w.assist, f?.assistWeight ?? 0)}`;
  }

  function showResults(result) {
    document.getElementById("rrh-results")?.remove();
    const overlay = document.createElement("section");
    overlay.id = "rrh-results";
    const r = result.raid || {}; const a = r.aggressor || {}; const d = r.defender || {}; const w = winnerId(r);
    const includeNon = !!result.form.showNonAttackers;
    overlay.innerHTML = `
      <div class="rrh-results-wrap">
        <div class="rrh-results-toolbar">
          <div><div class="rrh-results-title">Raid #${esc(r.id)} Results${r._rrhCurrentSnapshot ? " • CURRENT SNAPSHOT" : ""}</div><div class="rrh-small">${esc(formatDate(r.start))} → ${esc(formatDate(r.end))}${r._rrhCurrentSnapshot ? " • end time captured when raids were loaded" : ""}</div></div>
          <div class="rrh-actions" style="margin:0"><button class="rrh-btn" id="rrh-payments">Payments</button><button class="rrh-btn secondary" id="rrh-export">Export CSV</button><button class="rrh-btn" id="rrh-results-close">Close Results</button></div>
        </div>
        <div class="rrh-summary">
          <div class="rrh-summary-card"><span>Your faction</span><b>${esc(result.ownFaction.name)}</b></div>
          ${r._rrhCurrentSnapshot ? `<div class="rrh-summary-card"><span>Current raid snapshot end</span><b>${esc(formatDate(r.end))}</b></div>` : ""}
          <div class="rrh-summary-card"><span>Calculation</span><b>${esc(modeLabel(result.form))}</b></div>
          <div class="rrh-summary-card"><span>Raid Hits</span><b>${esc(result.totals.raidHits)}</b></div>
          <div class="rrh-summary-card"><span>Outside Hits</span><b>${esc(result.totals.outsideHits)}</b></div>
          <div class="rrh-summary-card"><span>Retals</span><b>${esc(result.totals.retaliationHits)}</b></div>
          <div class="rrh-summary-card"><span>Assists</span><b>${esc(result.totals.assists)}</b></div>
          <div class="rrh-summary-card"><span>Total weight</span><b>${esc(num(result.totals.weight).toFixed(2))}</b></div>
          <div class="rrh-summary-card"><span>Eligible members</span><b>${esc(result.totals.eligible)}</b></div>
          <div class="rrh-summary-card"><span>Raid damage</span><b>${r._rrhCurrentSnapshot ? "Available after raid ends" : esc(compact(result.totals.damage))}</b></div>
          <div class="rrh-summary-card"><span>Pay Per Hit</span><b>${esc(money(result.form.payPerHit))}</b></div>
          <div class="rrh-summary-card"><span>Total payout</span><b>${esc(money(result.totals.totalPayout))}</b></div>
        </div>
        <div class="rrh-faction-score">
          <div class="rrh-faction-box ${String(w)===String(a.id)?"winner":""}"><div class="rrh-small">AGGRESSOR</div><b>${esc(a.name)} [${esc(a.id)}]</b><div style="font-size:24px;font-weight:900;margin-top:5px">${esc(num(a.score).toFixed(2))}</div></div>
          <div class="rrh-vs">VS</div>
          <div class="rrh-faction-box ${String(w)===String(d.id)?"winner":""}"><div class="rrh-small">DEFENDER</div><b>${esc(d.name)} [${esc(d.id)}]</b><div style="font-size:24px;font-weight:900;margin-top:5px">${esc(num(d.score).toFixed(2))}</div></div>
        </div>
        <div class="rrh-members">
          ${result.members.map((m,i) => `
            <article class="rrh-member-card ${m.excluded?"rrh-nonattack":""}">
              <div class="rrh-member-top"><div><div class="rrh-member-name">#${i+1} ${esc(m.name)}</div><div class="rrh-id">Torn ID: ${esc(m.id)} ${m.excluded?"• EXCLUDED":""}</div></div><div><div class="rrh-payout">${esc(money(m.payout))}</div><div class="rrh-id" style="text-align:right">${(m.normalizedShare*100).toFixed(2)}% share</div></div></div>
              <div class="rrh-stats">
                <div class="rrh-stat"><span>Raid Hits</span><b>${esc(m.raidHits)}</b></div>
                <div class="rrh-stat"><span>Outside Hits</span><b>${esc(m.outsideHits)}</b></div>
                <div class="rrh-stat"><span>Retals</span><b>${esc(m.retaliationHits)}</b></div>
                <div class="rrh-stat"><span>Assists</span><b>${esc(m.assists)}</b></div>
                <div class="rrh-stat"><span>Weight</span><b>${esc(num(m.weight).toFixed(2))}</b></div>
                <div class="rrh-stat"><span>Raid Damage</span><b>${esc(compact(m.damage))}</b></div>
              </div>
              ${(m.removeAttacks||m.removeDamage)?`<div class="rrh-small rrh-warn" style="margin-top:7px">Adjusted: removed ${esc(m.removeAttacks)} payable hit(s) and ${esc(compact(m.removeDamage))} raid damage.</div>`:""}
            </article>`).join("")}
          ${includeNon && result.nonAttackers.length ? result.nonAttackers.filter(u => !result.members.some(m => String(m.id) === String(u.id))).map(u => `<article class="rrh-member-card rrh-nonattack"><div class="rrh-member-top"><div><div class="rrh-member-name">${esc(u.name)}</div><div class="rrh-id">Torn ID: ${esc(u.id)} • NON-ATTACKER</div></div><div class="rrh-pill">0 tracked hits</div></div></article>`).join("") : ""}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("rrh-results-close")?.addEventListener("click", () => overlay.remove());
    document.getElementById("rrh-export")?.addEventListener("click", () => exportCsv(result));
    document.getElementById("rrh-payments")?.addEventListener("click", () => openPaymentsForResult(result));
  }

  function csvEscape(v) {
    const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
  }

  function exportCsv(result) {
    const rows = [["Raid ID","Faction","Member","Torn ID","Excluded","Raw Raid Hits","Raw Outside Hits","Raw Assists","Raw Retals","Removed Payable Hits","Raid Hits","Outside Hits","Assists","Retals","Weight","Pay Per Hit","Raw Raid Damage","Removed Damage","Adjusted Raid Damage","Share %","Calculated Payout"]];
    result.members.forEach(m => rows.push([result.raid.id,result.ownFaction.name,m.name,m.id,m.excluded?"Yes":"No",m.rawRaidHits,m.rawOutsideHits,m.rawAssists,m.rawRetaliationHits,m.removeAttacks,m.raidHits,m.outsideHits,m.assists,m.retaliationHits,num(m.weight).toFixed(2),Math.round(num(result.form.payPerHit)),m.rawDamage,m.removeDamage,m.damage,(m.normalizedShare*100).toFixed(4),Math.round(m.payout)]));
    const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=`torn-raid-${result.raid.id}-results.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),5000);
  }


  function copyText(value) {
    const text = String(value ?? "");
    try {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => copyTextFallback(text));
    } catch (_) {}
    return Promise.resolve(copyTextFallback(text));
  }

  function copyTextFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text ?? "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }

  function rrhFactionControlsPaymentsUrl() {
    return "https://www.torn.com/factions.php?step=your#/tab=controls&rrhPayAll=1";
  }

  function storePaymentRows(rows) {
    setJson(KEY.payRows, { createdAt: Date.now(), rows: Array.isArray(rows) ? rows : [] });
  }

  function getStoredPaymentRows() {
    const data = getJson(KEY.payRows, null);
    if (!data || !Array.isArray(data.rows)) return [];
    if (Date.now() - num(data.createdAt) > 6 * 60 * 60 * 1000) return [];
    return data.rows;
  }

  function openPaymentsForResult(result) {
    const rows = (result?.members || [])
      .filter(m => !m.excluded && num(m.payout) > 0)
      .map(m => ({ id:String(m.id || "unknown"), name:m.name || `Unknown ${m.id || "unknown"}`, payout:Math.round(num(m.payout)) }));
    storePaymentRows(rows);
    const url = rrhFactionControlsPaymentsUrl();
    try {
      if (typeof GM_openInTab === "function") {
        GM_openInTab(url, { active:true, insert:true, setParent:true });
        return true;
      }
    } catch (_) {}
    try { return !!window.open(url, "_blank", "noopener,noreferrer"); } catch (_) { return false; }
  }

  function isPaymentsRoute() {
    return /factions\.php/i.test(location.pathname) && String(location.href || "").includes("rrhPayAll=1");
  }

  function ensurePayPanelStyles() {
    if (document.getElementById("rrh-pay-all-style")) return;
    const st = document.createElement("style");
    st.id = "rrh-pay-all-style";
    st.textContent = `
      #rrh-pay-all-panel{position:fixed!important;z-index:2147483647!important;top:78px!important;left:12px!important;width:min(360px,calc(100vw - 24px))!important;height:min(620px,calc(100vh - 116px))!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;padding:9px!important;border:1px solid rgba(125,211,252,.28)!important;border-radius:18px!important;background:radial-gradient(circle at 18% 0%,rgba(56,189,248,.18),transparent 34%),linear-gradient(180deg,rgba(15,23,42,.98),rgba(2,6,23,.96))!important;color:#f8fafc!important;box-shadow:0 20px 60px rgba(0,0,0,.58),0 0 28px rgba(56,189,248,.12)!important;font-family:Inter,Segoe UI,Arial,sans-serif!important;text-align:center!important;box-sizing:border-box!important}
      #rrh-pay-all-panel[hidden]{display:none!important} #rrh-pay-all-panel *{box-sizing:border-box!important}
      .rrh-pay-all-head{cursor:move;touch-action:none;display:flex;justify-content:center;align-items:center;padding:3px 38px 9px;position:relative;flex:0 0 auto;min-height:42px}.rrh-pay-all-title{font-weight:950;color:#e0f2fe;font-size:13px}
      .rrh-pay-all-note{color:#c7d2fe;font-size:10px;line-height:1.35;margin:0 18px 7px}.rrh-pay-all-info{margin:0 8px 8px;padding:8px 9px;border-radius:12px;border:1px solid rgba(125,211,252,.16);background:rgba(15,23,42,.62);color:#dbeafe;font-size:9.5px;line-height:1.35;text-align:left}.rrh-pay-all-info b{color:#e0f2fe}.rrh-pay-all-info ul{margin:5px 0 0 13px;padding:0}.rrh-pay-all-info li{margin:2px 0}
      .rrh-pay-all-close{position:absolute!important;top:7px!important;right:8px!important;width:36px!important;height:36px!important;min-width:36px!important;min-height:36px!important;padding:0!important;display:grid!important;place-items:center!important;border-radius:14px!important;border:1px solid rgba(125,211,252,.24)!important;border-left:4px solid rgba(56,189,248,.66)!important;background:linear-gradient(180deg,rgba(30,41,59,.94),rgba(2,6,23,.88))!important;color:#eaf6ff!important;font:950 20px/1 Arial,Helvetica,sans-serif!important;box-shadow:0 1px 0 rgba(255,255,255,.045) inset,0 12px 26px rgba(0,0,0,.26)!important;cursor:pointer!important;z-index:120!important}
      .rrh-pay-all-undo{margin:0 0 8px;padding:6px 8px;min-height:28px;border-radius:10px;border:1px solid rgba(125,211,252,.28);background:linear-gradient(135deg,rgba(30,41,59,.96),rgba(49,46,129,.88));color:#f8fdff;font-size:10px;font-weight:950;cursor:pointer}.rrh-pay-all-list{display:grid;gap:6px;overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 auto;padding-right:3px;scrollbar-width:thin;scrollbar-color:rgba(56,189,248,.86) rgba(15,23,42,.36)}
      .rrh-pay-all-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:5px;align-items:center;padding:7px;border-radius:12px;border:1px solid rgba(125,211,252,.16);background:rgba(15,23,42,.72)}.rrh-pay-all-member{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:900;color:#f8fafc;text-align:left}.rrh-pay-all-payout{display:block;margin-top:1px;color:#86efac;font-size:10px;font-weight:950}.rrh-pay-all-copy{display:inline-flex!important;align-items:center;justify-content:center;padding:5px 6px;min-height:24px;border-radius:9px;border:1px solid rgba(125,211,252,.28);background:linear-gradient(135deg,rgba(30,41,59,.96),rgba(49,46,129,.88));color:#f8fdff;font-size:10px;font-weight:950;cursor:pointer;white-space:nowrap}
      .rrh-pay-resize{position:absolute;width:18px;height:18px;z-index:130;touch-action:none;user-select:none;opacity:.95;background:rgba(2,6,23,.18)}.rrh-pay-resize-se{right:7px;bottom:7px;cursor:nwse-resize;border-right:2px solid rgba(125,211,252,.8);border-bottom:2px solid rgba(125,211,252,.8)}.rrh-pay-resize-sw{left:7px;bottom:7px;cursor:nesw-resize;border-left:2px solid rgba(125,211,252,.8);border-bottom:2px solid rgba(125,211,252,.8)}.rrh-pay-resize-nw{left:7px;top:7px;cursor:nwse-resize;border-left:2px solid rgba(125,211,252,.8);border-top:2px solid rgba(125,211,252,.8)}
      @media(max-width:760px),(pointer:coarse){#rrh-pay-all-panel{top:64px!important;left:8px!important;width:min(360px,calc(100vw - 16px))!important;height:min(620px,calc(100vh - 96px))!important}.rrh-pay-all-row{grid-template-columns:minmax(0,1fr) max-content max-content!important;gap:4px!important;padding:6px!important}.rrh-pay-all-copy{padding:4px 5px!important;min-width:46px!important;font-size:9px!important}.rrh-pay-resize{width:30px!important;height:30px!important}}
    `;
    document.head.appendChild(st);
  }

  function payVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
    } catch (_) { return false; }
  }

  function payText(el) { try { return String(el?.innerText || el?.textContent || ""); } catch (_) { return ""; } }

  function payFieldMeta(el) {
    if (!el) return "";
    const attrs = ["id","class","name","placeholder","aria-label","title","data-name","data-id","type","role","data-testid"];
    const attrText = attrs.map(a => String(el.getAttribute?.(a) || "")).join(" ");
    const wrap = payText(el.closest?.("label,div,li,tr,td,section,form") || el.parentElement || el);
    return `${attrText} ${wrap}`.replace(/\s+/g," ").toLowerCase();
  }

  function payEditableFields() {
    return Array.from(document.querySelectorAll("input,textarea,[contenteditable='true'],[role='textbox'],[role='spinbutton']"))
      .filter(payVisible)
      .filter(el => !el.disabled && !el.readOnly && el.getAttribute?.("aria-disabled") !== "true")
      .filter(el => !el.closest?.("#rrh-pay-all-panel,#rrh-panel,#rrh-results"))
      .filter(el => !el.closest?.("[id*='chat' i],[class*='chat' i],[data-testid*='chat' i],[id*='settings' i],[class*='settings' i],[data-testid*='settings' i]"))
      .filter(el => !["hidden","button","submit","reset","checkbox","radio","file","image","password"].includes(String(el.type || "").toLowerCase()));
  }

  function findPayMemberField() {
    const fields = payEditableFields();
    const scored = fields.map(el => {
      const meta = payFieldMeta(el); let score=0;
      if (/\b(user|player|member|recipient|name|id|torn)\b/.test(meta)) score += 8;
      if (/\b(to|add|target|search)\b/.test(meta)) score += 2;
      if ((el.tagName || "").toLowerCase()==="input" && ["text","search",""] .includes(String(el.type || "").toLowerCase())) score += 2;
      if (/\b(amount|money|cash|balance|dollar|qty|quantity|message|comment|reason|note)\b/.test(meta)) score -= 12;
      return {el,score};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
    return scored[0]?.el || fields.find(el => !/\b(amount|money|cash|balance|dollar|qty|quantity|message|comment|reason|note)\b/.test(payFieldMeta(el)) && String(el.type || "").toLowerCase() !== "number") || null;
  }

  function findPayAmountField() {
    const fields = payEditableFields();
    const scored = fields.map((el,index) => {
      const meta=payFieldMeta(el), type=String(el.type||"").toLowerCase(), inputMode=String(el.getAttribute?.("inputmode")||"").toLowerCase(); let score=0;
      if (/\b(amount|money|cash|balance|dollar|payout|value|funds)\b/.test(meta)) score += 14;
      if (/\b(add\s*money|add\s*to\s*balance|give|transfer|deposit)\b/.test(meta)) score += 8;
      if (["number","tel"].includes(type)) score += 8;
      if (/\b(numeric|decimal)\b/.test(inputMode)) score += 7;
      if (el.getAttribute?.("role") === "spinbutton") score += 6;
      if (/\b(user|player|member|recipient|username|profile|name|id|message|comment|reason|note|search|filter)\b/.test(meta)) score -= 25;
      score += Math.min(index,8)*0.05; return {el,score};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
    if (scored[0]?.el) return scored[0].el;
    const member = findPayMemberField(); const start = member ? fields.indexOf(member)+1 : 0;
    return fields.slice(Math.max(0,start)).find(el => {
      const meta=payFieldMeta(el), type=String(el.type||"").toLowerCase();
      if (["search","email","url"].includes(type)) return false;
      return !/\b(user|player|member|recipient|username|profile|name|id|message|comment|reason|note|search|filter)\b/.test(meta);
    }) || null;
  }

  function isTouchMode() {
    try { return !!(matchMedia?.("(max-width:760px),(pointer:coarse)")?.matches || /Android|iPhone|iPad|iPod|Mobile|TornPDA|Torn PDA/i.test(navigator.userAgent || "")); } catch (_) { return false; }
  }

  function setPayFieldValue(el,value) {
    if (!el) return false;
    const text=String(value ?? ""), touch=isTouchMode();
    if (el.getAttribute?.("contenteditable") === "true" || el.getAttribute?.("role") === "textbox") {
      if (!touch) { try { el.focus?.({preventScroll:true}); el.click?.(); } catch (_) {} }
      try { el.textContent=text; el.dispatchEvent(new InputEvent("input",{bubbles:true,cancelable:true,data:text,inputType:"insertText"})); el.dispatchEvent(new Event("change",{bubbles:true})); if(touch){el.dispatchEvent(new Event("blur",{bubbles:true}));el.blur?.();} return true; } catch (_) { return false; }
    }
    let oldReadOnly, hadReadOnly=false, oldInputMode;
    if (touch) { try { oldReadOnly=el.readOnly; hadReadOnly=el.hasAttribute?.("readonly")||false; oldInputMode=el.getAttribute?.("inputmode"); el.setAttribute?.("inputmode","none"); el.readOnly=true; } catch (_) {} }
    else { try { el.focus?.({preventScroll:true}); el.click?.(); } catch (_) {} }
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc=Object.getOwnPropertyDescriptor(proto,"value"); if(desc?.set) desc.set.call(el,text); else el.value=text;
    } catch (_) { try { el.value=text; } catch (_) { return false; } }
    finally { if(touch){ try { if(oldInputMode==null) el.removeAttribute?.("inputmode"); else el.setAttribute?.("inputmode",oldInputMode); el.readOnly=oldReadOnly; if(!hadReadOnly) el.removeAttribute?.("readonly"); } catch (_) {} } }
    try { el.setAttribute?.("value",text); } catch (_) {}
    [new InputEvent("beforeinput",{bubbles:true,cancelable:true,data:text,inputType:"insertText"}),new InputEvent("input",{bubbles:true,cancelable:true,data:text,inputType:"insertText"}),new Event("change",{bubbles:true}),new KeyboardEvent("keyup",{bubbles:true,key:"0",code:"Digit0"}),new Event("blur",{bubbles:true})].forEach(evt=>{try{el.dispatchEvent(evt)}catch(_){}});
    if(touch){try{el.blur?.();document.activeElement?.blur?.()}catch(_){}}
    return true;
  }

  function enablePayPanelMoveResize(panel) {
    if (!panel || panel.dataset.moveResizeReady === "1") return;
    panel.dataset.moveResizeReady="1";
    const key="rrh_payments_copy_layout"; const head=panel.querySelector(".rrh-pay-all-head");
    ["nw","sw","se"].forEach(dir=>{const h=document.createElement("div");h.className=`rrh-pay-resize rrh-pay-resize-${dir}`;h.dataset.dir=dir;panel.appendChild(h)});
    try { const x=JSON.parse(localStorage.getItem(key)||"null"); if(x){ const w=clamp(num(x.width,360),250,Math.max(250,innerWidth-16)),h=clamp(num(x.height,620),180,Math.max(180,innerHeight-16)); panel.style.setProperty("width",`${w}px`,"important");panel.style.setProperty("height",`${h}px`,"important");panel.style.setProperty("left",`${clamp(num(x.left,12),8,Math.max(8,innerWidth-w-8))}px`,"important");panel.style.setProperty("top",`${clamp(num(x.top,78),8,Math.max(8,innerHeight-h-8))}px`,"important"); } } catch (_) {}
    let mode="",dir="",sx=0,sy=0,sl=0,st=0,sw=0,sh=0;
    const point=e=>{const t=e.touches?.[0]||e.changedTouches?.[0];return{x:num(t?.clientX??e.clientX),y:num(t?.clientY??e.clientY)}};
    const begin=(e,resize=false)=>{if(!resize && e.target.closest("button,input,select,textarea"))return;const p=point(e),r=panel.getBoundingClientRect();mode=resize?"resize":"drag";dir=resize?(e.target.closest(".rrh-pay-resize")?.dataset.dir||"se"):"";sx=p.x;sy=p.y;sl=r.left;st=r.top;sw=r.width;sh=r.height;e.preventDefault();};
    head?.addEventListener("mousedown",e=>begin(e,false)); head?.addEventListener("touchstart",e=>begin(e,false),{passive:false});
    panel.addEventListener("mousedown",e=>{if(e.target.closest(".rrh-pay-resize"))begin(e,true)}); panel.addEventListener("touchstart",e=>{if(e.target.closest(".rrh-pay-resize"))begin(e,true)},{passive:false});
    const move=e=>{if(!mode)return;const p=point(e),dx=p.x-sx,dy=p.y-sy;if(mode==="drag"){const l=clamp(sl+dx,8,Math.max(8,innerWidth-panel.offsetWidth-8)),t=clamp(st+dy,8,Math.max(8,innerHeight-panel.offsetHeight-8));panel.style.setProperty("left",`${l}px`,"important");panel.style.setProperty("top",`${t}px`,"important");}else{let w=sw,h=sh,l=sl,t=st;if(dir.includes("e"))w=sw+dx;if(dir.includes("s"))h=sh+dy;if(dir.includes("w")){w=sw-dx;l=sl+(sw-w)}if(dir.includes("n")){h=sh-dy;t=st+(sh-h)}w=clamp(w,250,Math.max(250,innerWidth-16));h=clamp(h,180,Math.max(180,innerHeight-16));l=clamp(l,8,Math.max(8,innerWidth-w-8));t=clamp(t,8,Math.max(8,innerHeight-h-8));panel.style.setProperty("width",`${w}px`,"important");panel.style.setProperty("height",`${h}px`,"important");panel.style.setProperty("left",`${l}px`,"important");panel.style.setProperty("top",`${t}px`,"important");}e.preventDefault();};
    const end=()=>{if(!mode)return;const r=panel.getBoundingClientRect();try{localStorage.setItem(key,JSON.stringify({left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}))}catch(_){}mode="";};
    document.addEventListener("mousemove",move);document.addEventListener("touchmove",move,{passive:false});document.addEventListener("mouseup",end);document.addEventListener("touchend",end);document.addEventListener("touchcancel",end);
  }

  function renderPaymentsCopyPanel(rows) {
    ensurePayPanelStyles();
    document.getElementById("rrh-pay-all-panel")?.remove();
    const panel=document.createElement("div"); panel.id="rrh-pay-all-panel";
    panel.innerHTML=`<button type="button" class="rrh-pay-all-close">×</button><div class="rrh-pay-all-head"><div class="rrh-pay-all-title">Payments Copy Panel</div></div><div class="rrh-pay-all-note">Use this helper inside Torn faction controls. It is a payout checklist, not an automatic payment sender.</div><div class="rrh-pay-all-info"><b>How to use:</b><ul><li><b>Name + ID</b> copies/prefills the member.</li><li><b>Amount</b> copies/prefills the payout money.</li><li>Buttons disappear after one click so you can track progress.</li><li>Use <b>Undo Last Disappear</b> to bring back the last hidden button.</li><li>Open the correct add money/banking fields first. Press Name + ID before Amount if Torn reveals the amount field after member selection.</li><li>You manually review and confirm every payment in Torn. RRH never clicks Add Money, Send, or Confirm.</li></ul></div><button type="button" class="rrh-pay-all-undo">Undo Last Disappear</button><div class="rrh-pay-all-list">${(rows||[]).map((r,i)=>`<div class="rrh-pay-all-row"><div class="rrh-pay-all-member">${i+1}. ${esc(r.name)} [${esc(r.id)}]<span class="rrh-pay-all-payout">${esc(money(r.payout))}</span></div><button type="button" class="rrh-pay-all-copy" data-copy-name="${i}">Name + ID</button><button type="button" class="rrh-pay-all-copy" data-copy-amount="${i}">Amount</button></div>`).join("") || `<div class="rrh-pay-all-row"><div class="rrh-pay-all-member">No payable members found.</div></div>`}</div>`;
    document.body.appendChild(panel); enablePayPanelMoveResize(panel);
    const undo=[];
    const hide=(btn,label)=>{if(!btn)return;btn.dataset.label=label;btn.hidden=true;btn.style.display="none";undo.push(btn)};
    panel.querySelector(".rrh-pay-all-close")?.addEventListener("click",()=>{ window.__rrhPayPanelDismissed=true; panel.remove(); });
    panel.querySelector(".rrh-pay-all-undo")?.addEventListener("click",()=>{while(undo.length){const b=undo.pop();if(b?.isConnected){b.hidden=false;b.style.display="";break}}});
    panel.addEventListener("click",async e=>{
      const nb=e.target.closest?.("[data-copy-name]"); if(nb){const row=rows[num(nb.dataset.copyName)]||{};const value=`${row.name || `Unknown ${row.id || "unknown"}`} [${row.id || "unknown"}]`;setPayFieldValue(findPayMemberField(),value);await copyText(value);hide(nb,"Name + ID");return;}
      const ab=e.target.closest?.("[data-copy-amount]"); if(ab){const row=rows[num(ab.dataset.copyAmount)]||{};const value=String(Math.round(num(row.payout)));setPayFieldValue(findPayAmountField(),value);await copyText(value);hide(ab,"Amount");}
    });
  }

  function maybeOpenPaymentsRoute() {
    if (!isPaymentsRoute()) { window.__rrhPayPanelDismissed=false; return false; }
    setValue(KEY.panelOpen,"0"); document.getElementById("rrh-panel")?.remove(); document.getElementById("rrh-launcher")?.remove(); document.getElementById("rrh-results")?.remove();
    if (!window.__rrhPayPanelDismissed && !document.getElementById("rrh-pay-all-panel") && !window.__rrhPayPanelScheduled) {
      window.__rrhPayPanelScheduled=true;
      setTimeout(()=>{window.__rrhPayPanelScheduled=false; if(isPaymentsRoute()&&!document.getElementById("rrh-pay-all-panel")) renderPaymentsCopyPanel(getStoredPaymentRows());},900);
    }
    return true;
  }

  function refreshReopenButton() {
    const b = document.getElementById("rrh-reopen"); if (!b) return;
    const r = getJson(KEY.lastResults, null);
    const ok = !!r && num(r.expiresAt) > Date.now();
    b.style.display = ok ? "inline-block" : "none";
  }

  function reopenResults() {
    const r = getJson(KEY.lastResults, null);
    if (!r || num(r.expiresAt) <= Date.now()) { setStatus("The saved results have expired. Calculate the raid again.", "bad"); refreshReopenButton(); return; }
    showResults(r);
  }

  function openPanel() {
    createPanel(); const p = document.getElementById("rrh-panel"); if (!p) return; p.hidden=false; setValue(KEY.panelOpen,"1");
  }
  function closePanel() { const p=document.getElementById("rrh-panel"); if(p)p.hidden=true; setValue(KEY.panelOpen,"0"); savePanelLayout(); }
  function togglePanel() { const p=document.getElementById("rrh-panel"); if(!p){openPanel();return;} p.hidden?openPanel():closePanel(); }

  function enableDrag(panel, handle) {
    if (!panel || !handle) return;
    let dragging=false, sx=0, sy=0, sl=0, st=0;
    handle.addEventListener("mousedown", e => {
      if (e.target.closest("button,input,select")) return;
      const r=panel.getBoundingClientRect(); dragging=true; sx=e.clientX; sy=e.clientY; sl=r.left; st=r.top;
      panel.style.left=`${r.left}px`; panel.style.top=`${r.top}px`; panel.style.right="auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", e => { if(!dragging)return; const left=clamp(sl+e.clientX-sx,0,Math.max(0,innerWidth-panel.offsetWidth)); const top=clamp(st+e.clientY-sy,0,Math.max(0,innerHeight-70)); panel.style.left=`${left}px`; panel.style.top=`${top}px`; });
    window.addEventListener("mouseup", () => { if(!dragging)return; dragging=false; savePanelLayout(); });
  }

  function savePanelLayout() {
    const p=document.getElementById("rrh-panel"); if(!p||p.hidden)return;
    const r=p.getBoundingClientRect(); setJson(KEY.panelLayout,{left:r.left,top:r.top,width:r.width,height:r.height});
  }
  function restorePanelLayout() {
    const p=document.getElementById("rrh-panel"); const x=getJson(KEY.panelLayout,null); if(!p||!x)return;
    const w=clamp(num(x.width,520),390,Math.max(390,innerWidth-10)); const h=clamp(num(x.height,720),420,Math.max(420,innerHeight-10));
    p.style.width=`${w}px`; p.style.height=`${h}px`; p.style.left=`${clamp(num(x.left,innerWidth-w-18),0,Math.max(0,innerWidth-w))}px`; p.style.top=`${clamp(num(x.top,110),0,Math.max(0,innerHeight-70))}px`; p.style.right="auto";
  }

  function routeRefresh() {
    styles();
    if (maybeOpenPaymentsRoute()) return;
    if (isFactionPage()) { createLauncher(); pinLauncherToViewport(); createPanel(); }
    else removeLauncherIfNeeded();
  }

  styles();
  routeRefresh();
  let lastHref=location.href;
  const observer=new MutationObserver(() => {
    if (location.href!==lastHref){lastHref=location.href; setTimeout(routeRefresh,250);} else if(isFactionPage()&&!isPaymentsRoute()){ if(!document.getElementById("rrh-launcher")) createLauncher(); else pinLauncherToViewport(); }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(() => { routeRefresh(); refreshReopenButton(); }, 2500);
})();
