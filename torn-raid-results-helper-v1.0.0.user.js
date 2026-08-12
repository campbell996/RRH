// ==UserScript==
// @name         Torn Raid Results Helper
// @namespace    BFTD.TornRaidResultsHelper
// @author       BackFromTheDead_Gaming Campbell
// @version      1.0.0
// @description  Fully local Torn faction raid results and payout-share calculator. No backend, licence, paywall or payment system.
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
    version: "1.0.0",
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
  };

  let raidHistory = [];
  let loadedRaidReport = null;
  let ownFaction = null;
  let loading = false;

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

  function apiRequest(path) {
    const apiKey = String(getValue(KEY.api, "") || "").trim();
    if (!apiKey) return Promise.reject(new Error("Save your Torn API key first."));

    return new Promise((resolve, reject) => {
      const url = `${APP.apiBase}${path}`;
      const done = (status, text) => {
        let data;
        try { data = JSON.parse(text || "{}"); }
        catch (_) { return reject(new Error(`Torn API returned invalid JSON (HTTP ${status}).`)); }
        if (status < 200 || status >= 300) {
          const msg = data?.error?.error || data?.error?.message || data?.message || `HTTP ${status}`;
          return reject(new Error(msg));
        }
        if (data?.error) {
          const msg = data.error.error || data.error.message || `Torn API error ${data.error.code || ""}`;
          return reject(new Error(msg));
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
          onload: r => done(r.status, r.responseText),
          onerror: () => reject(new Error("Could not connect to the Torn API.")),
          ontimeout: () => reject(new Error("Torn API request timed out.")),
        });
      } else {
        fetch(url, { headers: { "Authorization": `ApiKey ${apiKey}`, "Accept": "application/json" } })
          .then(async r => done(r.status, await r.text()))
          .catch(() => reject(new Error("Could not connect to the Torn API.")));
      }
    });
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
      mode: "hybrid",
      attackShare: 50,
      showNonAttackers: true,
    }, getJson(KEY.form, {}));
  }

  function saveFormFromDom() {
    const form = {
      raidId: document.getElementById("rrh-raid-select")?.value || "",
      pool: document.getElementById("rrh-pool")?.value || "0",
      mode: document.getElementById("rrh-mode")?.value || "hybrid",
      attackShare: clamp(num(document.getElementById("rrh-attack-share")?.value, 50), 0, 100),
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
            <div class="rrh-step" data-step="calc"><i class="rrh-dot"></i>Calculate</div>
          </div>
        </div>

        <div class="rrh-card">
          <div class="rrh-card-title">Raid Result Calculation</div>
          <div class="rrh-grid2">
            <label class="rrh-field"><span>Optional payout pool</span><input id="rrh-pool" value="${esc(f.pool)}" placeholder="Example: 500m or 1.25b"></label>
            <label class="rrh-field"><span>Distribution mode</span><select id="rrh-mode"><option value="attacks">Attacks</option><option value="damage">Damage</option><option value="hybrid">Hybrid</option></select></label>
          </div>
          <div id="rrh-hybrid-settings" style="margin-top:8px">
            <label class="rrh-field"><span>Hybrid attack share % (damage receives the remainder)</span><input id="rrh-attack-share" type="number" min="0" max="100" step="1" value="${esc(f.attackShare)}"></label>
          </div>
          <div class="rrh-small" style="margin-top:7px"><b>Attacks:</b> split by adjusted attack count. <b>Damage:</b> split by adjusted raid damage. <b>Hybrid:</b> combines each member's attack share and damage share using the percentage above.</div>
        </div>

        <div class="rrh-card" id="rrh-members-card">
          <div class="rrh-card-title">Member Management</div>
          <div class="rrh-small" id="rrh-members-note">Load a completed raid to manage members.</div>
          <div class="rrh-member-scroll rrh-hidden" id="rrh-member-scroll"><table class="rrh-member-table"><thead><tr><th>Use</th><th>Member</th><th>Attacks</th><th>Damage</th><th>Remove attacks</th><th>Remove damage</th></tr></thead><tbody id="rrh-member-body"></tbody></table></div>
          <div class="rrh-actions"><label class="rrh-small"><input type="checkbox" id="rrh-show-non" ${f.showNonAttackers ? "checked" : ""}> Include non-attackers in the results page</label></div>
        </div>

        <div class="rrh-card">
          <div class="rrh-actions" style="margin:0"><button class="rrh-btn" style="flex:1" id="rrh-calc" disabled>Calculate Raid Results</button><button class="rrh-btn secondary" id="rrh-reopen" style="display:none">Reopen Results</button></div>
          <div class="rrh-small" style="margin-top:8px">Calculations and recent results stay on this device. RRH never sends cash/items or performs Torn payment actions.</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("rrh-mode").value = f.mode;
    syncHybridVisibility();
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
        const data = await apiRequest("/user/faction");
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
    document.getElementById("rrh-mode")?.addEventListener("change", () => { syncHybridVisibility(); saveFormFromDom(); });
    ["rrh-pool","rrh-attack-share","rrh-show-non"].forEach(id => document.getElementById(id)?.addEventListener("change", saveFormFromDom));
    document.getElementById("rrh-calc")?.addEventListener("click", calculateAndShowResults);
    document.getElementById("rrh-reopen")?.addEventListener("click", reopenResults);
    enableDrag(document.getElementById("rrh-panel"), document.getElementById("rrh-drag"));
    const p = document.getElementById("rrh-panel");
    if (p && typeof ResizeObserver !== "undefined") new ResizeObserver(savePanelLayout).observe(p);
  }

  function syncHybridVisibility() {
    const mode = document.getElementById("rrh-mode")?.value;
    document.getElementById("rrh-hybrid-settings")?.classList.toggle("rrh-hidden", mode !== "hybrid");
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
    const data = await apiRequest("/user/faction");
    markStep("key"); markStep("faction");
    ownFaction = data.faction || null;
    if (!ownFaction?.id) throw new Error("This Torn account is not currently in a faction.");
    return ownFaction;
  }

  async function loadRaidHistory() {
    const key = document.getElementById("rrh-api")?.value.trim() || String(getValue(KEY.api, "") || "").trim();
    if (key) setValue(KEY.api, key);
    setLoading(true); resetSteps(); loadedRaidReport = null; renderMembers();
    setStatus("Loading your faction and raid history...");
    try {
      await ensureFaction();
      const data = await apiRequest("/faction/raids?limit=100&sort=DESC");
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
    setStatus(`Loading raid #${id} report...`);
    try {
      await ensureFaction();
      const data = await apiRequest(`/faction/${encodeURIComponent(id)}/raidreport`);
      if (!data?.raidreport) throw new Error("Torn returned no raid report for this raid.");
      loadedRaidReport = data.raidreport;
      markStep("report");
      renderMembers();
      const side = getOwnSide(loadedRaidReport);
      setStatus(`Raid #${id} loaded. ${side.attackers.length} attacker${side.attackers.length === 1 ? "" : "s"} found for ${side.name}.`, "good");
    } catch (e) { loadedRaidReport = null; renderMembers(); setStatus(e.message, "bad"); }
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

  function renderMembers() {
    const body = document.getElementById("rrh-member-body");
    const scroll = document.getElementById("rrh-member-scroll");
    const note = document.getElementById("rrh-members-note");
    const calc = document.getElementById("rrh-calc");
    if (!body || !scroll || !note || !calc) return;
    if (!loadedRaidReport) {
      body.innerHTML = ""; scroll.classList.add("rrh-hidden"); note.classList.remove("rrh-hidden"); calc.disabled = true; return;
    }
    const side = getOwnSide(loadedRaidReport);
    const adj = getRaidAdjustments();
    body.innerHTML = side.attackers.map(a => {
      const u = a.user || {}; const x = adj[String(u.id)] || {};
      return `<tr data-user="${esc(u.id)}"><td><input class="rrh-use" type="checkbox" ${x.excluded ? "" : "checked"}></td><td><b>${esc(u.name)}</b><div class="rrh-id">[${esc(u.id)}]</div></td><td>${esc(a.attacks)}</td><td>${esc(compact(a.damage))}</td><td><input class="rrh-remove-attacks" type="number" min="0" step="1" value="${esc(x.removeAttacks || 0)}"></td><td><input class="rrh-remove-damage" type="number" min="0" step="0.01" value="${esc(x.removeDamage || 0)}"></td></tr>`;
    }).join("");
    scroll.classList.remove("rrh-hidden"); note.classList.add("rrh-hidden"); calc.disabled = false;
    body.querySelectorAll("input").forEach(inp => inp.addEventListener("change", saveRaidAdjustmentsFromDom));
  }

  function buildCalculation() {
    if (!loadedRaidReport) throw new Error("Load a completed raid first.");
    saveRaidAdjustmentsFromDom();
    const form = saveFormFromDom();
    const pool = parseMoney(form.pool);
    if (!Number.isFinite(pool) || pool < 0) throw new Error("The payout pool is not valid. Examples: 500m, 1.25b, 250000000.");
    const attackShare = clamp(num(form.attackShare, 50), 0, 100) / 100;
    const damageShare = 1 - attackShare;
    const mode = form.mode;
    const side = getOwnSide(loadedRaidReport);
    const adj = getRaidAdjustments();

    const members = side.attackers.map(a => {
      const u = a.user || {};
      const x = adj[String(u.id)] || {};
      const rawAttacks = Math.max(0, int(a.attacks));
      const rawDamage = Math.max(0, num(a.damage));
      return {
        id: u.id, name: u.name || `User ${u.id}`,
        rawAttacks, rawDamage,
        removeAttacks: Math.max(0, int(x.removeAttacks)),
        removeDamage: Math.max(0, num(x.removeDamage)),
        attacks: Math.max(0, rawAttacks - Math.max(0, int(x.removeAttacks))),
        damage: Math.max(0, rawDamage - Math.max(0, num(x.removeDamage))),
        excluded: !!x.excluded,
      };
    });

    const eligible = members.filter(m => !m.excluded);
    const totalAttacks = eligible.reduce((s,m) => s + m.attacks, 0);
    const totalDamage = eligible.reduce((s,m) => s + m.damage, 0);

    eligible.forEach(m => {
      const ar = totalAttacks > 0 ? m.attacks / totalAttacks : 0;
      const dr = totalDamage > 0 ? m.damage / totalDamage : 0;
      if (mode === "attacks") m.share = ar;
      else if (mode === "damage") m.share = dr;
      else m.share = (ar * attackShare) + (dr * damageShare);
      m.attackRatio = ar; m.damageRatio = dr;
    });
    const sumShare = eligible.reduce((s,m) => s + m.share, 0);
    eligible.forEach(m => { m.normalizedShare = sumShare > 0 ? m.share / sumShare : 0; m.payout = pool * m.normalizedShare; });
    members.filter(m => m.excluded).forEach(m => { m.share = 0; m.normalizedShare = 0; m.payout = 0; m.attackRatio = 0; m.damageRatio = 0; });

    const sorted = [...members].sort((a,b) => b.normalizedShare - a.normalizedShare || b.damage - a.damage || b.attacks - a.attacks);
    return {
      createdAt: Date.now(), expiresAt: Date.now() + APP.resultTtl,
      raid: loadedRaidReport,
      ownFaction: { id: side.id, name: side.name, score: side.score },
      form: { ...form, pool, attackSharePercent: attackShare * 100, damageSharePercent: damageShare * 100 },
      totals: { attacks: totalAttacks, damage: totalDamage, eligible: eligible.length, excluded: members.length - eligible.length },
      members: sorted,
      nonAttackers: side.non_attackers || [],
    };
  }

  function calculateAndShowResults() {
    try {
      const result = buildCalculation();
      markStep("calc");
      setJson(KEY.lastResults, result);
      refreshReopenButton();
      showResults(result);
      setStatus(`Raid #${result.raid.id} results calculated locally.`, "good");
    } catch (e) { setStatus(e.message, "bad"); }
  }

  function winnerId(report) {
    const a = report?.aggressor || {}; const d = report?.defender || {};
    if (num(a.score) > num(d.score)) return a.id;
    if (num(d.score) > num(a.score)) return d.id;
    return null;
  }

  function modeLabel(f) {
    if (f.mode === "attacks") return "Attacks";
    if (f.mode === "damage") return "Damage";
    return `Hybrid ${num(f.attackSharePercent).toFixed(0)}% attacks / ${num(f.damageSharePercent).toFixed(0)}% damage`;
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
          <div class="rrh-summary-card"><span>Eligible members</span><b>${esc(result.totals.eligible)}</b></div>
          <div class="rrh-summary-card"><span>Adjusted attacks</span><b>${esc(result.totals.attacks)}</b></div>
          <div class="rrh-summary-card"><span>Adjusted damage</span><b>${esc(compact(result.totals.damage))}</b></div>
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
                <div class="rrh-stat"><span>Attacks</span><b>${esc(m.attacks)}</b></div>
                <div class="rrh-stat"><span>Damage</span><b>${esc(compact(m.damage))}</b></div>
                <div class="rrh-stat"><span>Attack share</span><b>${(m.attackRatio*100).toFixed(2)}%</b></div>
                <div class="rrh-stat"><span>Damage share</span><b>${(m.damageRatio*100).toFixed(2)}%</b></div>
              </div>
              ${(m.removeAttacks||m.removeDamage)?`<div class="rrh-small rrh-warn" style="margin-top:7px">Adjusted: removed ${esc(m.removeAttacks)} attack(s) and ${esc(compact(m.removeDamage))} damage.</div>`:""}
            </article>`).join("")}
          ${includeNon && result.nonAttackers.length ? result.nonAttackers.map(u => `<article class="rrh-member-card rrh-nonattack"><div class="rrh-member-top"><div><div class="rrh-member-name">${esc(u.name)}</div><div class="rrh-id">Torn ID: ${esc(u.id)} • NON-ATTACKER</div></div><div class="rrh-pill">0 attacks</div></div></article>`).join("") : ""}
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
    const rows = [["Raid ID","Faction","Member","Torn ID","Excluded","Raw Attacks","Removed Attacks","Adjusted Attacks","Raw Damage","Removed Damage","Adjusted Damage","Share %","Calculated Payout"]];
    result.members.forEach(m => rows.push([result.raid.id,result.ownFaction.name,m.name,m.id,m.excluded?"Yes":"No",m.rawAttacks,m.removeAttacks,m.attacks,m.rawDamage,m.removeDamage,m.damage,(m.normalizedShare*100).toFixed(4),Math.round(m.payout)]));
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
