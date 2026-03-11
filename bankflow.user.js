// ==UserScript==
// @name         BankFlow
// @namespace    bankflow
// @version      2.0.0
// @description  Transfer & merge assistant for UCU and BCU credit union accounts
// @match        https://online.ucu.org/*
// @match        https://safe.bcu.org/*
// @grant        none
// @noframes
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ── Bank Detection ──────────────────────────────────────────────────
  const BANK_MAP = {
    "online.ucu.org": { id: "ucu", name: "UCU", full: "University Credit Union" },
    "safe.bcu.org": { id: "bcu", name: "BCU", full: "Baxter Credit Union" },
  };
  const BANK = BANK_MAP[location.hostname];
  if (!BANK) return;

  // ── Token Interception ──────────────────────────────────────────────
  let token = null;
  let tokenLastSeen = 0;
  const TOKEN_TTL = 600_000; // 10 minutes

  function captureToken(authHeader) {
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
      tokenLastSeen = Date.now();
      // If UI exists, update status
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

  // Intercept XMLHttpRequest
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === "authorization") captureToken(value);
    return origSetRequestHeader.call(this, name, value);
  };

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
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
    view: "home",
    accounts: [],
    transfer: { sources: new Set(), amounts: {}, targetId: "" },
    loading: false,
    error: null,
    message: null,
    results: null,
  };

  // ── UI ──────────────────────────────────────────────────────────────
  let root; // shadow root

  const CSS = `
    :host { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0;
      --muted: #94a3b8; --accent: #3b82f6; --accent-h: #2563eb; --green: #22c55e;
      --red: #ef4444; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

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
      position: fixed; bottom: 76px; right: 20px; width: 360px; max-height: 75vh;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5); font: 13px var(--font); color: var(--text);
      overflow: hidden;
    }

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
    .bf-section { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
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

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 16px; border-radius: 6px; border: none; font: 600 13px var(--font);
      cursor: pointer; transition: background .15s;
    }
    .btn-p { background: var(--accent); color: #fff; }
    .btn-p:hover { background: var(--accent-h); }
    .btn-p:disabled { opacity: .5; cursor: not-allowed; }
    .btn-s { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .btn-s:hover { border-color: var(--text); }
    .btn-sm { padding: 3px 10px; font-size: 11px; }
    .actions { display: flex; gap: 8px; margin-top: 4px; }

    /* Alerts */
    .alert { padding: 8px 12px; border-radius: 5px; font-size: 12px; margin-bottom: 12px; }
    .alert.error { background: rgba(239,68,68,.12); color: var(--red); }
    .alert.success { background: rgba(34,197,94,.12); color: var(--green); }

    /* Transfer */
    .label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .select {
      width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 5px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: 13px var(--font); outline: none; margin-bottom: 10px; appearance: auto;
    }
    .select:focus { border-color: var(--accent); }
    .src-item {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: var(--bg); border-radius: 5px; margin-bottom: 6px; cursor: pointer;
    }
    .src-item:hover { outline: 1px solid var(--border); }
    .src-item input[type=checkbox] { accent-color: var(--accent); cursor: pointer; }
    .src-info { flex: 1; }
    .src-name { font-size: 13px; }
    .src-bal { font-size: 11px; color: var(--muted); }
    .src-amt {
      width: 90px; box-sizing: border-box; padding: 4px 8px; border-radius: 4px;
      border: 1px solid var(--border); background: var(--surface); color: var(--text);
      font: 13px var(--font); text-align: right; outline: none;
    }
    .src-amt:focus { border-color: var(--accent); }
    .all-link { font-size: 11px; color: var(--accent); cursor: pointer; margin-left: 4px; }
    .all-link:hover { text-decoration: underline; }

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
      <div id="bf-content"></div>
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
    if (!el) return;
    updateStatus();
    let h = "";
    if (S.error) h += `<div class="alert error">${esc(S.error)}</div>`;
    if (S.message) h += `<div class="alert success">${esc(S.message)}</div>`;

    if (S.loading) {
      h += '<div class="loading"><div class="spinner"></div><div>Loading...</div></div>';
    } else if (!hasToken()) {
      h += '<div class="waiting">Waiting for session...<br/><br/>Log into your bank account — BankFlow will activate automatically.</div>';
    } else {
      switch (S.view) {
        case "transfer": h += transferView(); break;
        case "results": h += resultsView(); break;
        default: h += homeView(); break;
      }
    }
    el.innerHTML = h;
  }

  function homeView() {
    if (S.accounts.length === 0) {
      loadAccounts();
      return '<div class="loading"><div class="spinner"></div><div>Loading accounts...</div></div>';
    }

    let h = `<div class="bf-section"><span>Accounts</span>
      <button class="btn btn-s btn-sm" data-action="refresh">Refresh</button></div>`;
    h += "<table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>";
    let total = 0;
    for (const a of S.accounts) {
      total += a.availableBalance;
      h += `<tr><td>${esc(a.nickname)}</td><td>${fmtCurrency(a.availableBalance)}</td></tr>`;
    }
    h += `<tr class="total"><td>Total</td><td>${fmtCurrency(total)}</td></tr>`;
    h += "</tbody></table>";
    h += '<div class="actions"><button class="btn btn-p" data-action="show-transfer">Transfer</button></div>';
    return h;
  }

  function transferView() {
    const accounts = S.accounts;
    let h = '<button class="back" data-action="back">&larr; Back</button>';

    h += '<div class="label" style="margin-bottom:8px">From</div>';
    for (const a of accounts) {
      const checked = S.transfer.sources.has(a.id);
      const amount = S.transfer.amounts[a.id] ?? a.availableBalance;
      h += `<div class="src-item">
        <input type="checkbox" data-action="toggle-source" data-param="${esc(a.id)}" ${checked ? "checked" : ""} />
        <div class="src-info">
          <div class="src-name">${esc(a.nickname)}</div>
          <div class="src-bal">${fmtCurrency(a.availableBalance)}</div>
        </div>
        ${checked ? `
          <input type="number" class="src-amt" data-input="amount" data-account="${esc(a.id)}"
            value="${amount}" min="0.01" max="${a.availableBalance}" step="0.01" />
          ${amount < a.availableBalance ? `<span class="all-link" data-action="set-all" data-param="${esc(a.id)}">all</span>` : ""}
        ` : ""}
      </div>`;
    }

    const targets = accounts.filter((a) => !S.transfer.sources.has(a.id));
    h += '<label class="label" style="margin-top:6px">To</label>';
    h += '<select class="select" id="bf-target" data-input="target"><option value="">Select account</option>';
    for (const a of targets) {
      h += `<option value="${esc(a.id)}" ${a.id === S.transfer.targetId ? "selected" : ""}>${esc(a.nickname)} (${fmtCurrency(a.availableBalance)})</option>`;
    }
    h += "</select>";

    let total = 0;
    S.transfer.sources.forEach((id) => {
      total += S.transfer.amounts[id] ?? S.accounts.find((a) => a.id === id)?.availableBalance ?? 0;
    });
    if (S.transfer.sources.size > 0) {
      h += `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Total: <strong style="color:var(--text)">${fmtCurrency(total)}</strong></div>`;
    }

    const ok = S.transfer.sources.size > 0 && S.transfer.targetId;
    h += `<button class="btn btn-p" data-action="do-transfer" style="width:100%" ${ok ? "" : "disabled"}>Execute Transfer</button>`;
    return h;
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

  // ── Events ──────────────────────────────────────────────────────────
  function onClick(e) {
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
    }
    if (el.dataset.input === "target") {
      S.transfer.targetId = el.value;
      const btn = root.querySelector('[data-action="do-transfer"]');
      if (btn) btn.disabled = !(S.transfer.sources.size > 0 && S.transfer.targetId);
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

        case "show-transfer":
          S.transfer.sources.clear();
          S.transfer.amounts = {};
          S.transfer.targetId = "";
          S.view = "transfer";
          render();
          break;

        case "toggle-source":
          saveAmounts();
          if (S.transfer.sources.has(param)) {
            S.transfer.sources.delete(param);
            delete S.transfer.amounts[param];
          } else {
            S.transfer.sources.add(param);
            S.transfer.amounts[param] = S.accounts.find((a) => a.id === param)?.availableBalance ?? 0;
          }
          if (S.transfer.sources.has(S.transfer.targetId)) S.transfer.targetId = "";
          readTarget();
          render();
          break;

        case "set-all": {
          const acct = S.accounts.find((a) => a.id === param);
          if (acct) S.transfer.amounts[param] = acct.availableBalance;
          render();
          break;
        }

        case "do-transfer": {
          readTarget();
          saveAmounts();
          if (!S.transfer.targetId || S.transfer.sources.size === 0) {
            S.error = "Select source and target accounts";
            render();
            return;
          }
          const target = S.accounts.find((a) => a.id === S.transfer.targetId);
          S.loading = true;
          render();
          const results = [];
          for (const srcId of S.transfer.sources) {
            const src = S.accounts.find((a) => a.id === srcId);
            const amount = S.transfer.amounts[srcId] || 0;
            if (amount <= 0) continue;
            try {
              await execTransfer(srcId, S.transfer.targetId, amount, src?.description || "", target?.description || "");
              results.push({ from: src?.nickname || srcId, to: target?.nickname || "", amount, success: true });
            } catch (err) {
              results.push({ from: src?.nickname || srcId, to: target?.nickname || "", amount, success: false, error: err.message });
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
      }
    } catch (err) {
      S.loading = false;
      S.error = err.message;
      render();
    }
  }

  function saveAmounts() {
    root.querySelectorAll(".src-amt").forEach((el) => {
      S.transfer.amounts[el.dataset.account] = parseFloat(el.value) || 0;
    });
  }

  function readTarget() {
    const tgt = root.querySelector("#bf-target");
    if (tgt) S.transfer.targetId = tgt.value;
  }

  // ── Account Loading ─────────────────────────────────────────────────
  let loading = false;
  async function loadAccounts() {
    if (loading) return;
    loading = true;
    try {
      S.accounts = await getAccounts();
    } catch (e) {
      S.error = e.message;
    }
    loading = false;
    render();
  }

  // ── Timer ───────────────────────────────────────────────────────────
  setInterval(() => {
    if (!root || !S.visible) return;
    updateStatus();
    if (!hasToken() && token) {
      // Token just expired
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
