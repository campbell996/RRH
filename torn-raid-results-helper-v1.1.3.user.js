// ==UserScript==
// @name         Torn Raid Results Helper
// @namespace    BFTD.TornRaidResultsHelper
// @author       BackFromTheDead_Gaming Campbell
// @version      1.1.3
// @description  Fully local Torn faction raid results helper with RWPH-style raid/outside/retal/assist contribution weights. No backend, licence, paywall or payment system.
// @license      Copyright BackFromTheDead_Gaming Campbell. All Rights Reserved. Personal use only. Redistribution, resale, or modified reposting is not permitted without permission.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// ==/UserScript==

(function () {
  "use strict";

  const APP = {
    name: "Raid Results Helper",
    short: "RRH",
    version: "1.1.3",
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
      #rrh-launcher { box-sizing:border-box; border:1px solid #2e668e; background:linear-gradient(180deg,#102b47,#071727); color:#dff3ff; min-width:39px; height:34px; border-radius:7px; padding:0 8px; font-weight:900; font-size:12px; letter-spacing:.5px; cursor:pointer; box-shadow:0 5px 18px #0008; z-index:999998; }
      #rrh-launcher:hover { border-color:#43aee7; filter:brightness(1.08); }
      #rrh-launcher.rrh-fixed-fallback { position:fixed; right:12px; top:135px; }

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

  function createLauncher() {
    if (!isFactionPage()) return;
    if (document.getElementById("rrh-launcher")) return;
    const b = document.createElement("button");
    b.id = "rrh-launcher";
    b.type = "button";
    b.textContent = APP.short;
    b.title = `Open ${APP.name}`;
    b.addEventListener("click", togglePanel);

    // Prefer the faction header/button area. If Torn changes its markup, use a stable fixed fallback.
    const candidates = [...document.querySelectorAll("h1,h2,h3,h4,h5,[class*='title'],[class*='header']")]
      .filter(el => /\bfaction\b/i.test((el.textContent || "").trim()))
      .slice(0, 30);
    let placed = false;
    for (const c of candidates) {
      const row = c.parentElement;
      if (!row || row.closest("#rrh-panel")) continue;
      const rect = row.getBoundingClientRect();
      if (rect.width < 100 || rect.height > 180) continue;
      try {
        row.appendChild(b);
        b.style.marginLeft = "8px";
        b.style.verticalAlign = "middle";
        placed = true;
        break;
      } catch (_) {}
    }
    if (!placed) {
      document.body.appendChild(b);
      b.classList.add("rrh-fixed-fallback");
    }
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
      pool: "0",
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
      pool: document.getElementById("rrh-pool")?.value || "0",
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
          <div class="rrh-field"><span>Completed raid</span><select id="rrh-raid-select"><option value="">Load raid history first</option></select></div>
          <div class="rrh-actions"><button class="rrh-btn" id="rrh-load-raids">Load Raid History</button><button class="rrh-btn secondary" id="rrh-load-report" disabled>Load Selected Raid</button></div>
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
          <label class="rrh-field"><span>Optional payout pool</span><input id="rrh-pool" value="${esc(f.pool)}" placeholder="Example: 500m or 1.25b"></label>
          <div class="rrh-grid2" style="margin-top:8px">
            <label class="rrh-field"><span>Raid Hit Weight</span><input id="rrh-raid-hit-weight" type="number" min="0" step="0.1" value="${esc(f.raidHitWeight)}"></label>
            <label class="rrh-field"><span>Outside Hit Weight</span><input id="rrh-outside-hit-weight" type="number" min="0" step="0.1" value="${esc(f.outsideHitWeight)}"></label>
            <label class="rrh-field"><span>Retaliation Hit Weight</span><input id="rrh-retaliation-hit-weight" type="number" min="0" step="0.1" value="${esc(f.retaliationHitWeight)}"></label>
            <label class="rrh-field"><span>Assist Weight</span><input id="rrh-assist-weight" type="number" min="0" step="0.1" value="${esc(f.assistWeight)}"></label>
          </div>
          <div class="rrh-small" style="margin-top:7px"><b>Raid Hits:</b> successful attacks on the opposing raid faction. <b>Outside Hits:</b> successful attacks on anyone outside the opposing raid faction during the raid. <b>Retals:</b> a retaliation against the raid opponent counts as a Raid Hit plus the Retaliation bonus; a retal against an outside target is treated as an Outside Hit. <b>Assists:</b> read from Torn's attack result and weighted separately.</div>
        </div>

        <div class="rrh-card" id="rrh-members-card">
          <div class="rrh-card-title">Member Management</div>
          <div class="rrh-small" id="rrh-members-note">Load a completed raid to manage members.</div>
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
    ["rrh-pool","rrh-raid-hit-weight","rrh-outside-hit-weight","rrh-retaliation-hit-weight","rrh-assist-weight","rrh-show-non"].forEach(id => document.getElementById(id)?.addEventListener("change", saveFormFromDom));
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
      raidHistory = Array.isArray(data.raids) ? data.raids : [];
      populateRaidSelect();
      const finished = raidHistory.filter(r => r?.end);
      setStatus(`Loaded ${raidHistory.length} raid record${raidHistory.length === 1 ? "" : "s"}; ${finished.length} completed.`, "good");
    } catch (e) { setStatus(e.message, "bad"); }
    finally { setLoading(false); }
  }

  function raidLabel(r) {
    const a = r?.aggressor || {}; const d = r?.defender || {};
    const ended = r?.end ? formatDate(r.end) : "ONGOING";
    return `#${r.id} • ${a.name || a.id} ${num(a.score).toFixed(2)} vs ${num(d.score).toFixed(2)} ${d.name || d.id} • ${ended}`;
  }

  function populateRaidSelect() {
    const sel = document.getElementById("rrh-raid-select");
    if (!sel) return;
    const saved = getForm().raidId;
    sel.innerHTML = `<option value="">Select a completed raid</option>` + raidHistory.map(r => `<option class="rrh-raid-option" value="${esc(r.id)}" ${r.end ? "" : "disabled"}>${esc(raidLabel(r))}</option>`).join("");
    if (saved && raidHistory.some(r => String(r.id) === String(saved) && r.end)) sel.value = String(saved);
    document.getElementById("rrh-load-report").disabled = !sel.value;
  }

  async function loadSelectedRaid() {
    const id = document.getElementById("rrh-raid-select")?.value;
    if (!id) return setStatus("Select a completed raid first.", "bad");
    saveFormFromDom();
    setLoading(true); resetSteps(); markStep("key"); markStep("faction"); markStep("history");
    setStatus(`Loading raid #${id} report and classifying faction attacks (requests are throttled)...`);
    try {
      await ensureFaction();
      const data = await apiRequest(`/faction/${encodeURIComponent(id)}/raidreport`, { cacheKey: `raid-report:${id}`, cacheMs: 10 * 60 * 1000 });
      if (!data?.raidreport) throw new Error("Torn returned no raid report for this raid.");
      loadedRaidReport = data.raidreport;
      markStep("report");
      loadedRaidAttacks = await loadRaidAttackLogs(loadedRaidReport);
      markStep("attacks");
      renderMembers();
      const side = getOwnSide(loadedRaidReport);
      const classified = classifyRaidAttacks(loadedRaidReport, loadedRaidAttacks);
      const tracked = [...classified.values()].reduce((n, x) => n + x.trackedAttacks, 0);
      setStatus(`Raid #${id} loaded. ${loadedRaidAttacks.length} outgoing attack log${loadedRaidAttacks.length === 1 ? "" : "s"} read; ${tracked} raid/outside/assist event${tracked === 1 ? "" : "s"} classified for ${side.name}.`, "good");
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
    if (!raidStart || !raidEnd || raidEnd <= raidStart) throw new Error("The selected raid does not have a valid completed time range.");

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

        // Keep only records that actually overlap the selected completed raid.
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
      return { id, name: c.name || d.name, raidHits:c.raidHits, outsideHits:c.outsideHits, assists:c.assists, retaliationHits:c.retaliationHits, trackedAttacks:c.trackedAttacks, reportAttacks:d.attacks, rawDamage:d.damage };
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
      return `<tr data-user="${esc(a.id)}"><td><input class="rrh-use" type="checkbox" ${x.excluded ? "" : "checked"}></td><td><b>${esc(a.name)}</b><div class="rrh-id">[${esc(a.id)}]</div></td><td>${esc(a.raidHits)}</td><td>${esc(a.outsideHits)}</td><td>${esc(a.assists)}</td><td>${esc(a.retaliationHits)}</td><td>${esc(compact(a.rawDamage))}</td><td><input class="rrh-remove-attacks" type="number" min="0" step="1" value="${esc(x.removeAttacks || 0)}"></td><td><input class="rrh-remove-damage" type="number" min="0" step="0.01" value="${esc(x.removeDamage || 0)}"></td></tr>`;
    }).join("");
    scroll.classList.remove("rrh-hidden"); note.classList.add("rrh-hidden"); calc.disabled = false;
    body.querySelectorAll("input").forEach(inp => inp.addEventListener("change", saveRaidAdjustmentsFromDom));
  }

  function buildCalculation() {
    if (!loadedRaidReport) throw new Error("Load a completed raid first.");
    if (!Array.isArray(loadedRaidAttacks)) throw new Error("Raid attack logs are not loaded.");
    saveRaidAdjustmentsFromDom();
    const form = saveFormFromDom();
    const pool = parseMoney(form.pool);
    if (!Number.isFinite(pool) || pool < 0) throw new Error("The payout pool is not valid. Examples: 500m, 1.25b, 250000000.");
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
    eligible.forEach(m => { m.normalizedShare = totalWeight > 0 ? m.weight / totalWeight : 0; m.payout = pool * m.normalizedShare; });
    members.filter(m => m.excluded).forEach(m => { m.normalizedShare = 0; m.payout = 0; });

    const totals = {
      raidHits: eligible.reduce((s,m)=>s+m.raidHits,0),
      outsideHits: eligible.reduce((s,m)=>s+m.outsideHits,0),
      assists: eligible.reduce((s,m)=>s+m.assists,0),
      retaliationHits: eligible.reduce((s,m)=>s+m.retaliationHits,0),
      payableEvents: eligible.reduce((s,m)=>s+m.payableEvents,0),
      weight: totalWeight,
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
      form: { ...form, pool, weights },
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
    if (num(a.score) > num(d.score)) return a.id;
    if (num(d.score) > num(a.score)) return d.id;
    return null;
  }

  function modeLabel(f) {
    const w = f?.weights || {};
    return `Points • Raid ${num(w.raidHit, f?.raidHitWeight ?? 1)} / Outside ${num(w.outsideHit, f?.outsideHitWeight ?? 1)} / Retal ${num(w.retaliation, f?.retaliationHitWeight ?? 1)} / Assist ${num(w.assist, f?.assistWeight ?? 0)}`;
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
          <div><div class="rrh-results-title">Raid #${esc(r.id)} Results</div><div class="rrh-small">${esc(formatDate(r.start))} → ${esc(formatDate(r.end))}</div></div>
          <div class="rrh-actions" style="margin:0"><button class="rrh-btn secondary" id="rrh-export">Export CSV</button><button class="rrh-btn" id="rrh-results-close">Close Results</button></div>
        </div>
        <div class="rrh-summary">
          <div class="rrh-summary-card"><span>Your faction</span><b>${esc(result.ownFaction.name)}</b></div>
          <div class="rrh-summary-card"><span>Calculation</span><b>${esc(modeLabel(result.form))}</b></div>
          <div class="rrh-summary-card"><span>Raid Hits</span><b>${esc(result.totals.raidHits)}</b></div>
          <div class="rrh-summary-card"><span>Outside Hits</span><b>${esc(result.totals.outsideHits)}</b></div>
          <div class="rrh-summary-card"><span>Retals</span><b>${esc(result.totals.retaliationHits)}</b></div>
          <div class="rrh-summary-card"><span>Assists</span><b>${esc(result.totals.assists)}</b></div>
          <div class="rrh-summary-card"><span>Total weight</span><b>${esc(num(result.totals.weight).toFixed(2))}</b></div>
          <div class="rrh-summary-card"><span>Eligible members</span><b>${esc(result.totals.eligible)}</b></div>
          <div class="rrh-summary-card"><span>Raid damage</span><b>${esc(compact(result.totals.damage))}</b></div>
          <div class="rrh-summary-card"><span>Payout pool</span><b>${esc(money(result.form.pool))}</b></div>
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
  }

  function csvEscape(v) {
    const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
  }

  function exportCsv(result) {
    const rows = [["Raid ID","Faction","Member","Torn ID","Excluded","Raw Raid Hits","Raw Outside Hits","Raw Assists","Raw Retals","Removed Payable Hits","Raid Hits","Outside Hits","Assists","Retals","Weight","Raw Raid Damage","Removed Damage","Adjusted Raid Damage","Share %","Calculated Payout"]];
    result.members.forEach(m => rows.push([result.raid.id,result.ownFaction.name,m.name,m.id,m.excluded?"Yes":"No",m.rawRaidHits,m.rawOutsideHits,m.rawAssists,m.rawRetaliationHits,m.removeAttacks,m.raidHits,m.outsideHits,m.assists,m.retaliationHits,num(m.weight).toFixed(2),m.rawDamage,m.removeDamage,m.damage,(m.normalizedShare*100).toFixed(4),Math.round(m.payout)]));
    const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=`torn-raid-${result.raid.id}-results.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),5000);
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
    if (isFactionPage()) { styles(); createLauncher(); createPanel(); }
    else removeLauncherIfNeeded();
  }

  styles();
  routeRefresh();
  let lastHref=location.href;
  const observer=new MutationObserver(() => {
    if (location.href!==lastHref){lastHref=location.href; setTimeout(routeRefresh,250);} else if(isFactionPage()&&!document.getElementById("rrh-launcher")) createLauncher();
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(() => { routeRefresh(); refreshReopenButton(); }, 2500);
})();
