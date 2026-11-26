(() => {
  "use strict";

  const BACKUP_VERSION = 2;
  const STORAGE_KEY = "edgevault.data.v1";
  const ACCOUNT_MODES = ["Backtest", "Demo", "Eval", "Funded"];
  const DEFAULT_STRATEGIES = [
    "FVG Pullback",
    "Breakout Retest",
    "Liquidity Sweep",
    "Trend Continuation",
    "Supply/Demand Flip"
  ];
  const PAGE_TITLES = {
    overview: "Overview",
    "trade-journal": "Trade journal",
    "strategy-library": "Strategies",
    "prop-rules": "Prop rules & risk"
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const API_BASE = String(window.EDGEVAULT_API_BASE || "").replace(/\/+$/, "");
  const els = {
    netPnl: $("#netPnl"), winRate: $("#winRate"), winCount: $("#winCount"),
    expectancy: $("#expectancy"), profitFactor: $("#profitFactor"),
    maxLossStreak: $("#maxLossStreak"), maxDrawdown: $("#maxDrawdown"),
    strategyList: $("#strategyList"), rows: $("#tradeRows"), empty: $("#tradeEmpty"),
    noResults: $("#noResults"), countLabel: $("#tradeCountLabel"),
    fullRows: $("#fullTradeRows"), fullEmpty: $("#fullTradeEmpty"),
    fullNoResults: $("#fullNoResults"), fullCount: $("#fullTradeCount"),
    tradeModal: $("#tradeModal"), tradeForm: $("#tradeForm"),
    modalTitle: $("#modalTitle"), formError: $("#formError"),
    strategySelect: $("#strategySelect"), chart: $("#performanceChart"),
    chartEmpty: $("#chartEmpty"), chartTotal: $("#chartTotal"),
    toast: $("#toast"),
    authScreen: $("#authScreen"),
    appShell: $("#appShell"),
    authMessage: $("#authMessage"),
    authConnectionNote: $("#authConnectionNote"),
    signInForm: $("#signInForm"),
    signUpForm: $("#signUpForm"),
    syncStatus: $("#syncStatus"),
    syncStatusText: $("#syncStatusText")
  };

  let localDraftState = loadState();
  let state = defaultState();
  let currentUser = null;
  let cloudSaveQueue = Promise.resolve();
  let syncRevision = 0;
  let editingId = null;
  let toastTimer;

  function defaultAccountRules() {
    return {
      startingBalance: 50000,
      dailyLossPercent: 5,
      maxDrawdownPercent: 10,
      profitTargetPercent: 8
    };
  }

  function defaultState() {
    return {
      version: BACKUP_VERSION,
      strategies: [...DEFAULT_STRATEGIES],
      trades: [],
      accountRules: Object.fromEntries(ACCOUNT_MODES.map(mode => [mode, defaultAccountRules()]))
    };
  }

  function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.strategies) || !Array.isArray(raw.trades)) {
      throw new Error("The backup must contain strategies and trades arrays.");
    }
    const defaults = defaultState();
    const strategies = [...new Set(raw.strategies.filter(item => typeof item === "string")
      .map(item => item.trim()).filter(Boolean))];
    if (strategies.length === 0) strategies.push(...DEFAULT_STRATEGIES);

    const accountRules = {};
    ACCOUNT_MODES.forEach(mode => {
      const saved = raw.accountRules?.[mode] || {};
      accountRules[mode] = {
        startingBalance: numberOrNull(saved.startingBalance) ?? defaults.accountRules[mode].startingBalance,
        dailyLossPercent: numberOrNull(saved.dailyLossPercent) ?? defaults.accountRules[mode].dailyLossPercent,
        maxDrawdownPercent: numberOrNull(saved.maxDrawdownPercent) ?? defaults.accountRules[mode].maxDrawdownPercent,
        profitTargetPercent: numberOrNull(saved.profitTargetPercent) ?? defaults.accountRules[mode].profitTargetPercent
      };
    });

    const trades = raw.trades.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Trade ${index + 1} is not valid.`);
      const symbol = String(item.symbol ?? item.instrument ?? item.asset ?? "").trim().slice(0, 30);
      const date = String(item.date ?? "").slice(0, 10);
      const entry = numberOrNull(item.entry);
      const exit = numberOrNull(item.exit);
      const side = item.side === "Short" || item.direction === "Short" ? "Short" : "Long";
      const mode = ACCOUNT_MODES.includes(item.mode) ? item.mode : "Backtest";
      if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date) || entry === null || entry < 0 ||
          (exit !== null && exit < 0)) {
        throw new Error(`Trade ${index + 1} has missing or invalid instrument, date, entry, or exit values.`);
      }

      const strategy = String(item.strategy ?? item.setup ?? strategies[0] ?? "").trim();
      if (strategy && !strategies.includes(strategy)) strategies.push(strategy);
      const riskPercent = numberOrNull(item.riskPercent) ?? 0.5;
      const rules = accountRules[mode];
      let riskDollar = numberOrNull(item.riskDollar);
      if (riskDollar === null) riskDollar = rules.startingBalance * riskPercent / 100;

      let pnlOverride = numberOrNull(item.pnlOverride ?? item.netPnl);
      if (pnlOverride === null && exit !== null && numberOrNull(item.quantity) !== null) {
        const quantity = Number(item.quantity);
        const fees = numberOrNull(item.fees) ?? 0;
        pnlOverride = (exit - Number(item.entry)) * quantity * (side === "Short" ? -1 : 1) - fees;
      }

      return {
        id: String(item.id || makeId()),
        tradeId: String(item.tradeId || `EV-${String(index + 1).padStart(5, "0")}`),
        date,
        mode,
        account: String(item.account ?? "").slice(0, 50),
        symbol,
        session: String(item.session ?? "").slice(0, 50),
        side,
        strategy,
        entry: Number(item.entry),
        stopLoss: numberOrNull(item.stopLoss ?? item.sl),
        takeProfit: numberOrNull(item.takeProfit ?? item.tp),
        exit,
        exitTime: String(item.exitTime ?? ""),
        riskPercent,
        riskDollar,
        pnlOverride,
        chartBefore: String(item.chartBefore ?? item.beforeChart ?? "").slice(0, 500),
        chartAfter: String(item.chartAfter ?? item.afterChart ?? "").slice(0, 500),
        planAdherence: String(item.planAdherence ?? "").slice(0, 30),
        mistakeTag: String(item.mistakeTag ?? "").slice(0, 50),
        notes: String(item.notes ?? "").slice(0, 2000)
      };
    });
    return { version: BACKUP_VERSION, strategies, trades, accountRules };
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? normalizeState(JSON.parse(saved)) : defaultState();
    } catch (error) {
      console.error("Could not load EdgeVault data:", error);
      return defaultState();
    }
  }

  function persist(nextState) {
    try {
      const normalized = normalizeState(nextState);
      state = normalized;
      render();
      syncJournalToCloud(normalized).then(synced => {
        if (!synced) showToast("Cloud save failed. Your changes remain on this screen; click the sync status to retry.");
      });
      return true;
    } catch (error) {
      console.error("Could not save EdgeVault data:", error);
      showToast(`Could not save data: ${error.message}`);
      return false;
    }
  }

  function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const request = { ...options, credentials: "include", headers };
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(options.body);
    }
    return fetch(`${API_BASE}/api${path}`, request).then(async response => {
      let payload = {};
      try { payload = await response.json(); } catch { /* An empty body is handled as an API error below. */ }
      if (!response.ok) {
        const error = new Error(payload.error || `Request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return payload;
    }).catch(error => {
      if (error instanceof TypeError) {
        throw new Error("Cannot reach the EdgeVault API. Confirm the server is running and EDGEVAULT_API_BASE is configured.");
      }
      throw error;
    });
  }

  function setSyncStatus(status, label) {
    els.syncStatus.classList.toggle("error", status === "error");
    els.syncStatus.classList.toggle("syncing", status === "syncing");
    els.syncStatusText.textContent = label;
    els.syncStatus.title = status === "error" ? "Cloud sync failed. Click to retry." : "Click to sync your journal now.";
  }

  function syncJournalToCloud(snapshot) {
    if (!currentUser) return Promise.resolve(false);
    const userId = currentUser.id;
    const revision = ++syncRevision;
    setSyncStatus("syncing", "Syncing…");
    const operation = cloudSaveQueue.catch(() => {}).then(() => {
      if (!currentUser || currentUser.id !== userId) throw new Error("The signed-in account changed before this save.");
      return apiRequest("/journal", { method: "PUT", body: { journal: snapshot } });
    });
    cloudSaveQueue = operation;
    return operation.then(() => {
      if (revision === syncRevision) setSyncStatus("synced", "Synced");
      return true;
    }).catch(error => {
      console.error("Could not sync EdgeVault journal:", error);
      if (revision === syncRevision) setSyncStatus("error", "Sync error");
      return false;
    });
  }

  function setAuthMessage(message, isError = false) {
    els.authMessage.textContent = message;
    els.authMessage.classList.toggle("error", isError);
  }

  function setAuthTab(signUp) {
    $("#signInTab").classList.toggle("active", !signUp);
    $("#signInTab").setAttribute("aria-selected", String(!signUp));
    $("#signUpTab").classList.toggle("active", signUp);
    $("#signUpTab").setAttribute("aria-selected", String(signUp));
    els.signInForm.hidden = signUp;
    els.signUpForm.hidden = !signUp;
    $("#authHeading").innerHTML = signUp ? 'Create account<span class="heading-dot">.</span>' : 'Sign in<span class="heading-dot">.</span>';
    els.authConnectionNote.textContent = signUp
      ? "Create your account to start a private, cloud-synced journal."
      : "Sign in to load your cloud journal.";
    setAuthMessage("");
  }

  function hasLocalDraft() {
    const defaults = defaultState();
    return localDraftState.trades.length > 0 ||
      JSON.stringify(localDraftState.strategies) !== JSON.stringify(defaults.strategies) ||
      JSON.stringify(localDraftState.accountRules) !== JSON.stringify(defaults.accountRules);
  }

  async function enterWorkspace(user) {
    currentUser = user;
    const response = await apiRequest("/journal");
    if (response.journal) {
      state = normalizeState(response.journal);
    } else {
      const migrate = hasLocalDraft() && window.confirm(
        "A journal already exists on this device. Would you like to upload it to this account? The local journal will be removed from this browser only after the upload succeeds."
      );
      state = migrate ? normalizeState(localDraftState) : defaultState();
      const saved = await syncJournalToCloud(state);
      if (!saved) throw new Error("Your account is signed in, but the initial journal could not be saved. Check the API connection and retry.");
      if (migrate) {
        try {
          localStorage.removeItem(STORAGE_KEY);
          localDraftState = defaultState();
        } catch (error) {
          console.error("Could not remove the migrated local journal:", error);
        }
      }
    }

    $("#accountEmail").textContent = user.email;
    $("#sidebarUserEmail").textContent = user.email;
    $(".avatar").textContent = user.email.slice(0, 2).toUpperCase();
    setSyncStatus("synced", "Synced");
    els.signInForm.reset();
    els.signUpForm.reset();
    els.authScreen.hidden = true;
    els.appShell.hidden = false;
    setAuthMessage("");
    render();
    navigate(location.hash.slice(1) || "overview", false);
  }

  async function checkSession() {
    try {
      const response = await apiRequest("/auth/me");
      if (response.user) {
        await enterWorkspace(response.user);
      } else {
        els.authConnectionNote.textContent = "API connected. Sign in or create an account to continue.";
      }
    } catch (error) {
      if (error.status === 401) {
        els.authConnectionNote.textContent = "API connected. Sign in or create an account to continue.";
      } else {
        els.authConnectionNote.textContent = error.message;
      }
    }
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `trade-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function nextTradeCode() {
    const largest = state.trades.reduce((max, trade) => {
      const match = /^EV-(\d+)$/.exec(trade.tradeId);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `EV-${String(largest + 1).padStart(5, "0")}`;
  }

  function localDateString(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function getRiskDollar(trade) {
    if (Number.isFinite(trade.riskDollar)) return trade.riskDollar;
    const rules = state.accountRules[trade.mode] || defaultAccountRules();
    return rules.startingBalance * trade.riskPercent / 100;
  }

  function priceR(trade) {
    if (trade.exit === null || trade.stopLoss === null || trade.stopLoss === trade.entry) return null;
    const distance = Math.abs(trade.entry - trade.stopLoss);
    return (trade.exit - trade.entry) * (trade.side === "Short" ? -1 : 1) / distance;
  }

  function tradePnl(trade) {
    if (trade.exit === null) return null;
    if (trade.pnlOverride !== null && Number.isFinite(trade.pnlOverride)) return trade.pnlOverride;
    const r = priceR(trade);
    const risk = getRiskDollar(trade);
    return r === null || risk <= 0 ? null : r * risk;
  }

  function actualR(trade) {
    const result = tradePnl(trade);
    const risk = getRiskDollar(trade);
    return result === null || risk <= 0 ? null : result / risk;
  }

  function plannedRR(trade) {
    if (trade.stopLoss === null || trade.takeProfit === null || trade.entry === trade.stopLoss) return null;
    return Math.abs(trade.takeProfit - trade.entry) / Math.abs(trade.entry - trade.stopLoss);
  }

  function outcome(trade) {
    if (trade.exit === null) return "Open";
    const result = tradePnl(trade);
    if (result === null) return "—";
    return result > 0 ? "Win" : result < 0 ? "Loss" : "BE";
  }

  function accountLabel(trade) {
    return trade.account ? `${trade.mode} — ${trade.account}` : trade.mode;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(value);
  }

  function formatPrice(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(`${value.slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric"
    }).format(date);
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function render() {
    renderDashboardFilters();
    renderStats();
    renderStrategies();
    renderTrades();
    renderChart();
    renderStrategySelect();
    renderStrategyLibrary();
    renderProp();
  }

  function renderDashboardFilters() {
    setSelectOptions($("#dashboardStrategy"), "All strategies", state.strategies, $("#dashboardStrategy").value);
    const sessions = [...new Set(state.trades.map(trade => trade.session).filter(Boolean))].sort();
    setSelectOptions($("#dashboardSession"), "All sessions", sessions, $("#dashboardSession").value);
    setSelectOptions($("#journalSessionFilter"), "All sessions", sessions, $("#journalSessionFilter").value);
  }

  function setSelectOptions(select, allLabel, options, previous) {
    if (!select) return;
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = allLabel;
    select.append(all);
    options.forEach(value => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
    select.value = options.includes(previous) || previous === "all" ? previous : "all";
  }

  function getDashboardTrades() {
    const mode = $("#dashboardMode").value;
    const strategy = $("#dashboardStrategy").value;
    const session = $("#dashboardSession").value;
    const month = $("#dashboardMonth").value;
    return state.trades.filter(trade =>
      (mode === "all" || trade.mode === mode) &&
      (strategy === "all" || trade.strategy === strategy) &&
      (session === "all" || trade.session === session) &&
      (!month || trade.date.startsWith(month))
    );
  }

  function renderStats() {
    const trades = getDashboardTrades();
    const closed = trades.filter(trade => trade.exit !== null && tradePnl(trade) !== null)
      .sort((a, b) => a.date.localeCompare(b.date) || a.tradeId.localeCompare(b.tradeId));
    const values = closed.map(tradePnl);
    const wins = values.filter(value => value > 0);
    const losses = values.filter(value => value < 0);
    const net = values.reduce((sum, value) => sum + value, 0);
    const netElement = els.netPnl;
    netElement.textContent = formatMoney(net);
    netElement.classList.toggle("positive", net > 0);
    netElement.classList.toggle("negative", net < 0);
    els.winRate.innerHTML = `${closed.length ? Math.round(wins.length / closed.length * 100) : "—"}<small>%</small>`;
    els.winCount.textContent = `${closed.length} closed · ${wins.length} wins · ${losses.length} losses`;

    const rValues = closed.map(actualR).filter(value => value !== null);
    const avgR = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null;
    $("#expectancy").textContent = avgR === null ? "—" : `${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R`;
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    $("#profitFactor").textContent = grossLosses ? (grossWins / grossLosses).toFixed(2) : grossWins ? "∞" : "—";

    let streak = 0, maxStreak = 0, equity = 0, peak = 0, drawdown = 0;
    closed.forEach(trade => {
      const value = tradePnl(trade);
      if (value < 0) { streak += 1; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
      equity += value;
      peak = Math.max(peak, equity);
      drawdown = Math.max(drawdown, peak - equity);
    });
    $("#maxLossStreak").textContent = String(maxStreak);
    $("#maxDrawdown").textContent = formatMoney(drawdown);
    renderBreakdowns(trades);
  }

  function renderBreakdowns(trades) {
    const groups = [
      { body: $("#strategyBreakdown"), values: state.strategies, key: trade => trade.strategy },
      { body: $("#sessionBreakdown"), values: [...new Set(trades.map(trade => trade.session).filter(Boolean))].sort(), key: trade => trade.session },
      { body: $("#modeBreakdown"), values: ACCOUNT_MODES, key: trade => trade.mode }
    ];
    groups.forEach(({ body, values, key }) => {
      body.replaceChildren();
      const groupsWithTrades = values.map(name => ({
        name,
        trades: trades.filter(trade => key(trade) === name && tradePnl(trade) !== null)
      })).filter(group => group.trades.length);
      if (!groupsWithTrades.length) {
        const row = document.createElement("tr");
        const cell = makeElement("td", "table-empty-cell", "No closed trades");
        cell.colSpan = 4;
        row.append(cell);
        body.append(row);
        return;
      }
      groupsWithTrades.forEach(group => {
        const results = group.trades.map(tradePnl);
        const avg = group.trades.map(actualR).filter(value => value !== null);
        const row = document.createElement("tr");
        row.append(makeElement("td", "", group.name));
        row.append(makeElement("td", "", String(group.trades.length)));
        row.append(makeElement("td", "", avg.length ? `${avg.reduce((sum, value) => sum + value, 0) / avg.length >= 0 ? "+" : ""}${(avg.reduce((sum, value) => sum + value, 0) / avg.length).toFixed(2)}R` : "—"));
        const total = results.reduce((sum, value) => sum + value, 0);
        row.append(makeElement("td", total > 0 ? "pnl-positive" : total < 0 ? "pnl-negative" : "", formatMoney(total)));
        body.append(row);
      });
    });
  }

  function renderStrategies() {
    els.strategyList.replaceChildren();
    const counts = state.strategies.map(name => {
      const trades = state.trades.filter(trade => trade.strategy === name && tradePnl(trade) !== null);
      return { name, count: trades.length, total: trades.reduce((sum, trade) => sum + tradePnl(trade), 0) };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const max = Math.max(1, ...counts.map(item => Math.abs(item.total)));
    if (!counts.length) {
      els.strategyList.append(makeElement("div", "strategy-none", "No strategies yet. Add one to organize your trades."));
      return;
    }
    counts.forEach(item => {
      const row = makeElement("div", "strategy-row");
      const name = makeElement("span", "strategy-name", item.name);
      name.title = item.name;
      const stats = makeElement("span", "strategy-stats");
      stats.append(makeElement("span", "", `${item.count} ${item.count === 1 ? "trade" : "trades"}`));
      stats.append(makeElement("strong", item.total > 0 ? "pnl-positive" : item.total < 0 ? "pnl-negative" : "", item.count ? formatMoney(item.total) : "—"));
      const track = makeElement("div", "strategy-track");
      const bar = makeElement("span", item.total < 0 ? "loss" : "");
      bar.style.width = `${item.count ? Math.max(5, Math.abs(item.total) / max * 100) : 0}%`;
      track.append(bar);
      row.append(name, stats, track);
      els.strategyList.append(row);
    });
  }

  function rowForTrade(trade, full = false) {
    const row = document.createElement("tr");
    if (full) {
      const rr = plannedRR(trade);
      const r = actualR(trade);
      const pnl = tradePnl(trade);
      const cells = [
        trade.tradeId, formatDate(trade.date), accountLabel(trade), trade.symbol, trade.session || "—",
        trade.side, trade.strategy, formatPrice(trade.entry), formatPrice(trade.stopLoss),
        formatPrice(trade.takeProfit), formatPrice(trade.exit), trade.exitTime || "—",
        `${trade.riskPercent}%`, formatMoney(getRiskDollar(trade)),
        rr === null ? "—" : `${rr.toFixed(2)}R`,
        r === null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`,
        pnl === null ? "—" : formatMoney(pnl), outcome(trade)
      ];
      cells.forEach((value, index) => {
        const cell = makeElement("td", "", String(value));
        if (index === 16 && pnl !== null) cell.classList.add(pnl >= 0 ? "pnl-positive" : "pnl-negative");
        if (index === 17) cell.classList.add(`outcome-${outcome(trade).toLowerCase().replace(/[^a-z]/g, "")}`);
        row.append(cell);
      });
      row.append(makeLinkCell(trade.chartBefore));
      row.append(makeLinkCell(trade.chartAfter));
      row.append(makeElement("td", "", trade.planAdherence || "—"));
      row.append(makeElement("td", "", trade.mistakeTag || "—"));
      const notes = makeElement("td", "notes-cell", trade.notes || "—");
      notes.title = trade.notes || "";
      row.append(notes);
      row.append(createActionsCell(trade));
      return row;
    }

    const asset = document.createElement("td");
    const assetWrap = makeElement("div", "asset-cell");
    const badge = makeElement("span", "asset-symbol", trade.symbol.slice(0, 3).toUpperCase());
    const assetInfo = document.createElement("span");
    assetInfo.append(makeElement("span", "asset-main", trade.symbol.toUpperCase()));
    assetInfo.append(makeElement("span", "asset-sub", `${trade.mode} · ${outcome(trade)}`));
    assetWrap.append(badge, assetInfo);
    asset.append(assetWrap);
    const pnl = tradePnl(trade);
    const fields = [
      asset,
      makeElement("td", "", formatDate(trade.date)),
      makeElement("td", "", trade.side),
      makeElement("td", "strategy-cell", trade.strategy),
      makeElement("td", "price-cell", `${formatPrice(trade.entry)} → ${formatPrice(trade.exit)}`),
      makeElement("td", pnl === null ? "pnl-open" : pnl >= 0 ? "pnl-positive" : "pnl-negative", pnl === null ? "Open" : formatMoney(pnl))
    ];
    fields.forEach(cell => row.append(cell));
    row.append(createActionsCell(trade));
    return row;
  }

  function makeLinkCell(value) {
    const cell = document.createElement("td");
    if (!value) { cell.textContent = "—"; return cell; }
    let url;
    try { url = new URL(value); } catch { cell.textContent = "Invalid link"; return cell; }
    if (!["http:", "https:"].includes(url.protocol)) { cell.textContent = "Invalid link"; return cell; }
    const link = makeElement("a", "chart-link", "Open");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = value;
    cell.append(link);
    return cell;
  }

  function createActionsCell(trade) {
    const cell = document.createElement("td");
    const actionWrap = makeElement("div", "row-actions");
    const edit = makeElement("button", "row-action", "✎");
    edit.type = "button";
    edit.title = "Edit trade";
    edit.setAttribute("aria-label", `Edit ${trade.symbol} trade`);
    edit.addEventListener("click", () => openTradeModal(trade));
    const remove = makeElement("button", "row-action delete", "×");
    remove.type = "button";
    remove.title = "Delete trade";
    remove.setAttribute("aria-label", `Delete ${trade.symbol} trade`);
    remove.addEventListener("click", () => deleteTrade(trade.id));
    actionWrap.append(edit, remove);
    cell.append(actionWrap);
    return cell;
  }

  function renderTrades() {
    const search = $("#searchInput").value.trim().toLowerCase();
    const side = $("#sideFilter").value;
    const recent = [...state.trades].sort((a, b) => b.date.localeCompare(a.date))
      .filter(trade => (!search || `${trade.symbol} ${trade.strategy} ${trade.notes}`.toLowerCase().includes(search))
        && (side === "all" || trade.side === side)).slice(0, 8);
    els.rows.replaceChildren();
    recent.forEach(trade => els.rows.append(rowForTrade(trade)));
    els.empty.hidden = state.trades.length > 0;
    els.noResults.hidden = state.trades.length === 0 || recent.length > 0;
    els.countLabel.textContent = `Showing ${recent.length} of ${state.trades.length} trades`;

    const journalSearch = $("#journalSearch").value.trim().toLowerCase();
    const journalMode = $("#journalModeFilter").value;
    const journalSession = $("#journalSessionFilter").value;
    const filtered = [...state.trades].sort((a, b) => b.date.localeCompare(a.date))
      .filter(trade =>
        (!journalSearch || `${trade.tradeId} ${accountLabel(trade)} ${trade.symbol} ${trade.session} ${trade.strategy} ${trade.mistakeTag} ${trade.notes}`.toLowerCase().includes(journalSearch)) &&
        (journalMode === "all" || trade.mode === journalMode) &&
        (journalSession === "all" || trade.session === journalSession)
      );
    els.fullRows.replaceChildren();
    filtered.forEach(trade => els.fullRows.append(rowForTrade(trade, true)));
    els.fullEmpty.hidden = state.trades.length > 0;
    els.fullNoResults.hidden = state.trades.length === 0 || filtered.length > 0;
    els.fullCount.textContent = `Showing ${filtered.length} of ${state.trades.length} trades`;
  }

  function renderChart() {
    const closed = getDashboardTrades().filter(trade => tradePnl(trade) !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    els.chart.replaceChildren();
    els.chartEmpty.hidden = closed.length > 0;
    els.chart.hidden = closed.length === 0;
    if (!closed.length) {
      els.chartTotal.textContent = `${formatMoney(0)} total`;
      return;
    }
    const values = [];
    let running = 0;
    closed.forEach(trade => { running += tradePnl(trade); values.push(running); });
    els.chartTotal.textContent = `${formatMoney(running)} total`;
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const range = max - min || 1;
    const x = index => 12 + (closed.length === 1 ? 696 : index / (closed.length - 1) * 696);
    const y = value => 12 + (max - value) / range * 155;
    const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
    const ns = "http://www.w3.org/2000/svg";
    const baseline = document.createElementNS(ns, "line");
    baseline.setAttribute("x1", "8"); baseline.setAttribute("x2", "712");
    baseline.setAttribute("y1", String(y(0))); baseline.setAttribute("y2", String(y(0)));
    baseline.setAttribute("stroke", "#293544"); baseline.setAttribute("stroke-dasharray", "4 5");
    const area = document.createElementNS(ns, "polygon");
    area.setAttribute("points", `${x(0)},${y(0)} ${points} ${x(closed.length - 1)},${y(0)}`);
    area.setAttribute("fill", "#58dfb0"); area.setAttribute("fill-opacity", ".08");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", points); line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#58dfb0"); line.setAttribute("stroke-width", "2.5");
    line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-linejoin", "round");
    els.chart.append(baseline, area, line);
    const point = document.createElementNS(ns, "circle");
    point.setAttribute("cx", String(x(values.length - 1))); point.setAttribute("cy", String(y(values[values.length - 1])));
    point.setAttribute("r", "4"); point.setAttribute("fill", "#58dfb0"); point.setAttribute("stroke", "#111823"); point.setAttribute("stroke-width", "2");
    els.chart.append(point);
  }

  function renderStrategySelect() {
    const previous = els.strategySelect.value;
    els.strategySelect.replaceChildren();
    state.strategies.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.strategySelect.append(option);
    });
    if (state.strategies.includes(previous)) els.strategySelect.value = previous;
  }

  function renderStrategyLibrary() {
    const list = $("#strategyLibraryList");
    list.replaceChildren();
    state.strategies.forEach(name => {
      const trades = state.trades.filter(trade => trade.strategy === name);
      const closed = trades.filter(trade => tradePnl(trade) !== null);
      const net = closed.reduce((sum, trade) => sum + tradePnl(trade), 0);
      const row = makeElement("article", "strategy-library-row");
      const title = document.createElement("div");
      title.append(makeElement("strong", "", name));
      title.append(makeElement("span", "strategy-description", `${trades.length} trades · ${closed.length} closed`));
      const metrics = makeElement("div", "strategy-library-metrics");
      metrics.append(makeElement("span", "", `Avg R ${closed.length ? `${(closed.reduce((sum, trade) => sum + (actualR(trade) || 0), 0) / closed.length).toFixed(2)}R` : "—"}`));
      metrics.append(makeElement("strong", net > 0 ? "pnl-positive" : net < 0 ? "pnl-negative" : "", closed.length ? formatMoney(net) : "—"));
      row.append(title, metrics);
      if (!trades.length) {
        const remove = makeElement("button", "remove-strategy", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${name}`);
        remove.addEventListener("click", () => {
          if (persist({ ...state, strategies: state.strategies.filter(item => item !== name) })) {
            showToast("Strategy removed.");
          }
        });
        row.append(remove);
      } else {
        row.append(makeElement("span", "in-use-label", "In use"));
      }
      list.append(row);
    });
    if (!state.strategies.length) list.append(makeElement("div", "strategy-none", "No strategies yet. Add one above."));
  }

  function renderProp() {
    const mode = $("#propMode").value;
    const rules = state.accountRules[mode] || defaultAccountRules();
    const form = $("#propForm").elements;
    form.startingBalance.value = rules.startingBalance;
    form.dailyLossPercent.value = rules.dailyLossPercent;
    form.maxDrawdownPercent.value = rules.maxDrawdownPercent;
    form.profitTargetPercent.value = rules.profitTargetPercent;

    const closed = state.trades.filter(trade => trade.mode === mode && tradePnl(trade) !== null)
      .sort((a, b) => a.date.localeCompare(b.date) || a.tradeId.localeCompare(b.tradeId));
    const total = closed.reduce((sum, trade) => sum + tradePnl(trade), 0);
    const today = localDateString();
    const todayTotal = closed.filter(trade => trade.date === today).reduce((sum, trade) => sum + tradePnl(trade), 0);
    const start = rules.startingBalance;
    let equity = start;
    let highWater = start;
    const history = [];
    closed.forEach(trade => {
      equity += tradePnl(trade);
      highWater = Math.max(highWater, equity);
      history.push({ trade, equity, highWater, floor: highWater - start * rules.maxDrawdownPercent / 100 });
    });
    const currentHighWater = Math.max(start, highWater);
    $("#propTodayPnl").textContent = formatMoney(todayTotal);
    $("#propTodayPnl").classList.toggle("negative", todayTotal < 0);
    $("#dailyBuffer").textContent = formatMoney(Math.max(0, start * rules.dailyLossPercent / 100 + todayTotal));
    $("#drawdownFloor").textContent = formatMoney(currentHighWater - start * rules.maxDrawdownPercent / 100);
    $("#currentEquity").textContent = `Current equity ${formatMoney(start + total)} · ${formatMoney(Math.max(0, currentHighWater - (start + total)))} drawdown`;
    $("#targetRemaining").textContent = formatMoney(Math.max(0, start * rules.profitTargetPercent / 100 - total));

    const historyContainer = $("#propHistory");
    historyContainer.replaceChildren();
    if (!history.length) {
      historyContainer.append(makeElement("div", "strategy-none", "Closed trades in this account mode will appear here."));
      return;
    }
    const table = document.createElement("table");
    table.className = "prop-history-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["DATE", "INSTRUMENT", "NET P&L", "EQUITY", "HIGH WATER", "TRAILING FLOOR"].forEach(label => headRow.append(makeElement("th", "", label)));
    head.append(headRow);
    const body = document.createElement("tbody");
    history.slice().reverse().forEach(item => {
      const row = document.createElement("tr");
      const pnl = tradePnl(item.trade);
      [
        formatDate(item.trade.date), item.trade.symbol, formatMoney(pnl), formatMoney(item.equity),
        formatMoney(item.highWater), formatMoney(item.floor)
      ].forEach((value, index) => row.append(makeElement("td", index === 2 ? (pnl >= 0 ? "pnl-positive" : "pnl-negative") : "", value)));
      body.append(row);
    });
    table.append(head, body);
    historyContainer.append(table);
  }

  function updateTradeMath() {
    const form = els.tradeForm.elements;
    const mode = form.mode.value || "Backtest";
    const riskPct = numberOrNull(form.riskPercent.value) ?? 0;
    const rules = state.accountRules[mode] || defaultAccountRules();
    const risk = rules.startingBalance * riskPct / 100;
    form.riskDollar.value = risk.toFixed(2);
    const entry = numberOrNull(form.entry.value);
    const stop = numberOrNull(form.stopLoss.value);
    const target = numberOrNull(form.takeProfit.value);
    const exit = numberOrNull(form.exit.value);
    const side = form.side.value;
    const rr = entry !== null && stop !== null && target !== null && entry !== stop
      ? Math.abs(target - entry) / Math.abs(entry - stop) : null;
    form.plannedRR.value = rr === null ? "" : `${rr.toFixed(2)}R`;
    const r = entry !== null && stop !== null && exit !== null && entry !== stop
      ? (exit - entry) * (side === "Short" ? -1 : 1) / Math.abs(entry - stop) : null;
    const override = numberOrNull(form.pnlOverride.value);
    const result = override !== null ? override : r === null ? null : r * risk;
    form.netPnlPreview.value = result === null ? "" : result.toFixed(2);
    form.actualR.value = result === null || risk <= 0 ? "" : `${(result / risk).toFixed(2)}R`;
    form.outcome.value = exit === null ? "Open" : result === null ? "—" : result > 0 ? "Win" : result < 0 ? "Loss" : "BE";
  }

  function openTradeModal(trade) {
    editingId = trade?.id || null;
    els.tradeForm.reset();
    const form = els.tradeForm.elements;
    form.tradeId.value = trade?.tradeId || nextTradeCode();
    form.date.value = trade?.date || localDateString();
    form.mode.value = trade?.mode || "Backtest";
    form.account.value = trade?.account || "";
    form.symbol.value = trade?.symbol || "";
    form.session.value = trade?.session || "";
    form.side.value = trade?.side || "Long";
    form.strategy.value = trade?.strategy || state.strategies[0] || "";
    form.entry.value = trade?.entry ?? "";
    form.stopLoss.value = trade?.stopLoss ?? "";
    form.takeProfit.value = trade?.takeProfit ?? "";
    form.exit.value = trade?.exit ?? "";
    form.exitTime.value = trade?.exitTime || "";
    form.riskPercent.value = trade?.riskPercent ?? 0.5;
    form.pnlOverride.value = trade?.pnlOverride ?? "";
    form.chartBefore.value = trade?.chartBefore || "";
    form.chartAfter.value = trade?.chartAfter || "";
    form.planAdherence.value = trade?.planAdherence || "";
    form.mistakeTag.value = trade?.mistakeTag || "";
    form.notes.value = trade?.notes || "";
    els.modalTitle.textContent = editingId ? "Edit trade record" : "Log a full trade";
    $("#saveTradeButton").innerHTML = editingId ? "Save changes <span>→</span>" : "Save trade <span>→</span>";
    els.formError.hidden = true;
    updateTradeMath();
    els.tradeModal.hidden = false;
    form.symbol.focus();
  }

  function closeTradeModal() {
    els.tradeModal.hidden = true;
    editingId = null;
  }

  function deleteTrade(id) {
    const trade = state.trades.find(item => item.id === id);
    if (!trade || !window.confirm(`Delete trade ${trade.tradeId} (${trade.symbol}) from your journal?`)) return;
    if (persist({ ...state, trades: state.trades.filter(item => item.id !== id) })) showToast("Trade deleted.");
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }

  function exportBackup() {
    const content = JSON.stringify({
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      strategies: state.strategies,
      accountRules: state.accountRules,
      trades: state.trades
    }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `EdgeVault_Backup_${localDateString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("JSON backup exported.");
  }

  function setFormula(sheet, address, formula, format) {
    sheet[address] = { t: "n", f: formula };
    if (format) sheet[address].z = format;
  }

  function xlsxDate(dateString) {
    if (!dateString) return "";
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function exportWorkbook() {
    if (!window.XLSX?.utils?.aoa_to_sheet) {
      showToast("Excel export library could not load. Check your connection and try again.");
      return;
    }
    try {
      const XLSX = window.XLSX;
      const exportTrades = [...state.trades].sort((a, b) =>
        a.date.localeCompare(b.date) || a.exitTime.localeCompare(b.exitTime) || a.tradeId.localeCompare(b.tradeId));
      const headers = [
        "Trade ID", "Date", "Mode / Account", "Instrument", "Session", "Direction",
        "Setup / Strategy", "Entry", "Stop Loss", "Take Profit", "Exit Price",
        "Exit Time", "Risk %", "Risk ($)", "Planned R:R", "Actual R-Multiple",
        "Net P&L ($)", "Outcome", "Before Chart Link", "After Chart Link",
        "Plan Adherence", "Mistake Tag", "Notes"
      ];
      const rows = [headers, ...exportTrades.map(trade => [
        trade.tradeId, xlsxDate(trade.date), accountLabel(trade), trade.symbol, trade.session,
        trade.side, trade.strategy, trade.entry, trade.stopLoss, trade.takeProfit, trade.exit,
        trade.exitTime, trade.riskPercent / 100, getRiskDollar(trade), null, null,
        tradePnl(trade), outcome(trade), trade.chartBefore, trade.chartAfter,
        trade.planAdherence, trade.mistakeTag, trade.notes
      ])];
      const tradeSheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
      tradeSheet["!cols"] = [12, 13, 20, 14, 22, 12, 24, 13, 13, 13, 13, 20, 10, 13, 14, 16, 15, 12, 34, 34, 18, 18, 40]
        .map(wch => ({ wch }));
      for (let index = 0; index < exportTrades.length; index += 1) {
        const row = index + 2;
        if (tradeSheet[`N${row}`]) tradeSheet[`N${row}`].z = "$#,##0.00";
        setFormula(tradeSheet, `O${row}`, `IFERROR(ABS(J${row}-H${row})/ABS(H${row}-I${row}),"")`, '0.00"R"');
        setFormula(tradeSheet, `P${row}`, `IF(Q${row}="","",IFERROR(Q${row}/N${row},""))`, '0.00"R"');
        for (const address of [`B${row}`]) {
          if (tradeSheet[address]?.v instanceof Date) tradeSheet[address].z = "yyyy-mm-dd";
        }
        for (const address of [`S${row}`, `T${row}`]) {
          const target = tradeSheet[address]?.v;
          if (typeof target === "string" && /^https?:\/\//i.test(target)) {
            tradeSheet[address].l = { Target: target, Tooltip: "Open chart link" };
          }
        }
      }

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, tradeSheet, "Trade Log");

      const dashboardRows = [
        ["EdgeVault Performance Dashboard"],
        ["Metric", "Value"],
        ["Total trades", null],
        ["Win rate", null],
        ["Average R (expectancy)", null],
        ["Profit factor", null],
        ["Net P&L ($)", null],
        ["Max consecutive losses", null],
        ["Max drawdown ($)", null],
        [],
        ["Strategy breakdown"],
        ["Strategy", "Trades", "Win Rate", "Average R", "Net P&L ($)", "Profit Factor"]
      ];
      const dashboard = XLSX.utils.aoa_to_sheet(dashboardRows);
      const last = 10000;
      setFormula(dashboard, "B3", `COUNTA('Trade Log'!$A$2:$A$${last})`, "0");
      setFormula(dashboard, "B4", `IFERROR(COUNTIF('Trade Log'!$R$2:$R$${last},"Win")/(COUNTIF('Trade Log'!$R$2:$R$${last},"Win")+COUNTIF('Trade Log'!$R$2:$R$${last},"Loss")+COUNTIF('Trade Log'!$R$2:$R$${last},"BE")),0)`, "0.00%");
      setFormula(dashboard, "B5", `IFERROR(AVERAGE('Trade Log'!$P$2:$P$${last}),0)`, '0.00"R"');
      setFormula(dashboard, "B6", `IFERROR(SUMIF('Trade Log'!$Q$2:$Q$${last},">0",'Trade Log'!$Q$2:$Q$${last})/ABS(SUMIF('Trade Log'!$Q$2:$Q$${last},"<0",'Trade Log'!$Q$2:$Q$${last})),0)`, "0.00");
      setFormula(dashboard, "B7", `SUM('Trade Log'!$Q$2:$Q$${last})`, "$#,##0.00;[Red]-$#,##0.00");
      setFormula(dashboard, "B8", exportTrades.length ? `MAX(I2:I${exportTrades.length + 1})` : "0", "0");
      setFormula(dashboard, "B9", exportTrades.length ? `MAX(L2:L${exportTrades.length + 1})` : "0", "$#,##0.00");
      dashboard.H1 = { t: "s", v: "Outcome helper" };
      dashboard.I1 = { t: "s", v: "Loss streak" };
      dashboard.J1 = { t: "s", v: "Equity" };
      dashboard.K1 = { t: "s", v: "High water" };
      dashboard.L1 = { t: "s", v: "Drawdown" };
      exportTrades.forEach((trade, index) => {
        const row = index + 2;
        dashboard[`H${row}`] = { t: "str", f: `'Trade Log'!R${row}` };
        setFormula(dashboard, `I${row}`, row === 2
          ? `IF(H${row}="Loss",1,0)`
          : `IF(H${row}="Loss",I${row - 1}+1,0)`, "0");
        setFormula(dashboard, `J${row}`, `SUM('Trade Log'!$Q$2:Q${row})`, "$#,##0.00");
        setFormula(dashboard, `K${row}`, row === 2 ? `MAX(0,J${row})` : `MAX(K${row - 1},J${row})`, "$#,##0.00");
        setFormula(dashboard, `L${row}`, `K${row}-J${row}`, "$#,##0.00");
      });

      let dashboardRow = 13;
      function addBreakdown(title, names, sourceColumn, useModeWildcard = false) {
        dashboard[`A${dashboardRow}`] = { t: "s", v: title };
        dashboardRow += 1;
        ["Group", "Trades", "Win Rate", "Average R", "Net P&L ($)", "Profit Factor"].forEach((value, column) => {
          dashboard[XLSX.utils.encode_cell({ r: dashboardRow - 1, c: column })] = { t: "s", v: value };
        });
        dashboardRow += 1;
        names.forEach(name => {
          const row = dashboardRow;
          dashboard[`A${row}`] = { t: "s", v: name };
          const criteria = useModeWildcard ? `${name}*` : `A${row}`;
          setFormula(dashboard, `B${row}`, `COUNTIF('Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${useModeWildcard ? `"${criteria}"` : criteria})`, "0");
          const criteriaRef = useModeWildcard ? `"${criteria}"` : `A${row}`;
          const closedCount = ["Win", "Loss", "BE"].map(result =>
            `COUNTIFS('Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$R$2:$R$${last},"${result}")`
          ).join("+");
          setFormula(dashboard, `C${row}`, `IFERROR(COUNTIFS('Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$R$2:$R$${last},"Win")/(${closedCount}),0)`, "0.00%");
          setFormula(dashboard, `D${row}`, `IFERROR(AVERAGEIF('Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$P$2:$P$${last}),0)`, '0.00"R"');
          setFormula(dashboard, `E${row}`, `SUMIF('Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$Q$2:$Q$${last})`, "$#,##0.00;[Red]-$#,##0.00");
          setFormula(dashboard, `F${row}`, `IFERROR(SUMIFS('Trade Log'!$Q$2:$Q$${last},'Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$Q$2:$Q$${last},">0")/ABS(SUMIFS('Trade Log'!$Q$2:$Q$${last},'Trade Log'!$${sourceColumn}$2:$${sourceColumn}$${last},${criteriaRef},'Trade Log'!$Q$2:$Q$${last},"<0")),0)`, "0.00");
          dashboardRow += 1;
        });
        dashboardRow += 2;
      }
      addBreakdown("Strategy breakdown", state.strategies, "G");
      const sessions = [...new Set(state.trades.map(trade => trade.session).filter(Boolean))].sort();
      addBreakdown("Session breakdown", sessions.length ? sessions : ["(No session)"], "E");
      addBreakdown("Account mode breakdown", ACCOUNT_MODES, "C", true);
      dashboard["!ref"] = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(dashboardRow, exportTrades.length + 1), c: 11 }
      });
      dashboard["!cols"] = [
        { wch: 30 }, { wch: 13 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 16 },
        { hidden: true }, { hidden: true }, { hidden: true }, { hidden: true }, { hidden: true }, { hidden: true }
      ];
      XLSX.utils.book_append_sheet(workbook, dashboard, "Dashboard");

      const ruleRows = [
        ["Prop Rules & Risk"],
        [],
        ["Account mode", "Starting balance ($)", "Daily loss limit (%)", "Max trailing drawdown (%)", "Profit target (%)"],
        ...ACCOUNT_MODES.map(mode => {
          const rule = state.accountRules[mode];
          return [mode, rule.startingBalance, rule.dailyLossPercent / 100, rule.maxDrawdownPercent / 100, rule.profitTargetPercent / 100];
        }),
        [],
        ["Selected mode", "Eval"],
        ["Starting balance ($)", null],
        ["Daily loss limit (%)", null],
        ["Max trailing drawdown (%)", null],
        ["Profit target (%)", null],
        [],
        ["Daily loss limit ($)", null],
        ["Today's net P&L ($)", null],
        ["Daily loss buffer remaining ($)", null],
        ["Current equity ($)", null],
        ["Current high water ($)", null],
        ["Trailing drawdown floor ($)", null],
        ["Current drawdown ($)", null],
        ["Target remaining ($)", null],
        [],
        ["Date", "Trade ID", "Instrument", "Net P&L ($)", "Equity ($)", "High water ($)", "Trailing floor ($)"]
      ];
      const prop = XLSX.utils.aoa_to_sheet(ruleRows, { cellDates: true });
      setFormula(prop, "B10", "IFERROR(VLOOKUP(B9,$A$4:$E$7,2,FALSE),0)", "$#,##0.00");
      setFormula(prop, "B11", "IFERROR(VLOOKUP(B9,$A$4:$E$7,3,FALSE),0)", "0.00%");
      setFormula(prop, "B12", "IFERROR(VLOOKUP(B9,$A$4:$E$7,4,FALSE),0)", "0.00%");
      setFormula(prop, "B13", "IFERROR(VLOOKUP(B9,$A$4:$E$7,5,FALSE),0)", "0.00%");
      setFormula(prop, "B15", "B10*B11", "$#,##0.00");
      setFormula(prop, "B16", `SUMIFS('Trade Log'!$Q$2:$Q$${last},'Trade Log'!$B$2:$B$${last},TODAY(),'Trade Log'!$C$2:$C$${last},B9&"*")`, "$#,##0.00;[Red]-$#,##0.00");
      setFormula(prop, "B17", "MAX(0,B15+B16)", "$#,##0.00");
      setFormula(prop, "B18", `B10+SUMIF('Trade Log'!$C$2:$C$${last},B9&"*",'Trade Log'!$Q$2:$Q$${last})`, "$#,##0.00");

      const propTrades = exportTrades.filter(trade => trade.mode === $("#propMode").value && tradePnl(trade) !== null);
      const tradeLogRows = new Map(exportTrades.map((trade, index) => [trade.id, index + 2]));
      const pathStart = 25;
      propTrades.forEach((trade, index) => {
        const row = pathStart + index;
        prop[`A${row}`] = { t: "d", v: xlsxDate(trade.date), z: "yyyy-mm-dd" };
        prop[`B${row}`] = { t: "s", v: trade.tradeId };
        prop[`C${row}`] = { t: "s", v: trade.symbol };
        const tradeLogRow = tradeLogRows.get(trade.id);
        setFormula(prop, `D${row}`, `'Trade Log'!Q${tradeLogRow}`, "$#,##0.00;[Red]-$#,##0.00");
        setFormula(prop, `E${row}`, row === pathStart ? `$B$10+D${row}` : `E${row - 1}+D${row}`, "$#,##0.00");
        setFormula(prop, `F${row}`, row === pathStart ? `MAX($B$10,E${row})` : `MAX(F${row - 1},E${row})`, "$#,##0.00");
        setFormula(prop, `G${row}`, `F${row}-$B$10*$B$12`, "$#,##0.00");
      });
      const finalPathRow = propTrades.length ? pathStart + propTrades.length - 1 : pathStart;
      setFormula(prop, "B19", propTrades.length ? `MAX($B$10,F${pathStart}:F${finalPathRow})` : "$B$10", "$#,##0.00");
      setFormula(prop, "B20", "B19-B10*B12", "$#,##0.00");
      setFormula(prop, "B21", "MAX(0,B19-B18)", "$#,##0.00");
      setFormula(prop, "B22", "MAX(0,B10*B13-(B18-B10))", "$#,##0.00");
      prop["!ref"] = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(ruleRows.length - 1, pathStart + propTrades.length - 1), c: 6 }
      });
      prop["!cols"] = [31, 18, 18, 20, 20, 20, 21].map(wch => ({ wch }));
      prop["!freeze"] = { xSplit: 0, ySplit: 3 };
      XLSX.utils.book_append_sheet(workbook, prop, "Prop Rules & Risk");

      workbook.Workbook = workbook.Workbook || {};
      workbook.Workbook.CalcPr = { fullCalcOnLoad: true, forceFullCalc: true };
      XLSX.writeFile(workbook, `EdgeVault_Trading_Journal_${localDateString()}.xlsx`, { compression: true });
      showToast("3-tab Excel workbook exported.");
    } catch (error) {
      console.error("Could not export EdgeVault workbook:", error);
      showToast(`Excel export failed: ${error.message}`);
    }
  }

  function navigate(view, updateHash = true) {
    if (!PAGE_TITLES[view]) view = "overview";
    $$("[data-page]").forEach(page => { page.hidden = page.dataset.page !== view; });
    $$(".nav-link").forEach(link => {
      const active = link.dataset.view === view;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("#breadcrumbCurrent").textContent = PAGE_TITLES[view];
    $("#sidebar").classList.remove("open");
    if (updateHash && location.hash !== `#${view}`) location.hash = view;
  }

  $("#tradeForm").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget.elements;
    const entry = Number(form.entry.value);
    const stopLoss = Number(form.stopLoss.value);
    const takeProfit = Number(form.takeProfit.value);
    const exit = form.exit.value === "" ? null : Number(form.exit.value);
    const riskPercent = Number(form.riskPercent.value);
    const override = numberOrNull(form.pnlOverride.value);
    if (![entry, stopLoss, takeProfit, riskPercent].every(Number.isFinite) ||
        entry < 0 || stopLoss < 0 || takeProfit < 0 || riskPercent <= 0 ||
        (exit !== null && (!Number.isFinite(exit) || exit < 0)) ||
        entry === stopLoss) {
      els.formError.textContent = "Enter valid prices, use different entry and stop prices, and set risk above zero.";
      els.formError.hidden = false;
      return;
    }
    if (form.pnlOverride.value !== "" && override === null) {
      els.formError.textContent = "The manual P&L override must be a valid number.";
      els.formError.hidden = false;
      return;
    }

    const rules = state.accountRules[form.mode.value] || defaultAccountRules();
    const trade = {
      id: editingId || makeId(),
      tradeId: form.tradeId.value,
      date: form.date.value,
      mode: form.mode.value,
      account: form.account.value.trim(),
      symbol: form.symbol.value.trim().toUpperCase(),
      session: form.session.value,
      side: form.side.value,
      strategy: form.strategy.value,
      entry,
      stopLoss,
      takeProfit,
      exit,
      exitTime: form.exitTime.value,
      riskPercent,
      riskDollar: rules.startingBalance * riskPercent / 100,
      pnlOverride: override,
      chartBefore: form.chartBefore.value.trim(),
      chartAfter: form.chartAfter.value.trim(),
      planAdherence: form.planAdherence.value,
      mistakeTag: form.mistakeTag.value,
      notes: form.notes.value.trim()
    };
    const trades = editingId
      ? state.trades.map(item => item.id === editingId ? trade : item)
      : [...state.trades, trade];
    const wasEditing = Boolean(editingId);
    if (!persist({ ...state, trades })) return;
    closeTradeModal();
    showToast(wasEditing ? "Trade updated." : "Trade saved.");
  });

  $("#strategyForm").addEventListener("submit", event => {
    event.preventDefault();
    const input = event.currentTarget.elements.strategyName;
    const name = input.value.trim();
    if (!name) return;
    if (state.strategies.some(item => item.toLowerCase() === name.toLowerCase())) {
      showToast("That strategy already exists.");
      return;
    }
    if (!persist({ ...state, strategies: [...state.strategies, name] })) return;
    event.currentTarget.reset();
    showToast("Strategy added.");
  });

  $("#propMode").addEventListener("change", renderProp);
  $("#propForm").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget.elements;
    const mode = form.mode.value;
    const accountRules = {
      ...state.accountRules,
      [mode]: {
        startingBalance: Number(form.startingBalance.value),
        dailyLossPercent: Number(form.dailyLossPercent.value),
        maxDrawdownPercent: Number(form.maxDrawdownPercent.value),
        profitTargetPercent: Number(form.profitTargetPercent.value)
      }
    };
    if (!persist({ ...state, accountRules })) return;
    showToast(`${mode} rules saved. New trades will use this account balance for risk calculations.`);
  });

  $("#exportButton").addEventListener("click", exportBackup);
  $("#exportWorkbook").addEventListener("click", exportWorkbook);
  $("#journalExport").addEventListener("click", exportWorkbook);
  $("#importButton").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const imported = normalizeState(JSON.parse(await file.text()));
      if (!window.confirm(`Import ${imported.trades.length} trades and ${imported.strategies.length} strategies? This replaces the journal in your cloud account.`)) return;
      if (!persist(imported)) return;
      showToast("Backup imported.");
    } catch (error) {
      console.error("Could not import EdgeVault backup:", error);
      showToast(error instanceof SyntaxError ? "That file is not valid JSON." : `Import failed: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  });

  $("#addTradeTop").addEventListener("click", () => openTradeModal());
  $("#addTradeButton").addEventListener("click", () => openTradeModal());
  $$("[data-add-trade]").forEach(button => button.addEventListener("click", () => openTradeModal()));
  $$(".close-modal").forEach(button => button.addEventListener("click", closeTradeModal));
  els.tradeModal.addEventListener("click", event => { if (event.target === els.tradeModal) closeTradeModal(); });
  $("#searchInput").addEventListener("input", renderTrades);
  $("#sideFilter").addEventListener("change", renderTrades);
  $("#journalSearch").addEventListener("input", renderTrades);
  $("#journalModeFilter").addEventListener("change", renderTrades);
  $("#journalSessionFilter").addEventListener("change", renderTrades);
  ["#dashboardMode", "#dashboardStrategy", "#dashboardSession", "#dashboardMonth"].forEach(selector => {
    $(selector).addEventListener("change", () => { renderStats(); renderChart(); });
  });
  $("#tradeForm").addEventListener("input", updateTradeMath);
  $("#tradeForm").addEventListener("change", updateTradeMath);
  $("#menuToggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $$(".nav-link").forEach(link => link.addEventListener("click", event => {
    event.preventDefault();
    navigate(link.dataset.view);
  }));
  $$("[data-navigate]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.navigate)));
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1), false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeTradeModal();
      $("#sidebar").classList.remove("open");
    }
  });

  $("#todayLabel").textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long", month: "long", day: "numeric"
  }).format(new Date()).toUpperCase();
  $("#signInTab").addEventListener("click", () => setAuthTab(false));
  $("#signUpTab").addEventListener("click", () => setAuthTab(true));
  $("#retryConnection").addEventListener("click", checkSession);
  els.signInForm.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $("button[type='submit']", form);
    submit.disabled = true;
    setAuthMessage("Signing in…");
    try {
      const response = await apiRequest("/auth/login", {
        method: "POST",
        body: { email: form.elements.email.value, password: form.elements.password.value }
      });
      await enterWorkspace(response.user);
    } catch (error) {
      setAuthMessage(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  els.signUpForm.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $("button[type='submit']", form);
    if (form.elements.password.value !== form.elements.confirmPassword.value) {
      setAuthMessage("The passwords do not match.", true);
      return;
    }
    submit.disabled = true;
    setAuthMessage("Creating your account…");
    try {
      const response = await apiRequest("/auth/signup", {
        method: "POST",
        body: { email: form.elements.email.value, password: form.elements.password.value }
      });
      await enterWorkspace(response.user);
    } catch (error) {
      setAuthMessage(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  $("#logoutButton").addEventListener("click", async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      currentUser = null;
      state = defaultState();
      closeTradeModal();
      els.appShell.hidden = true;
      els.authScreen.hidden = false;
      els.signInForm.reset();
      els.signUpForm.reset();
      setAuthTab(false);
      els.authConnectionNote.textContent = "You have signed out.";
    } catch (error) {
      showToast(`Could not sign out: ${error.message}`);
    }
  });
  els.syncStatus.addEventListener("click", async () => {
    const synced = await syncJournalToCloud(state);
    showToast(synced ? "Journal sync complete." : "Cloud sync failed. Check your connection and try again.");
  });
  checkSession();
})();
