// ==UserScript==
// @name         BankFlow
// @namespace    bankflow
// @version      1.0.0
// @description  Transfer & merge funds across UCU and BCU credit union accounts
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      online.ucu.org
// @connect      safe.bcu.org
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────
  const BANKS = {
    ucu: { id: "ucu", name: "UCU", full: "University Credit Union", base: "https://online.ucu.org" },
    bcu: { id: "bcu", name: "BCU", full: "Baxter Credit Union", base: "https://safe.bcu.org" },
  };
  const TOKEN_BUFFER_S = 60;

  // ── Utilities ───────────────────────────────────────────────────────
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function parseResponseHeaders(raw) {
    const headers = {};
    const cookies = [];
    (raw || "").split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "set-cookie") cookies.push(val);
      else headers[key] = val;
    });
    headers["set-cookie"] = cookies;
    return headers;
  }

  function fmtCurrency(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  }

  function fmtTime(expiresAt) {
    const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = left % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Storage ─────────────────────────────────────────────────────────
  function getDeviceInfo(bankId) {
    return GM_getValue(`bf_device_${bankId}`, null);
  }
  function saveDeviceInfo(bankId, info) {
    GM_setValue(`bf_device_${bankId}`, info);
  }

  // ── HTTP ────────────────────────────────────────────────────────────
  function http(method, url, { headers = {}, body = null, cookies = null } = {}) {
    return new Promise((resolve, reject) => {
      const h = { "Content-Type": "application/json", Accept: "application/json", ...headers };
      if (cookies) h["Cookie"] = cookies;
      GM_xmlhttpRequest({
        method,
        url,
        headers: h,
        data: body ? JSON.stringify(body) : undefined,
        anonymous: true,
        onload(r) {
          let data;
          try { data = JSON.parse(r.responseText); } catch { data = r.responseText; }
          resolve({ status: r.status, data, headers: parseResponseHeaders(r.responseHeaders) });
        },
        onerror(e) {
          reject(new Error(e.error || "Network error"));
        },
      });
    });
  }

  function bankGet(bankId, path, token) {
    const b = BANKS[bankId].base;
    return http("GET", `${b}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: b, Referer: `${b}/dashboard` },
    });
  }

  function bankPost(bankId, path, token, body) {
    const b = BANKS[bankId].base;
    return http("POST", `${b}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: b, Referer: `${b}/dashboard` },
      body,
    });
  }

  function bankAuthPost(bankId, path, body) {
    const b = BANKS[bankId].base;
    const dev = getDeviceInfo(bankId);
    return http("POST", `${b}${path}`, {
      headers: { Origin: b, Referer: `${b}/dashboard` },
      body,
      cookies: dev?.cookies || null,
    });
  }

  // ── Cookies ─────────────────────────────────────────────────────────
  function extractCookies(respHeaders) {
    return (respHeaders["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  }

  function mergeCookies(existing, fresh) {
    if (!fresh) return existing || "";
    if (!existing) return fresh;
    const map = {};
    [existing, fresh].forEach((str) =>
      str.split(";").forEach((c) => {
        const eq = c.indexOf("=");
        if (eq > 0) map[c.slice(0, eq).trim()] = c.slice(eq + 1);
      })
    );
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function updateDeviceCookies(bankId, respHeaders) {
    const fresh = extractCookies(respHeaders);
    if (!fresh) return;
    const dev = getDeviceInfo(bankId) || {};
    dev.cookies = mergeCookies(dev.cookies, fresh);
    saveDeviceInfo(bankId, dev);
  }

  // ── State ───────────────────────────────────────────────────────────
  const S = {
    visible: false,
    view: "home",
    sessions: {},
    accounts: [],
    login: { bankId: "ucu", mfaOptions: [], selectedMfa: null, deviceId: null, credentials: null, contactType: null },
    transfer: { bankId: null, sources: new Set(), amounts: {}, targetId: "" },
    loading: false,
    error: null,
    message: null,
    pushTimer: null,
  };

  // ── Auth ────────────────────────────────────────────────────────────
  async function doLogin(bankId, username, password) {
    const dev = getDeviceInfo(bankId) || {};
    const deviceId = dev.deviceId || uuid();
    dev.deviceId = deviceId;
    saveDeviceInfo(bankId, dev);

    const resp = await bankAuthPost(bankId, "/auth/login", {
      username, password, admin: false, deviceId,
    });
    updateDeviceCookies(bankId, resp.headers);
    const d = resp.data;

    if (d.resultCode !== "OK") throw new Error(d.error || d.resultCode || "Login failed");

    if (!d.mfaRequired && d.access_token) {
      setSession(bankId, d.access_token, d.expires_in || 600);
      return { success: true };
    }
    if (d.mfaRequired) {
      return {
        success: false, mfaRequired: true,
        mfaOptions: d.mfaOptions || [], deviceId,
        credentials: { username, password },
      };
    }
    throw new Error("Unexpected response");
  }

  async function doSendOtp(bankId, contactType, channel) {
    const dev = getDeviceInfo(bankId);
    const resp = await bankAuthPost(bankId, `/auth/sendPreAuthOtp/${contactType}`, {
      deviceId: dev?.deviceId, mfaChannel: channel, useVoiceForSms: false, eventType: "", transactionId: "",
    });
    updateDeviceCookies(bankId, resp.headers);
  }

  async function doValidateOtp(bankId, otp, contactType, credentials) {
    const dev = getDeviceInfo(bankId);
    const path = contactType ? `/auth/validatePreAuthOtp/${contactType}` : "/auth/validatePreAuthOtp";
    const resp = await bankAuthPost(bankId, path, {
      otp, deviceId: dev?.deviceId, eventType: "", transactionId: "", authenticatorResponse: "",
    });
    updateDeviceCookies(bankId, resp.headers);
    const d = resp.data;
    if (d.access_token) {
      setSession(bankId, d.access_token, d.expires_in || 600);
      return { success: true };
    }
    if (d.resultCode === "OK" && credentials) {
      return doLogin(bankId, credentials.username, credentials.password);
    }
    throw new Error(d.error || "OTP failed");
  }

  async function doPollPush(bankId, credentials) {
    const result = await doLogin(bankId, credentials.username, credentials.password);
    if (result.success) return { success: true };
    if (result.mfaRequired) return { success: false, pending: true };
    return { success: false, pending: false };
  }

  function setSession(bankId, token, expiresIn) {
    S.sessions[bankId] = { token, expiresAt: Date.now() + expiresIn * 1000 };
  }

  function getSession(bankId) {
    const s = S.sessions[bankId];
    if (!s) return null;
    if (Date.now() > s.expiresAt - TOKEN_BUFFER_S * 1000) {
      delete S.sessions[bankId];
      return null;
    }
    return s;
  }

  function connectedBanks() {
    return Object.keys(BANKS).filter((id) => getSession(id));
  }

  // ── Bank API ────────────────────────────────────────────────────────
  async function fetchAccounts(bankId) {
    const s = getSession(bankId);
    if (!s) return [];
    const resp = await bankGet(bankId, "/gateway/web/accounts", s.token);
    if (!resp.data?.accounts) return [];
    return resp.data.accounts.map((a) => ({
      id: `${bankId}:${a.id}`,
      rawId: a.id,
      bankId,
      nickname: a.nickname || a.description,
      accountNumber: a.accountNumber,
      suffix: a.suffix,
      availableBalance: a.availableBalance,
      currentBalance: a.actualBalance,
      type: a.primaryMapping === "S" ? "savings" : "checking",
      description: a.description,
    }));
  }

  async function fetchAllAccounts() {
    const results = await Promise.all(connectedBanks().map(fetchAccounts));
    return results.flat();
  }

  async function execTransfer(bankId, fromId, toId, amount, fromName, toName) {
    const s = getSession(bankId);
    if (!s) throw new Error("Not connected");
    const resp = await bankPost(bankId, "/gateway/web/transfer-scheduler", s.token, {
      amount,
      frequency: "NOW",
      transactionId: uuid(),
      fromAccount: { id: fromId.replace(/^[^:]+:/, ""), name: fromName || "", source: "HOST" },
      toAccount: { id: toId.replace(/^[^:]+:/, ""), name: toName || "", source: "HOST" },
      paymentOptionId: null,
      note: "",
      isSameDaySettlement: false,
      feeAccountId: "",
    });
    return { success: resp.status >= 200 && resp.status < 300 };
  }

  // ── UI Setup ────────────────────────────────────────────────────────
  let root; // shadow root

  function createUI() {
    const host = document.createElement("div");
    host.id = "bankflow-host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;pointer-events:none";
    document.body.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    // Toggle button
    const btn = document.createElement("button");
    btn.id = "bf-toggle";
    btn.textContent = "BF";
    btn.addEventListener("click", togglePanel);
    root.appendChild(btn);

    // Panel
    const panel = document.createElement("div");
    panel.id = "bf-panel";
    panel.innerHTML = `
      <div id="bf-header">
        <span class="bf-title">BankFlow</span>
        <button id="bf-close" title="Close">&times;</button>
      </div>
      <div id="bf-content"></div>
    `;
    root.appendChild(panel);

    // Events
    root.querySelector("#bf-close").addEventListener("click", togglePanel);
    panel.addEventListener("click", handleClick);
    panel.addEventListener("input", handleInput);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const action = e.target.dataset.enterAction;
        if (action) handleAction(action);
      }
    });

    // Drag
    let dragging = false, dx = 0, dy = 0;
    const header = root.querySelector("#bf-header");
    header.addEventListener("mousedown", (e) => {
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

  function togglePanel() {
    S.visible = !S.visible;
    const panel = root.querySelector("#bf-panel");
    panel.style.display = S.visible ? "flex" : "none";
    if (S.visible) render();
  }

  // ── CSS ─────────────────────────────────────────────────────────────
  const CSS = `
    :host { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0;
      --muted: #94a3b8; --accent: #3b82f6; --accent-h: #2563eb; --green: #22c55e;
      --red: #ef4444; --radius: 8px; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

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
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: 0 8px 32px rgba(0,0,0,.5); font: 13px var(--font); color: var(--text);
      overflow: hidden;
    }

    #bf-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--border);
      cursor: move; user-select: none;
    }
    .bf-title { font-weight: 700; font-size: 15px; letter-spacing: .3px; }
    #bf-close {
      background: none; border: none; color: var(--muted); font-size: 20px;
      cursor: pointer; padding: 0 4px; line-height: 1;
    }
    #bf-close:hover { color: var(--text); }

    #bf-content { padding: 14px; overflow-y: auto; flex: 1; }

    /* Bank cards */
    .bf-banks { display: flex; gap: 8px; margin-bottom: 14px; }
    .bf-bank-card {
      flex: 1; padding: 10px 12px; border-radius: 6px;
      background: var(--bg); border: 1px solid var(--border);
    }
    .bf-bank-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .bf-bank-name { font-weight: 600; font-size: 14px; }
    .bf-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .bf-dot.on { background: var(--green); }
    .bf-dot.off { background: var(--muted); }
    .bf-bank-timer { font-size: 11px; color: var(--muted); margin-left: 6px; }
    .bf-bank-btn {
      background: none; border: 1px solid var(--border); color: var(--muted);
      padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
      margin-top: 4px;
    }
    .bf-bank-btn:hover { color: var(--text); border-color: var(--text); }
    .bf-bank-btn.connect { border-color: var(--accent); color: var(--accent); }
    .bf-bank-btn.connect:hover { background: var(--accent); color: #fff; }

    /* Accounts table */
    .bf-section-title {
      font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
      color: var(--muted); margin-bottom: 8px; display: flex; align-items: center;
      justify-content: space-between;
    }
    .bf-accounts-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    .bf-accounts-table th {
      text-align: left; font-size: 11px; color: var(--muted); font-weight: 500;
      padding: 4px 0; border-bottom: 1px solid var(--border);
    }
    .bf-accounts-table th:last-child { text-align: right; }
    .bf-accounts-table td { padding: 6px 0; font-size: 13px; }
    .bf-accounts-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .bf-accounts-table tr:not(:last-child) td { border-bottom: 1px solid rgba(51,65,85,.4); }
    .bf-bank-tag {
      display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 5px;
      border-radius: 3px; margin-right: 6px; background: rgba(59,130,246,.15); color: var(--accent);
    }
    .bf-total-row td { border-top: 1px solid var(--border); font-weight: 600; padding-top: 8px; }

    /* Buttons */
    .bf-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 7px 16px; border-radius: 6px; border: none; font: 600 13px var(--font);
      cursor: pointer; transition: background .15s;
    }
    .bf-btn-primary { background: var(--accent); color: #fff; }
    .bf-btn-primary:hover { background: var(--accent-h); }
    .bf-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .bf-btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .bf-btn-secondary:hover { border-color: var(--text); }
    .bf-actions { display: flex; gap: 8px; margin-top: 4px; }

    /* Forms */
    .bf-input {
      width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 5px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: 13px var(--font); outline: none; margin-bottom: 10px;
    }
    .bf-input:focus { border-color: var(--accent); }
    .bf-label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .bf-select {
      width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 5px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: 13px var(--font); outline: none; margin-bottom: 10px; appearance: auto;
    }
    .bf-select:focus { border-color: var(--accent); }

    /* Alerts */
    .bf-alert {
      padding: 8px 12px; border-radius: 5px; font-size: 12px; margin-bottom: 12px;
      display: flex; align-items: center; gap: 8px;
    }
    .bf-alert.error { background: rgba(239,68,68,.12); color: var(--red); }
    .bf-alert.success { background: rgba(34,197,94,.12); color: var(--green); }

    /* Transfer source list */
    .bf-source-item {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: var(--bg); border-radius: 5px; margin-bottom: 6px; cursor: pointer;
    }
    .bf-source-item:hover { outline: 1px solid var(--border); }
    .bf-source-item input[type=checkbox] { accent-color: var(--accent); cursor: pointer; }
    .bf-source-info { flex: 1; }
    .bf-source-name { font-size: 13px; }
    .bf-source-bal { font-size: 11px; color: var(--muted); }
    .bf-source-amount {
      width: 90px; box-sizing: border-box; padding: 4px 8px; border-radius: 4px;
      border: 1px solid var(--border); background: var(--surface); color: var(--text);
      font: 13px var(--font); text-align: right; outline: none;
    }
    .bf-source-amount:focus { border-color: var(--accent); }
    .bf-all-link {
      font-size: 11px; color: var(--accent); cursor: pointer; margin-left: 4px;
      text-decoration: none;
    }
    .bf-all-link:hover { text-decoration: underline; }

    /* MFA options */
    .bf-mfa-option {
      padding: 8px 12px; background: var(--bg); border-radius: 5px;
      margin-bottom: 6px; cursor: pointer; border: 1px solid var(--border);
    }
    .bf-mfa-option:hover { border-color: var(--accent); }
    .bf-mfa-desc { font-size: 13px; }
    .bf-mfa-channel { font-size: 11px; color: var(--muted); }

    /* Loading */
    .bf-loading { text-align: center; padding: 20px; color: var(--muted); }
    .bf-spinner {
      display: inline-block; width: 20px; height: 20px; border: 2px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%;
      animation: bf-spin .6s linear infinite; margin-bottom: 8px;
    }
    @keyframes bf-spin { to { transform: rotate(360deg); } }

    /* Back header */
    .bf-back {
      display: inline-flex; align-items: center; gap: 4px; background: none; border: none;
      color: var(--muted); font: 13px var(--font); cursor: pointer; padding: 0;
      margin-bottom: 12px;
    }
    .bf-back:hover { color: var(--text); }

    /* Transfer results */
    .bf-result-item { padding: 6px 0; font-size: 13px; border-bottom: 1px solid rgba(51,65,85,.3); }
    .bf-result-ok { color: var(--green); }
    .bf-result-fail { color: var(--red); }

    /* Scrollbar */
    #bf-content::-webkit-scrollbar { width: 6px; }
    #bf-content::-webkit-scrollbar-track { background: transparent; }
    #bf-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  `;

  // ── Views ───────────────────────────────────────────────────────────
  function render() {
    const el = root.querySelector("#bf-content");
    if (!el) return;
    el.innerHTML = alertHTML() + viewHTML();
  }

  function alertHTML() {
    let h = "";
    if (S.error) h += `<div class="bf-alert error">${esc(S.error)}</div>`;
    if (S.message) h += `<div class="bf-alert success">${esc(S.message)}</div>`;
    return h;
  }

  function viewHTML() {
    if (S.loading) return `<div class="bf-loading"><div class="bf-spinner"></div><div>Loading...</div></div>`;
    switch (S.view) {
      case "login": return loginView();
      case "mfa": return mfaView();
      case "transfer": return transferView();
      case "results": return resultsView();
      default: return homeView();
    }
  }

  function homeView() {
    const banks = Object.values(BANKS);
    const connected = connectedBanks();

    // Bank cards
    let h = '<div class="bf-banks">';
    for (const bank of banks) {
      const sess = getSession(bank.id);
      const on = !!sess;
      h += `<div class="bf-bank-card">
        <div class="bf-bank-top">
          <span class="bf-bank-name">${bank.name}</span>
          <span><span class="bf-dot ${on ? "on" : "off"}"></span>${
            on ? `<span class="bf-bank-timer" data-timer="${bank.id}">${fmtTime(sess.expiresAt)}</span>` : ""
          }</span>
        </div>
        ${on
          ? `<button class="bf-bank-btn" data-action="disconnect" data-param="${bank.id}">Disconnect</button>`
          : `<button class="bf-bank-btn connect" data-action="show-login" data-param="${bank.id}">Connect</button>`
        }
      </div>`;
    }
    h += "</div>";

    // Accounts
    if (connected.length > 0) {
      if (S.accounts.length === 0) {
        h += `<div class="bf-loading"><div class="bf-spinner"></div><div>Loading accounts...</div></div>`;
        loadAccounts();
        return h;
      }

      h += `<div class="bf-section-title">
        <span>Accounts</span>
        <button class="bf-bank-btn" data-action="refresh">Refresh</button>
      </div>`;
      h += '<table class="bf-accounts-table"><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>';
      let total = 0;
      for (const a of S.accounts) {
        total += a.availableBalance;
        h += `<tr>
          <td><span class="bf-bank-tag">${BANKS[a.bankId].name}</span>${esc(a.nickname)}</td>
          <td>${fmtCurrency(a.availableBalance)}</td>
        </tr>`;
      }
      h += `<tr class="bf-total-row"><td>Total</td><td>${fmtCurrency(total)}</td></tr>`;
      h += "</tbody></table>";

      h += `<div class="bf-actions">
        <button class="bf-btn bf-btn-primary" data-action="show-transfer">Transfer</button>
      </div>`;
    }

    return h;
  }

  function loginView() {
    const bank = BANKS[S.login.bankId];
    return `
      <button class="bf-back" data-action="back">&larr; Back</button>
      <div style="font-weight:600;font-size:15px;margin-bottom:14px">Connect to ${bank.full}</div>
      <label class="bf-label">Username</label>
      <input class="bf-input" id="bf-username" type="text" data-enter-action="do-login" autocomplete="off" />
      <label class="bf-label">Password</label>
      <input class="bf-input" id="bf-password" type="password" data-enter-action="do-login" />
      <button class="bf-btn bf-btn-primary" data-action="do-login" style="width:100%">Log In</button>
    `;
  }

  function mfaView() {
    const bank = BANKS[S.login.bankId];
    const opts = S.login.mfaOptions;

    // If no MFA method selected yet, show options
    if (!S.login.selectedMfa) {
      let h = `
        <button class="bf-back" data-action="back">&larr; Back</button>
        <div style="font-weight:600;font-size:15px;margin-bottom:4px">Verify Your Identity</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px">${bank.full}</div>
      `;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        h += `<div class="bf-mfa-option" data-action="select-mfa" data-param="${i}">
          <div class="bf-mfa-desc">${esc(o.description || o.channel)}</div>
          <div class="bf-mfa-channel">${esc(o.channel)}</div>
        </div>`;
      }
      return h;
    }

    // MFA method selected — show OTP input or push polling
    const mfa = S.login.selectedMfa;
    if (mfa.channel === "PUSH") {
      return `
        <button class="bf-back" data-action="cancel-mfa">&larr; Cancel</button>
        <div style="font-weight:600;font-size:15px;margin-bottom:4px">Push Notification</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
          Check your phone and approve the login request
        </div>
        <div class="bf-loading"><div class="bf-spinner"></div><div>Waiting for approval...</div></div>
      `;
    }

    return `
      <button class="bf-back" data-action="cancel-mfa">&larr; Cancel</button>
      <div style="font-weight:600;font-size:15px;margin-bottom:4px">Enter Verification Code</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
        Sent via ${esc(mfa.channel)} to ${esc(mfa.description || "")}
      </div>
      <input class="bf-input" id="bf-otp" type="text" placeholder="123456"
        data-enter-action="do-validate-otp" autocomplete="one-time-code"
        inputmode="numeric" maxlength="6" />
      <button class="bf-btn bf-btn-primary" data-action="do-validate-otp" style="width:100%">Verify</button>
    `;
  }

  function transferView() {
    const connected = connectedBanks();
    if (connected.length === 0) {
      S.view = "home";
      return homeView();
    }

    const selectedBank = S.transfer.bankId || connected[0];
    const bankAccounts = S.accounts.filter((a) => a.bankId === selectedBank);

    let h = `<button class="bf-back" data-action="back">&larr; Back</button>`;

    // Bank selector
    if (connected.length > 1) {
      h += `<label class="bf-label">Bank</label><select class="bf-select" id="bf-transfer-bank" data-input="transfer-bank">`;
      for (const bId of connected) {
        h += `<option value="${bId}" ${bId === selectedBank ? "selected" : ""}>${BANKS[bId].name}</option>`;
      }
      h += `</select>`;
    }

    // Source accounts
    h += `<div class="bf-label" style="margin-bottom:8px">From</div>`;
    for (const a of bankAccounts) {
      const checked = S.transfer.sources.has(a.id);
      const amount = S.transfer.amounts[a.id] ?? a.availableBalance;
      h += `<div class="bf-source-item">
        <input type="checkbox" data-action="toggle-source" data-param="${a.id}" ${checked ? "checked" : ""} />
        <div class="bf-source-info">
          <div class="bf-source-name">${esc(a.nickname)}</div>
          <div class="bf-source-bal">${fmtCurrency(a.availableBalance)}</div>
        </div>
        ${checked ? `
          <input type="number" class="bf-source-amount" data-input="amount" data-account="${a.id}"
            value="${amount}" min="0.01" max="${a.availableBalance}" step="0.01" />
          ${amount < a.availableBalance
            ? `<span class="bf-all-link" data-action="set-all" data-param="${a.id}">all</span>`
            : ""
          }
        ` : ""}
      </div>`;
    }

    // Target account
    const targetOptions = bankAccounts.filter((a) => !S.transfer.sources.has(a.id));
    h += `<label class="bf-label" style="margin-top:6px">To</label>
      <select class="bf-select" id="bf-transfer-target" data-input="transfer-target">
        <option value="">Select account</option>`;
    for (const a of targetOptions) {
      h += `<option value="${a.id}" ${a.id === S.transfer.targetId ? "selected" : ""}>${esc(a.nickname)} (${fmtCurrency(a.availableBalance)})</option>`;
    }
    h += `</select>`;

    // Total
    let total = 0;
    S.transfer.sources.forEach((id) => {
      total += S.transfer.amounts[id] ?? S.accounts.find((a) => a.id === id)?.availableBalance ?? 0;
    });
    if (S.transfer.sources.size > 0) {
      h += `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">
        Total: <strong style="color:var(--text)">${fmtCurrency(total)}</strong>
      </div>`;
    }

    const canExecute = S.transfer.sources.size > 0 && S.transfer.targetId;
    h += `<button class="bf-btn bf-btn-primary" data-action="do-transfer" style="width:100%"
      ${canExecute ? "" : "disabled"}>Execute Transfer</button>`;

    return h;
  }

  function resultsView() {
    let h = `
      <button class="bf-back" data-action="back">&larr; Done</button>
      <div style="font-weight:600;font-size:15px;margin-bottom:12px">Transfer Results</div>
    `;
    for (const r of S.transferResults || []) {
      const cls = r.success ? "bf-result-ok" : "bf-result-fail";
      const icon = r.success ? "&#10003;" : "&#10007;";
      h += `<div class="bf-result-item">
        <span class="${cls}">${icon}</span>
        ${esc(r.fromName)} &rarr; ${esc(r.toName)}: ${fmtCurrency(r.amount)}
        ${r.error ? `<div style="font-size:11px;color:var(--red)">${esc(r.error)}</div>` : ""}
      </div>`;
    }
    h += `<div class="bf-actions" style="margin-top:14px">
      <button class="bf-btn bf-btn-primary" data-action="back">Done</button>
    </div>`;
    return h;
  }

  // ── Event Handlers ──────────────────────────────────────────────────
  function handleClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    handleAction(el.dataset.action, el.dataset.param);
  }

  function handleInput(e) {
    const el = e.target;
    if (el.dataset.input === "amount") {
      const id = el.dataset.account;
      const max = S.accounts.find((a) => a.id === id)?.availableBalance ?? Infinity;
      S.transfer.amounts[id] = Math.min(parseFloat(el.value) || 0, max);
    }
    if (el.dataset.input === "transfer-bank") {
      S.transfer.bankId = el.value;
      S.transfer.sources.clear();
      S.transfer.amounts = {};
      S.transfer.targetId = "";
      render();
    }
    if (el.dataset.input === "transfer-target") {
      S.transfer.targetId = el.value;
    }
  }

  async function handleAction(action, param) {
    S.error = null;
    S.message = null;

    try {
      switch (action) {
        case "show-login":
          S.login.bankId = param;
          S.login.mfaOptions = [];
          S.login.selectedMfa = null;
          S.login.credentials = null;
          S.view = "login";
          render();
          break;

        case "do-login": {
          const u = root.querySelector("#bf-username")?.value?.trim();
          const p = root.querySelector("#bf-password")?.value;
          if (!u || !p) { S.error = "Enter username and password"; render(); return; }
          S.loading = true; render();
          const res = await doLogin(S.login.bankId, u, p);
          S.loading = false;
          if (res.success) {
            S.view = "home";
            S.accounts = [];
            S.message = `Connected to ${BANKS[S.login.bankId].name}`;
          } else if (res.mfaRequired) {
            S.login.mfaOptions = res.mfaOptions;
            S.login.credentials = res.credentials;
            S.login.deviceId = res.deviceId;
            S.login.selectedMfa = null;
            S.view = "mfa";
            // Auto-select if only one option
            if (res.mfaOptions.length === 1) {
              await handleAction("select-mfa", "0");
              return;
            }
          }
          render();
          break;
        }

        case "select-mfa": {
          const idx = parseInt(param);
          const mfa = S.login.mfaOptions[idx];
          S.login.selectedMfa = mfa;
          S.login.contactType = mfa.contactType;

          if (mfa.channel === "PUSH") {
            render();
            startPushPoll();
          } else {
            S.loading = true; render();
            await doSendOtp(S.login.bankId, mfa.contactType, mfa.channel);
            S.loading = false;
            render();
          }
          break;
        }

        case "do-validate-otp": {
          const otp = root.querySelector("#bf-otp")?.value?.trim();
          if (!otp) { S.error = "Enter the code"; render(); return; }
          S.loading = true; render();
          const res = await doValidateOtp(S.login.bankId, otp, S.login.contactType, S.login.credentials);
          S.loading = false;
          if (res.success) {
            S.view = "home";
            S.accounts = [];
            S.message = `Connected to ${BANKS[S.login.bankId].name}`;
          }
          render();
          break;
        }

        case "cancel-mfa":
          stopPushPoll();
          S.login.selectedMfa = null;
          if (S.login.mfaOptions.length > 1) {
            render();
          } else {
            S.view = "login";
            render();
          }
          break;

        case "disconnect":
          delete S.sessions[param];
          S.accounts = S.accounts.filter((a) => a.bankId !== param);
          render();
          break;

        case "refresh":
          S.accounts = [];
          render();
          break;

        case "show-transfer":
          S.transfer.bankId = connectedBanks()[0] || null;
          S.transfer.sources.clear();
          S.transfer.amounts = {};
          S.transfer.targetId = "";
          S.view = "transfer";
          render();
          break;

        case "toggle-source": {
          // Save current amount inputs before re-render
          root.querySelectorAll(".bf-source-amount").forEach((el) => {
            S.transfer.amounts[el.dataset.account] = parseFloat(el.value) || 0;
          });
          if (S.transfer.sources.has(param)) {
            S.transfer.sources.delete(param);
            delete S.transfer.amounts[param];
          } else {
            S.transfer.sources.add(param);
            const acct = S.accounts.find((a) => a.id === param);
            if (acct) S.transfer.amounts[param] = acct.availableBalance;
          }
          // If target is now a source, clear it
          if (S.transfer.sources.has(S.transfer.targetId)) S.transfer.targetId = "";
          // Read target before re-render
          const tgt = root.querySelector("#bf-transfer-target");
          if (tgt) S.transfer.targetId = tgt.value;
          render();
          break;
        }

        case "set-all": {
          const acct = S.accounts.find((a) => a.id === param);
          if (acct) S.transfer.amounts[param] = acct.availableBalance;
          render();
          break;
        }

        case "do-transfer": {
          const tgt = root.querySelector("#bf-transfer-target");
          if (tgt) S.transfer.targetId = tgt.value;
          if (!S.transfer.targetId || S.transfer.sources.size === 0) {
            S.error = "Select source and target accounts";
            render();
            return;
          }
          // Read final amounts from DOM
          root.querySelectorAll(".bf-source-amount").forEach((el) => {
            S.transfer.amounts[el.dataset.account] = parseFloat(el.value) || 0;
          });
          const targetAcct = S.accounts.find((a) => a.id === S.transfer.targetId);
          S.loading = true; render();
          const results = [];
          for (const srcId of S.transfer.sources) {
            const src = S.accounts.find((a) => a.id === srcId);
            const amount = S.transfer.amounts[srcId] || 0;
            if (amount <= 0) continue;
            try {
              const r = await execTransfer(
                S.transfer.bankId || src.bankId,
                srcId, S.transfer.targetId, amount,
                src?.description || src?.nickname || "",
                targetAcct?.description || targetAcct?.nickname || ""
              );
              results.push({
                fromName: src?.nickname || srcId,
                toName: targetAcct?.nickname || S.transfer.targetId,
                amount, success: r.success, error: r.success ? null : "Transfer failed",
              });
            } catch (err) {
              results.push({
                fromName: src?.nickname || srcId,
                toName: targetAcct?.nickname || S.transfer.targetId,
                amount, success: false, error: err.message,
              });
            }
          }
          S.loading = false;
          S.transferResults = results;
          S.view = "results";
          S.accounts = []; // Force refresh on next home view
          render();
          break;
        }

        case "back":
          stopPushPoll();
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

  // ── Push Polling ────────────────────────────────────────────────────
  function startPushPoll() {
    stopPushPoll();
    let attempts = 0;
    S.pushTimer = setInterval(async () => {
      attempts++;
      if (attempts > 20) { // ~60 seconds
        stopPushPoll();
        S.error = "Push approval timed out";
        S.login.selectedMfa = null;
        render();
        return;
      }
      try {
        const res = await doPollPush(S.login.bankId, S.login.credentials);
        if (res.success) {
          stopPushPoll();
          S.view = "home";
          S.accounts = [];
          S.message = `Connected to ${BANKS[S.login.bankId].name}`;
          render();
        }
      } catch {
        // Ignore poll errors, keep trying
      }
    }, 3000);
  }

  function stopPushPoll() {
    if (S.pushTimer) {
      clearInterval(S.pushTimer);
      S.pushTimer = null;
    }
  }

  // ── Account Loading ─────────────────────────────────────────────────
  let accountsLoading = false;
  async function loadAccounts() {
    if (accountsLoading) return;
    accountsLoading = true;
    try {
      S.accounts = await fetchAllAccounts();
    } catch (e) {
      S.error = `Failed to load accounts: ${e.message}`;
    }
    accountsLoading = false;
    render();
  }

  // ── Timer ───────────────────────────────────────────────────────────
  function startTimerUpdates() {
    setInterval(() => {
      if (!S.visible) return;
      // Update timer displays
      Object.keys(BANKS).forEach((bankId) => {
        const sess = S.sessions[bankId];
        const el = root.querySelector(`[data-timer="${bankId}"]`);
        if (!el) return;
        if (sess) {
          const left = Math.max(0, Math.floor((sess.expiresAt - Date.now()) / 1000));
          if (left <= 0) {
            delete S.sessions[bankId];
            S.accounts = S.accounts.filter((a) => a.bankId !== bankId);
            render();
          } else {
            el.textContent = fmtTime(sess.expiresAt);
          }
        }
      });
    }, 1000);
  }

  // ── Init ────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById("bankflow-host")) return;
    createUI();
    startTimerUpdates();
    GM_registerMenuCommand("Toggle BankFlow", togglePanel);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
