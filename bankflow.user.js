// ==UserScript==
// @name         BankFlow
// @namespace    bankflow
// @version      2.3.0
// @description  Transfer & merge assistant for UCU and BCU credit union accounts
// @match        https://online.ucu.org/*
// @match        https://safe.bcu.org/*
// @match        https://fluz.app/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @noframes
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ── Site Detection ──────────────────────────────────────────────────
  const BANK_MAP = {
    "online.ucu.org": { id: "ucu", name: "UCU", full: "University Credit Union" },
    "safe.bcu.org": { id: "bcu", name: "BCU", full: "Baxter Credit Union" },
  };
  const BANK = BANK_MAP[location.hostname];
  const IS_FLUZ = location.hostname === "fluz.app";

  if (!BANK && !IS_FLUZ) return;

  // ── Fluz: Capture pending balance and exit ──────────────────────────
  if (IS_FLUZ) {
    // Intercept fetch responses to capture pending_cash_balance from Fluz route data
    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function (input, init) {
      const result = origFetch.apply(this, arguments);
      result.then((resp) => {
        // Only intercept .data turbo-stream responses (Remix single-fetch)
        const url = typeof input === "string" ? input : input?.url || "";
        if (!url.includes(".data")) return;
        resp.clone().text().then((text) => {
          try {
            // Look for pending_cash_balance in the turbo-stream response
            // The format varies but the field name is consistent
            const pendingMatch = text.match(/"pending_cash_balance"\s*[:,]\s*([\d.]+)/);
            if (pendingMatch) {
              const pending = parseFloat(pendingMatch[1]);
              if (!isNaN(pending)) {
                GM_setValue("fluz_pending", { amount: pending, ts: Date.now() });
              }
            }
          } catch {}
        }).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // Also intercept XHR
    const origXHROpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const origXHRSend = unsafeWindow.XMLHttpRequest.prototype.send;
    unsafeWindow.XMLHttpRequest.prototype.open = function () {
      this._bfUrl = arguments[1] || "";
      return origXHROpen.apply(this, arguments);
    };
    unsafeWindow.XMLHttpRequest.prototype.send = function () {
      if (this._bfUrl?.includes?.(".data")) {
        this.addEventListener("load", function () {
          try {
            const m = this.responseText?.match(/"pending_cash_balance"\s*[:,]\s*([\d.]+)/);
            if (m) {
              const pending = parseFloat(m[1]);
              if (!isNaN(pending)) GM_setValue("fluz_pending", { amount: pending, ts: Date.now() });
            }
          } catch {}
        });
      }
      return origXHRSend.apply(this, arguments);
    };
    return; // Don't inject BankFlow UI on Fluz
  }

  // ── Fluz Pending Balance (read from GM storage) ─────────────────────
  function getFluzPending() {
    const data = GM_getValue("fluz_pending", null);
    if (!data) return 0;
    // Only use if less than 1 hour old
    if (Date.now() - data.ts > 3600_000) return 0;
    return data.amount || 0;
  }

  // Listen for updates from the Fluz tab
  GM_addValueChangeListener("fluz_pending", (_key, _old, _new, remote) => {
    if (remote && S.visible) render();
  });

  // ── Token Interception ──────────────────────────────────────────────
  let token = null;
  let tokenLastSeen = 0;
  const TOKEN_TTL = 600_000;

  function captureToken(authHeader) {
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
      tokenLastSeen = Date.now();
      if (root) updateStatus();
    }
  }

  function hasToken() {
    return token && Date.now() - tokenLastSeen < TOKEN_TTL;
  }

  function tokenTimeLeft() {
    if (!hasToken()) return 0;
    return Math.max(0, Math.floor((tokenLastSeen + TOKEN_TTL - Date.now()) / 1000));
  }

  function fmtTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Intercept XMLHttpRequest (use unsafeWindow for @grant mode)
  const origSetRequestHeader = unsafeWindow.XMLHttpRequest.prototype.setRequestHeader;
  unsafeWindow.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === "authorization") captureToken(value);
    return origSetRequestHeader.call(this, name, value);
  };

  // Intercept fetch
  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (input, init) {
    try {
      const h = init?.headers;
      if (h) {
        let auth;
        if (h instanceof Headers) auth = h.get("authorization");
        else if (Array.isArray(h)) {
          const p = h.find(([k]) => k.toLowerCase() === "authorization");
          auth = p?.[1];
        } else {
          auth = h["Authorization"] || h["authorization"];
        }
        if (auth) captureToken(auth);
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  // ── API ─────────────────────────────────────────────────────────────
  async function apiGet(path) {
    if (!hasToken()) throw new Error("Session expired — refresh the page");
    const r = await origFetch(path, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (r.status === 401) { token = null; throw new Error("Session expired — refresh the page"); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function apiPost(path, body) {
    if (!hasToken()) throw new Error("Session expired — refresh the page");
    const r = await origFetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { token = null; throw new Error("Session expired — refresh the page"); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function getAccounts() {
    const data = await apiGet("/gateway/web/accounts");
    return (data.accounts || []).map((a) => ({
      id: a.id,
      nickname: a.nickname || a.description,
      suffix: a.suffix,
      availableBalance: a.availableBalance,
      currentBalance: a.actualBalance,
      type: a.primaryMapping === "S" ? "savings" : "checking",
      description: a.description,
    }));
  }

  async function execTransfer(fromId, toId, amount, fromName, toName) {
    const id = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    await apiPost("/gateway/web/transfer-scheduler", {
      amount,
      frequency: "NOW",
      transactionId: id,
      fromAccount: { id: fromId, name: fromName, source: "HOST" },
      toAccount: { id: toId, name: toName, source: "HOST" },
      paymentOptionId: null,
      note: "",
      isSameDaySettlement: false,
      feeAccountId: "",
    });
  }

  // ── State ───────────────────────────────────────────────────────────
  const S = {
    visible: false,
    tab: "main",
    view: "home",
    accounts: [],
    transfer: { sources: new Set(), amounts: {}, targetId: "" },
    loading: false,
    error: null,
    message: null,
    results: null,
  };

  // ── UI ──────────────────────────────────────────────────────────────
  let root;

  const CSS = `
    :host { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0;
      --muted: #94a3b8; --accent: #3b82f6; --accent-h: #2563eb; --green: #22c55e; --emerald: #10b981;
      --red: #ef4444; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

    * { box-sizing: border-box; }

    #bf-toggle {
      pointer-events: auto; position: fixed; bottom: 20px; right: 20px;
      width: 44px; height: 44px; border-radius: 50%; border: none;
      background: var(--accent); color: #fff; font: bold 14px var(--font);
      cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.4); z-index: 1;
      transition: background .15s, transform .15s;
    }
    #bf-toggle:hover { background: var(--accent-h); transform: scale(1.08); }

    #bf-panel {
      pointer-events: auto; display: none; flex-direction: column;
      position: fixed; bottom: 76px; right: 20px; width: 380px; max-height: 80vh;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5); font: 13px var(--font); color: var(--text);
      overflow: hidden; transition: width .2s;
    }
    #bf-panel.wide { width: 520px; }

    #bf-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--border);
      cursor: move; user-select: none;
    }
    .bf-title { font-weight: 700; font-size: 14px; }
    .bf-status { display: flex; align-items: center; gap: 6px; }
    .bf-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .bf-dot.on { background: var(--green); }
    .bf-dot.off { background: var(--red); }
    .bf-dot.wait { background: #f59e0b; }
    .bf-timer { font-size: 11px; color: var(--muted); }
    #bf-close {
      background: none; border: none; color: var(--muted); font-size: 20px;
      cursor: pointer; padding: 0 4px; line-height: 1; margin-left: 8px;
    }
    #bf-close:hover { color: var(--text); }

    #bf-content { padding: 14px; overflow-y: auto; flex: 1; }

    /* Accounts table */
    .section-hdr { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
      color: var(--muted); margin-bottom: 8px; display: flex; align-items: center;
      justify-content: space-between; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 500;
      padding: 4px 0; border-bottom: 1px solid var(--border); }
    th:last-child { text-align: right; }
    td { padding: 6px 0; font-size: 13px; }
    td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    tr:not(:last-child) td { border-bottom: 1px solid rgba(51,65,85,.4); }
    .total td { border-top: 1px solid var(--border); font-weight: 600; padding-top: 8px; }
    .fluz-note { color: var(--dim); font-weight: 400; font-size: 11px; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 16px; border-radius: 6px; border: none; font: 600 13px var(--font);
      cursor: pointer; transition: background .15s;
    }
    .btn-p { background: var(--emerald); color: #fff; }
    .btn-p:hover { background: #059669; }
    .btn-p:disabled { opacity: .4; cursor: not-allowed; }
    .btn-s { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .btn-s:hover { border-color: var(--text); }
    .btn-sm { padding: 3px 10px; font-size: 11px; }
    .actions { display: flex; gap: 8px; margin-top: 4px; }

    /* Alerts */
    .alert { padding: 8px 12px; border-radius: 5px; font-size: 12px; margin-bottom: 12px; }
    .alert.error { background: rgba(239,68,68,.12); color: var(--red); }
    .alert.success { background: rgba(34,197,94,.12); color: var(--green); }

    /* Two-column transfer layout */
    .tf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .tf-col-hdr {
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
      color: var(--muted); margin-bottom: 6px; display: flex; align-items: center;
      justify-content: space-between;
    }
    .tf-toggle-all { font-size: 11px; font-weight: 500; color: rgba(16,185,129,.7);
      cursor: pointer; text-transform: none; letter-spacing: 0; }
    .tf-toggle-all:hover { color: var(--emerald); }
    .tf-list {
      border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
      max-height: 50vh; overflow-y: auto;
    }
    .tf-list::-webkit-scrollbar { width: 4px; }
    .tf-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    /* Source account row */
    .tf-row {
      padding: 7px 10px; transition: background .1s; cursor: pointer;
      border-bottom: 1px solid rgba(51,65,85,.3);
    }
    .tf-row:last-child { border-bottom: none; }
    .tf-row:hover { background: rgba(15,23,42,.5); }
    .tf-row.selected { background: rgba(16,185,129,.05); }
    .tf-row.is-target { opacity: .2; pointer-events: none; }
    .tf-row-main { display: flex; align-items: center; gap: 8px; }
    .tf-check {
      width: 16px; height: 16px; border-radius: 3px; border: 1.5px solid var(--border);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: all .15s;
    }
    .tf-check.on { border-color: var(--emerald); background: var(--emerald); }
    .tf-check svg { display: none; }
    .tf-check.on svg { display: block; }
    .tf-name { flex: 1; min-width: 0; }
    .tf-name-text { font-size: 12px; font-weight: 500; color: #fff; }
    .tf-name-suffix { font-size: 11px; color: var(--border); margin-left: 4px; }
    .tf-bal { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    /* Amount editor */
    .tf-amount-row { display: flex; align-items: center; gap: 6px; margin: 5px 0 0 24px; }
    .tf-amount-row span { font-size: 11px; color: var(--border); }
    .tf-amt {
      width: 80px; padding: 3px 6px; border-radius: 3px;
      border: 1px solid var(--border); background: var(--bg); color: var(--emerald);
      font: 12px var(--font); text-align: right; outline: none;
      font-variant-numeric: tabular-nums;
      -moz-appearance: textfield;
    }
    .tf-amt::-webkit-inner-spin-button, .tf-amt::-webkit-outer-spin-button { -webkit-appearance: none; }
    .tf-amt:focus { border-color: rgba(16,185,129,.5); }
    .tf-all { font-size: 11px; color: var(--border); cursor: pointer; }
    .tf-all:hover { color: var(--emerald); }

    /* Target account row (radio) */
    .tf-radio {
      width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: all .15s;
    }
    .tf-radio.on { border-color: var(--emerald); }
    .tf-radio-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); display: none; }
    .tf-radio.on .tf-radio-dot { display: block; }

    /* Source summary */
    .tf-summary {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 2px; margin-top: 6px; font-size: 11px; color: var(--muted);
    }
    .tf-summary-amount { font-size: 12px; font-weight: 700; color: var(--emerald);
      font-variant-numeric: tabular-nums; }

    /* Target projected balance */
    .tf-projected {
      margin-top: 8px; padding: 8px 10px; border-radius: 5px;
      border: 1px solid rgba(16,185,129,.2); background: rgba(16,185,129,.05);
      display: flex; align-items: center; justify-content: space-between;
    }
    .tf-projected-label { font-size: 11px; color: var(--muted); }
    .tf-projected-val { font-size: 14px; font-weight: 700; color: var(--emerald);
      font-variant-numeric: tabular-nums; }

    /* Bottom bar */
    .tf-bottom {
      border-top: 1px solid var(--border); padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .tf-bottom-info { font-size: 11px; color: var(--muted); }
    .tf-bottom-info strong { color: var(--emerald); }
    .tf-bottom-info .tf-arrow { color: var(--muted); margin: 0 4px; }
    .tf-bottom-info .tf-target-name { color: var(--text); }
    .tf-bottom-btns { display: flex; gap: 6px; }

    .back {
      display: inline-flex; align-items: center; gap: 4px; background: none; border: none;
      color: var(--muted); font: 13px var(--font); cursor: pointer; padding: 0; margin-bottom: 12px;
    }
    .back:hover { color: var(--text); }

    .result-item { padding: 6px 0; font-size: 13px; border-bottom: 1px solid rgba(51,65,85,.3); }
    .ok { color: var(--green); } .fail { color: var(--red); }

    .loading { text-align: center; padding: 20px; color: var(--muted); }
    .spinner {
      display: inline-block; width: 20px; height: 20px; border: 2px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%;
      animation: spin .6s linear infinite; margin-bottom: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .waiting { text-align: center; padding: 24px 12px; color: var(--muted); font-size: 13px; }

    /* Nav tabs */
    .bf-nav {
      display: flex; border-bottom: 1px solid var(--border);
      padding: 0 14px; gap: 0; background: var(--bg);
    }
    .bf-nav-tab {
      padding: 6px 12px; font: 500 11px var(--font); color: var(--muted);
      background: none; border: none; border-bottom: 2px solid transparent;
      cursor: pointer; text-transform: uppercase; letter-spacing: .3px;
    }
    .bf-nav-tab:hover { color: var(--text); }
    .bf-nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    /* Dev view */
    .dev-section { margin-bottom: 14px; }
    .dev-section-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
      color: var(--muted); margin-bottom: 6px; font-weight: 600;
    }
    .dev-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 0; font-size: 12px; border-bottom: 1px solid rgba(51,65,85,.3);
    }
    .dev-row:last-child { border-bottom: none; }
    .dev-label { color: var(--muted); }
    .dev-value { color: var(--text); font-variant-numeric: tabular-nums; font-family: monospace; font-size: 11px; }
    .dev-value.ok { color: var(--green); }
    .dev-value.warn { color: #f59e0b; }
    .dev-value.err { color: var(--red); }
    .dev-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .dev-input {
      width: 80px; padding: 3px 6px; border-radius: 3px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: 12px monospace; text-align: right;
    }
    .dev-mono { font-family: monospace; font-size: 10px; color: var(--muted);
      word-break: break-all; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }

    #bf-content::-webkit-scrollbar { width: 6px; }
    #bf-content::-webkit-scrollbar-track { background: transparent; }
    #bf-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  `;

  function esc(s) {
    const d = document.createElement("span");
    d.textContent = s;
    return d.innerHTML;
  }

  function fmtCurrency(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  }

  const checkSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function createUI() {
    const host = document.createElement("div");
    host.id = "bankflow-host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;pointer-events:none";
    document.body.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "bf-toggle";
    btn.textContent = "BF";
    btn.addEventListener("click", toggle);
    root.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "bf-panel";
    panel.innerHTML = `
      <div id="bf-header">
        <span class="bf-title">BankFlow · ${BANK.name}</span>
        <div class="bf-status">
          <span class="bf-dot wait" id="bf-dot"></span>
          <span class="bf-timer" id="bf-timer">--:--</span>
          <button id="bf-close">&times;</button>
        </div>
      </div>
      <div class="bf-nav">
        <button class="bf-nav-tab active" data-tab="main">Accounts</button>
        <button class="bf-nav-tab" data-tab="dev">Dev</button>
      </div>
      <div id="bf-content"></div>
      <div id="bf-bottom" class="tf-bottom" style="display:none"></div>
    `;
    root.appendChild(panel);

    root.querySelector("#bf-close").addEventListener("click", toggle);
    panel.addEventListener("click", onClick);
    panel.addEventListener("input", onInput);
    panel.addEventListener("change", onInput);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const a = e.target.dataset.enterAction;
        if (a) handleAction(a);
      }
    });

    // Drag
    let dragging = false, dx = 0, dy = 0;
    root.querySelector("#bf-header").addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  function toggle() {
    S.visible = !S.visible;
    root.querySelector("#bf-panel").style.display = S.visible ? "flex" : "none";
    if (S.visible) render();
  }

  function updateStatus() {
    if (!root) return;
    const dot = root.querySelector("#bf-dot");
    const timer = root.querySelector("#bf-timer");
    if (!dot || !timer) return;
    if (hasToken()) {
      dot.className = "bf-dot on";
      timer.textContent = fmtTime(tokenTimeLeft());
    } else if (token) {
      dot.className = "bf-dot off";
      timer.textContent = "expired";
    } else {
      dot.className = "bf-dot wait";
      timer.textContent = "waiting";
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    const el = root.querySelector("#bf-content");
    const bottom = root.querySelector("#bf-bottom");
    const panel = root.querySelector("#bf-panel");
    if (!el) return;
    updateStatus();
    root.querySelectorAll(".bf-nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.tab));

    let h = "";
    if (S.error) h += `<div class="alert error">${esc(S.error)}</div>`;
    if (S.message) h += `<div class="alert success">${esc(S.message)}</div>`;

    if (S.tab === "dev") {
      h += devView();
      bottom.style.display = "none"; bottom.innerHTML = "";
      panel.classList.remove("wide");
    } else if (S.loading) {
      h += '<div class="loading"><div class="spinner"></div><div>Loading...</div></div>';
      bottom.style.display = "none"; bottom.innerHTML = "";
      panel.classList.remove("wide");
    } else if (!hasToken()) {
      h += '<div class="waiting">Waiting for session...<br/><br/>Log into your bank account — BankFlow will activate automatically.</div>';
      bottom.style.display = "none"; bottom.innerHTML = "";
      panel.classList.remove("wide");
    } else {
      switch (S.view) {
        case "transfer":
          h += transferView();
          bottom.innerHTML = transferBottom();
          bottom.style.display = "";
          panel.classList.add("wide");
          break;
        case "results":
          h += resultsView();
          bottom.style.display = "none"; bottom.innerHTML = "";
          panel.classList.remove("wide");
          break;
        default:
          h += homeView();
          bottom.style.display = "none"; bottom.innerHTML = "";
          panel.classList.remove("wide");
          break;
      }
    }
    el.innerHTML = h;
  }

  function homeView() {
    if (S.accounts.length === 0) {
      loadAccounts();
      return '<div class="loading"><div class="spinner"></div><div>Loading accounts...</div></div>';
    }

    const fluzPending = getFluzPending();

    let h = `<div class="section-hdr"><span>Accounts</span>
      <button class="btn btn-s btn-sm" data-action="refresh">Refresh</button></div>`;
    h += "<table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>";
    let total = 0;
    for (const a of S.accounts) {
      total += a.availableBalance;
      h += `<tr><td>${esc(a.nickname)}</td><td>${fmtCurrency(a.availableBalance)}</td></tr>`;
    }
    const netTotal = fluzPending > 0 ? total - fluzPending : total;
    h += `<tr class="total"><td>Total${fluzPending > 0 ? `<span class="fluz-note"> (−${fmtCurrency(fluzPending)} Fluz pending)</span>` : ""}</td><td>${fmtCurrency(netTotal)}</td></tr>`;
    h += "</tbody></table>";
    h += '<div class="actions"><button class="btn btn-p" data-action="show-transfer">Transfer</button></div>';
    return h;
  }

  function transferView() {
    const accounts = S.accounts;
    const sourceCandidates = accounts.filter((a) => a.id !== S.transfer.targetId && a.availableBalance > 0);
    const allSelected = sourceCandidates.length > 0 && sourceCandidates.every((a) => S.transfer.sources.has(a.id));

    let h = '<div class="tf-grid">';

    // ── Left: Sources ──
    h += "<div>";
    h += `<div class="tf-col-hdr">
      <span>From</span>
      <span class="tf-toggle-all" data-action="toggle-all">${allSelected ? "Deselect all" : "Select all"}</span>
    </div>`;
    h += '<div class="tf-list">';
    for (const a of accounts) {
      if (a.availableBalance <= 0) continue;
      const isTarget = S.transfer.targetId === a.id;
      const selected = S.transfer.sources.has(a.id) && !isTarget;
      const amount = S.transfer.amounts[a.id] ?? a.availableBalance;
      const isPartial = selected && amount > 0 && amount < a.availableBalance;

      h += `<div class="tf-row ${selected ? "selected" : ""} ${isTarget ? "is-target" : ""}" data-action="toggle-source" data-param="${esc(a.id)}">
        <div class="tf-row-main">
          <div class="tf-check ${selected ? "on" : ""}">${checkSvg}</div>
          <div class="tf-name">
            <span class="tf-name-text">${esc(a.nickname)}</span>
            ${a.suffix ? `<span class="tf-name-suffix">...${esc(a.suffix)}</span>` : ""}
          </div>
          <span class="tf-bal">${fmtCurrency(a.availableBalance)}</span>
        </div>
        ${selected ? `
          <div class="tf-amount-row" onclick="event.stopPropagation()">
            <span>$</span>
            <input type="number" class="tf-amt" data-input="amount" data-account="${esc(a.id)}"
              value="${amount}" min="0.01" max="${a.availableBalance}" step="0.01"
              onclick="event.stopPropagation()" onfocus="this.select()" />
            ${isPartial ? `<span class="tf-all" data-action="set-all" data-param="${esc(a.id)}">all</span>` : ""}
          </div>
        ` : ""}
      </div>`;
    }
    h += "</div>";

    // Source summary
    const selectedSources = accounts.filter((a) => S.transfer.sources.has(a.id) && a.id !== S.transfer.targetId);
    const totalAmount = selectedSources.reduce((sum, a) => sum + (S.transfer.amounts[a.id] ?? a.availableBalance), 0);
    h += `<div class="tf-summary">
      <span>${selectedSources.filter((a) => (S.transfer.amounts[a.id] ?? a.availableBalance) > 0).length} selected</span>
      <span class="tf-summary-amount">${fmtCurrency(totalAmount)}</span>
    </div>`;
    h += "</div>";

    // ── Right: Target ──
    h += "<div>";
    h += '<div class="tf-col-hdr"><span>To</span></div>';
    h += '<div class="tf-list">';
    for (const a of accounts) {
      const isTarget = S.transfer.targetId === a.id;
      h += `<div class="tf-row ${isTarget ? "selected" : ""}" data-action="set-target" data-param="${esc(a.id)}">
        <div class="tf-row-main">
          <div class="tf-radio ${isTarget ? "on" : ""}"><div class="tf-radio-dot"></div></div>
          <div class="tf-name">
            <span class="tf-name-text">${esc(a.nickname)}</span>
            ${a.suffix ? `<span class="tf-name-suffix">...${esc(a.suffix)}</span>` : ""}
          </div>
          <span class="tf-bal">${fmtCurrency(a.availableBalance)}</span>
        </div>
      </div>`;
    }
    h += "</div>";

    // Projected balance
    if (S.transfer.targetId) {
      const target = accounts.find((a) => a.id === S.transfer.targetId);
      if (target) {
        const projected = target.availableBalance + totalAmount;
        h += `<div class="tf-projected">
          <span class="tf-projected-label">After transfer</span>
          <span class="tf-projected-val">${fmtCurrency(projected)}</span>
        </div>`;
      }
    }
    h += "</div>";

    h += "</div>"; // close tf-grid
    return h;
  }

  function transferBottom() {
    const accounts = S.accounts;
    const selectedSources = accounts.filter((a) => S.transfer.sources.has(a.id) && a.id !== S.transfer.targetId);
    const totalAmount = selectedSources.reduce((sum, a) => sum + (S.transfer.amounts[a.id] ?? a.availableBalance), 0);
    const target = accounts.find((a) => a.id === S.transfer.targetId);
    const canExecute = selectedSources.some((a) => (S.transfer.amounts[a.id] ?? a.availableBalance) > 0) && S.transfer.targetId;

    let info = `${selectedSources.filter((a) => (S.transfer.amounts[a.id] ?? a.availableBalance) > 0).length} accounts · <strong>${fmtCurrency(totalAmount)}</strong>`;
    if (target) {
      info += `<span class="tf-arrow">\u2192</span><span class="tf-target-name">${esc(target.nickname)}</span>`;
    }

    return `
      <div class="tf-bottom-info">${info}</div>
      <div class="tf-bottom-btns">
        <button class="btn btn-s btn-sm" data-action="back">Cancel</button>
        <button class="btn btn-p btn-sm" data-action="do-transfer" ${canExecute ? "" : "disabled"}>Execute</button>
      </div>
    `;
  }

  function resultsView() {
    let h = '<button class="back" data-action="back">&larr; Done</button>';
    h += '<div style="font-weight:600;font-size:15px;margin-bottom:12px">Results</div>';
    for (const r of S.results || []) {
      const cls = r.success ? "ok" : "fail";
      const icon = r.success ? "&#10003;" : "&#10007;";
      h += `<div class="result-item"><span class="${cls}">${icon}</span> ${esc(r.from)} &rarr; ${esc(r.to)}: ${fmtCurrency(r.amount)}
        ${r.error ? `<div style="font-size:11px;color:var(--red)">${esc(r.error)}</div>` : ""}</div>`;
    }
    h += '<div class="actions" style="margin-top:14px"><button class="btn btn-p" data-action="back">Done</button></div>';
    return h;
  }

  // ── Dev View ──────────────────────────────────────────────────────────
  function devView() {
    const ttl = tokenTimeLeft();
    const tokenStatus = hasToken() ? "ok" : token ? "err" : "warn";
    const tokenLabel = hasToken() ? `Active (${fmtTime(ttl)})` : token ? "Expired" : "None";
    const tokenPreview = token ? token.slice(0, 16) + "..." : "—";

    const fluzData = GM_getValue("fluz_pending", null);
    const fluzAge = fluzData ? Math.round((Date.now() - fluzData.ts) / 1000) : null;
    const fluzAgeLabel = fluzAge !== null
      ? fluzAge < 60 ? `${fluzAge}s ago` : `${Math.round(fluzAge / 60)}m ago`
      : "—";

    let h = "";

    // Token section
    h += '<div class="dev-section">';
    h += '<div class="dev-section-title">Session</div>';
    h += `<div class="dev-row"><span class="dev-label">Status</span><span class="dev-value ${tokenStatus}">${tokenLabel}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Token</span><span class="dev-value dev-mono">${tokenPreview}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Bank</span><span class="dev-value">${BANK.name} (${BANK.id})</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Hostname</span><span class="dev-value dev-mono">${location.hostname}</span></div>`;
    h += "</div>";

    // Fluz section
    h += '<div class="dev-section">';
    h += '<div class="dev-section-title">Fluz Integration</div>';
    h += `<div class="dev-row"><span class="dev-label">Pending balance</span><span class="dev-value">${fluzData ? fmtCurrency(fluzData.amount) : "—"}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Last updated</span><span class="dev-value">${fluzAgeLabel}</span></div>`;
    h += '<div class="dev-actions">';
    h += '<button class="btn btn-s btn-sm" data-action="dev-set-fluz">Set Fluz Pending</button>';
    h += '<input class="dev-input" id="dev-fluz-amt" type="number" value="500" step="50">';
    h += '<button class="btn btn-s btn-sm" data-action="dev-clear-fluz">Clear</button>';
    h += "</div></div>";

    // State section
    h += '<div class="dev-section">';
    h += '<div class="dev-section-title">State</div>';
    h += `<div class="dev-row"><span class="dev-label">Accounts loaded</span><span class="dev-value">${S.accounts.length}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">View</span><span class="dev-value">${S.view}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Transfer sources</span><span class="dev-value">${S.transfer.sources.size}</span></div>`;
    h += `<div class="dev-row"><span class="dev-label">Transfer target</span><span class="dev-value dev-mono">${S.transfer.targetId || "—"}</span></div>`;
    h += '<div class="dev-actions">';
    h += '<button class="btn btn-s btn-sm" data-action="dev-reload">Force Reload Accounts</button>';
    h += '<button class="btn btn-s btn-sm" data-action="dev-clear-state">Reset State</button>';
    h += "</div></div>";

    // Version
    h += `<div style="text-align:center;font-size:10px;color:var(--border);margin-top:8px">BankFlow v2.3.0</div>`;

    return h;
  }

  // ── Events ──────────────────────────────────────────────────────────
  function onClick(e) {
    // Tab navigation
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      S.tab = tab.dataset.tab;
      if (S.tab === "main") { S.view = "home"; }
      root.querySelectorAll(".bf-nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.tab));
      render();
      return;
    }

    const el = e.target.closest("[data-action]");
    if (!el) return;
    handleAction(el.dataset.action, el.dataset.param);
  }

  function onInput(e) {
    const el = e.target;
    if (el.dataset.input === "amount") {
      const id = el.dataset.account;
      const max = S.accounts.find((a) => a.id === id)?.availableBalance ?? Infinity;
      S.transfer.amounts[id] = Math.min(parseFloat(el.value) || 0, max);
      // Update bottom bar and summary without full re-render
      const bottom = root.querySelector("#bf-bottom");
      if (bottom) bottom.innerHTML = transferBottom();
    }
  }

  async function handleAction(action, param) {
    S.error = null;
    S.message = null;
    try {
      switch (action) {
        case "refresh":
          S.accounts = [];
          render();
          break;

        case "show-transfer": {
          // Pre-select all accounts with balance
          S.transfer.sources.clear();
          S.transfer.amounts = {};
          S.transfer.targetId = "";
          const withBalance = S.accounts.filter((a) => a.availableBalance > 0);
          withBalance.forEach((a) => {
            S.transfer.sources.add(a.id);
            S.transfer.amounts[a.id] = a.availableBalance;
          });
          S.view = "transfer";
          render();
          break;
        }

        case "toggle-source":
          saveAmounts();
          if (S.transfer.sources.has(param)) {
            S.transfer.sources.delete(param);
            delete S.transfer.amounts[param];
          } else {
            S.transfer.sources.add(param);
            const acct = S.accounts.find((a) => a.id === param);
            if (acct) S.transfer.amounts[param] = acct.availableBalance;
          }
          if (S.transfer.sources.has(S.transfer.targetId)) S.transfer.targetId = "";
          render();
          break;

        case "toggle-all": {
          saveAmounts();
          const candidates = S.accounts.filter((a) => a.id !== S.transfer.targetId && a.availableBalance > 0);
          const allSelected = candidates.every((a) => S.transfer.sources.has(a.id));
          if (allSelected) {
            S.transfer.sources.clear();
            S.transfer.amounts = {};
          } else {
            candidates.forEach((a) => {
              S.transfer.sources.add(a.id);
              if (!(a.id in S.transfer.amounts)) S.transfer.amounts[a.id] = a.availableBalance;
            });
          }
          render();
          break;
        }

        case "set-target":
          saveAmounts();
          S.transfer.targetId = param;
          // Remove from sources if selected
          S.transfer.sources.delete(param);
          delete S.transfer.amounts[param];
          render();
          break;

        case "set-all": {
          const acct = S.accounts.find((a) => a.id === param);
          if (acct) S.transfer.amounts[param] = acct.availableBalance;
          render();
          break;
        }

        case "do-transfer": {
          saveAmounts();
          const selectedSources = S.accounts.filter((a) => S.transfer.sources.has(a.id) && a.id !== S.transfer.targetId);
          if (!S.transfer.targetId || selectedSources.length === 0) {
            S.error = "Select source and target accounts";
            render();
            return;
          }
          const target = S.accounts.find((a) => a.id === S.transfer.targetId);
          S.loading = true;
          render();
          const results = [];
          for (const src of selectedSources) {
            const amount = S.transfer.amounts[src.id] || 0;
            if (amount <= 0) continue;
            try {
              await execTransfer(src.id, S.transfer.targetId, amount, src.description || "", target?.description || "");
              results.push({ from: src.nickname, to: target?.nickname || "", amount, success: true });
            } catch (err) {
              results.push({ from: src.nickname, to: target?.nickname || "", amount, success: false, error: err.message });
            }
          }
          S.loading = false;
          S.results = results;
          S.view = "results";
          S.accounts = [];
          render();
          break;
        }

        case "back":
          S.view = "home";
          render();
          break;

        case "dev-set-fluz": {
          const input = root.querySelector("#dev-fluz-amt");
          const amt = parseFloat(input?.value) || 500;
          GM_setValue("fluz_pending", { amount: amt, ts: Date.now() });
          render();
          break;
        }

        case "dev-clear-fluz":
          GM_setValue("fluz_pending", null);
          render();
          break;

        case "dev-reload":
          S.accounts = [];
          S.tab = "main";
          S.view = "home";
          root.querySelectorAll(".bf-nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "main"));
          render();
          break;

        case "dev-clear-state":
          S.accounts = [];
          S.transfer = { sources: new Set(), amounts: {}, targetId: "" };
          S.error = null;
          S.message = null;
          S.results = null;
          S.view = "home";
          render();
          break;
      }
    } catch (err) {
      S.loading = false;
      S.error = err.message;
      render();
    }
  }

  function saveAmounts() {
    root.querySelectorAll(".tf-amt").forEach((el) => {
      S.transfer.amounts[el.dataset.account] = parseFloat(el.value) || 0;
    });
  }

  // ── Account Loading ─────────────────────────────────────────────────
  let acctLoading = false;
  async function loadAccounts() {
    if (acctLoading) return;
    acctLoading = true;
    try {
      S.accounts = await getAccounts();
    } catch (e) {
      S.error = e.message;
    }
    acctLoading = false;
    render();
  }

  // ── Timer ───────────────────────────────────────────────────────────
  setInterval(() => {
    if (!root || !S.visible) return;
    updateStatus();
    if (!hasToken() && token) {
      S.accounts = [];
      render();
    }
  }, 1000);

  // ── Init ────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById("bankflow-host")) return;
    createUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
