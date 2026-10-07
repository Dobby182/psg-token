// ==UserScript==
// @name         PSG Token Command Bar
// @namespace    local.psg.token.command
// @version      0.11.0
// @description  Adds a natural-language token booking command bar to the PSG Resident Portal.
// @match        http://edviewx.psgtech.ac.in/*
// @match        https://edviewx.psgtech.ac.in/*
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      script.google.com
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  console.log("PSG Token script started.");

  // ===== hardened-environment.js =====
  // Runs at document-start, BEFORE the portal's own scripts, so we capture the
  // browser's genuine APIs here. Even if the page later overrides window.fetch /
  // window.localStorage / timers / MutationObserver, we keep using the real ones.
  // Network calls additionally prefer GM_xmlhttpRequest, which runs in the
  // extension's isolated context — immune to page overrides, CORS, and CSP.
  const nativeFetch = (typeof window.fetch === "function") ? window.fetch.bind(window) : null;
  const nativeLocalStorage = window.localStorage;
  const nativeSessionStorage = window.sessionStorage;
  const nativeMutationObserver = window.MutationObserver;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);

  const gmXhr = (typeof GM_xmlhttpRequest === "function") ? GM_xmlhttpRequest : null;

  function gmRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      gmXhr({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.body,
        onload: res => resolve({
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          text: () => Promise.resolve(res.responseText || ""),
          json: () => {
            try { return Promise.resolve(JSON.parse(res.responseText)); }
            catch { return Promise.reject(new Error("Invalid JSON response")); }
          }
        }),
        onerror: () => reject(new Error("Network request failed")),
        ontimeout: () => reject(new Error("Network request timed out"))
      });
    });
  }

  const safeFetch = gmXhr
    ? gmRequest
    : ((url, options) => nativeFetch(url, options));

  // Shadow the globals inside this IIFE so every existing call site below —
  // fetch(...), localStorage.getItem(...), setTimeout(...), new MutationObserver(...)
  // — automatically uses the hardened versions with no per-call-site edits.
  const fetch = safeFetch;
  const localStorage = {
    getItem: nativeLocalStorage.getItem.bind(nativeLocalStorage),
    setItem: nativeLocalStorage.setItem.bind(nativeLocalStorage),
    removeItem: nativeLocalStorage.removeItem.bind(nativeLocalStorage)
  };
  const sessionStorage = {
    getItem: nativeSessionStorage.getItem.bind(nativeSessionStorage),
    setItem: nativeSessionStorage.setItem.bind(nativeSessionStorage),
    removeItem: nativeSessionStorage.removeItem.bind(nativeSessionStorage)
  };
  const MutationObserver = nativeMutationObserver;
  const setTimeout = nativeSetTimeout;
  const setInterval = nativeSetInterval;
  const clearTimeout = nativeClearTimeout;
  const clearInterval = nativeClearInterval;

  // ===== settings.js =====
  const SETTINGS = {
    autoLogin: true,
    username: "YOUR_USERNAME",
    password: "YOUR_PASSWORD",
    githubSync: {
      enabled: true,
      gistId: "YOUR_GIST_ID",
      filename: "psg-token-items.json",
      rulesFilename: "psg-token-rules.json",
      macrosFilename: "psg-token-macros.json",
      token: "YOUR_GITHUB_TOKEN XIjU22xZ4VGX9w"
    },
    ruleCheckIntervalMs: 5 * 60 * 1000,
    sheetsWebhook: {
      enabled: false,
      url: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
      sharedSecret: "YOUR_SHARED_SECRET"
    },
    supabase: {
      enabled: true,
      url: "https://YOUR_PROJECT_REF.supabase.co",
      anonKey: "YOUR_SUPABASE_ANON_KEY",
      sharedSecret: "YOUR_SHARED_SECRET"
    }
  };

  // ===== state.js =====
  const state = { running: false, autoLoginTried: false, pendingBatch: null, rulesRunning: false };

  // ===== item-store.js =====
  const BUILTIN_ITEM_ALIASES = [
    { keys: ["gobi", "gobi chilli"], item: "GOBI CHILLI" },
    { keys: ["chicken", "chicken gravy"], item: "Chicken Gravy" },
    { keys: ["mushroom", "mushroom manchurian"], item: "Mushroom Manchurian" },
    { keys: ["egg gravy"], item: "Egg Gravy" },
    { keys: ["full boil", "full boiled", "full boil egg"], item: "Full Boil Egg" },
    { keys: ["boiled", "boiled egg", "egg"], item: "Boiled Egg" },
    { keys: ["omelette", "omlette", "oml"], item: "Omelette" }
  ];

  const ITEM_STORE_KEY = "psgTokenItemStore_v1";
  const REMOVED_KEYS_STORE_KEY = "psgTokenRemovedKeys_v1";

  function loadItemStore() {
    try {
      const raw = localStorage.getItem(ITEM_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {
      // fall through
    }
    const seeded = BUILTIN_ITEM_ALIASES.map(entry => ({
      item: entry.item,
      keys: [...entry.keys],
      builtinKeyCount: entry.keys.length
    }));
    saveItemStore(seeded);
    return seeded;
  }

  function saveItemStore(store) {
    try {
      localStorage.setItem(ITEM_STORE_KEY, JSON.stringify(store));
    } catch {
      // non-fatal
    }
  }

  function tombstoneId(item, key) {
    return `${normalize(item)}::${normalize(key)}`;
  }

  function loadRemovedKeys() {
    try {
      const raw = localStorage.getItem(REMOVED_KEYS_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveRemovedKeys(list) {
    try {
      localStorage.setItem(REMOVED_KEYS_STORE_KEY, JSON.stringify(list));
    } catch {
      // non-fatal
    }
  }

  let itemStore = loadItemStore();
  let removedKeys = loadRemovedKeys();

  if (migrateItemStore(itemStore)) saveItemStore(itemStore);

  function getItemAliases() {
    return itemStore;
  }

  function migrateItemStore(store) {
    let changed = false;
    const omelette = store.find(e => e.item === "Omelette");
    const boiledEgg = store.find(e => e.item === "Boiled Egg");

    if (omelette) {
      const eggIdx = omelette.keys.indexOf("egg");
      if (eggIdx !== -1 && eggIdx < omelette.builtinKeyCount) {
        omelette.keys.splice(eggIdx, 1);
        omelette.builtinKeyCount -= 1;
        changed = true;
      }
      if (!omelette.keys.includes("oml")) {
        omelette.keys.splice(omelette.builtinKeyCount, 0, "oml");
        omelette.builtinKeyCount += 1;
        changed = true;
      }
    }

    if (boiledEgg && !boiledEgg.keys.includes("egg")) {
      boiledEgg.keys.splice(boiledEgg.builtinKeyCount, 0, "egg");
      boiledEgg.builtinKeyCount += 1;
      changed = true;
    }

    return changed;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function suggestShortcut(itemName) {
    const words = String(itemName || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length <= 1) return (words[0] || "").slice(0, 4);
    return words[0].slice(0, 3) + words[1].slice(0, 3);
  }

  function addItemOrShortcut(rawItemName, rawShortcut) {
    const itemName = String(rawItemName || "").trim();
    const shortcut = normalize(rawShortcut);
    if (!itemName) throw new Error("Enter an item name.");

    const store = getItemAliases();
    const existing = store.find(entry => normalize(entry.item) === normalize(itemName));

    if (existing) {
      if (!shortcut) throw new Error("Enter a shortcut to add to this item.");
      if (existing.keys.includes(shortcut)) {
        throw new Error(`"${shortcut}" is already a shortcut for ${existing.item}.`);
      }
      const clash = store.find(entry => entry !== existing && entry.keys.includes(shortcut));
      if (clash) throw new Error(`"${shortcut}" is already used for ${clash.item}.`);
      existing.keys.push(shortcut);
      saveItemStore(store);
      return { item: existing.item, shortcut, isNewItem: false };
    }

    const finalShortcut = shortcut || suggestShortcut(itemName);
    if (!finalShortcut) throw new Error("Could not generate a shortcut; type one manually.");
    const clash = store.find(entry => entry.keys.includes(finalShortcut));
    if (clash) throw new Error(`"${finalShortcut}" is already used for ${clash.item}.`);

    store.push({ item: itemName, keys: [finalShortcut], builtinKeyCount: 0 });
    saveItemStore(store);
    return { item: itemName, shortcut: finalShortcut, isNewItem: true };
  }

  function removeCustomKey(itemName, keyToRemove) {
    const store = getItemAliases();
    const entry = store.find(e => e.item === itemName);
    if (!entry) return;
    const idx = entry.keys.indexOf(keyToRemove);
    if (idx === -1 || idx < entry.builtinKeyCount) return;
    entry.keys.splice(idx, 1);

    const id = tombstoneId(itemName, keyToRemove);
    if (!removedKeys.includes(id)) removedKeys.push(id);
    saveRemovedKeys(removedKeys);

    if (entry.builtinKeyCount === 0 && entry.keys.length === 0) {
      store.splice(store.indexOf(entry), 1);
    }
    saveItemStore(store);
  }

  function addDiscoveredItem(rawItemName) {
    const itemName = String(rawItemName || "").trim();
    if (!itemName) return { item: itemName, shortcut: null, isNewItem: false };

    const store = getItemAliases();
    const existing = store.find(entry => normalize(entry.item) === normalize(itemName));
    if (existing) return { item: existing.item, shortcut: null, isNewItem: false };

    const isTaken = key => store.some(entry => entry.keys.includes(key));
    const base = suggestShortcut(itemName);
    let shortcut = base;
    for (let attempt = 1; isTaken(shortcut) && attempt <= 9; attempt += 1) {
      shortcut = `${base}${attempt}`;
    }
    if (isTaken(shortcut)) {
      shortcut = `item${Date.now().toString(36).slice(-4)}`;
    }

    store.push({ item: itemName, keys: [shortcut], builtinKeyCount: 0 });
    saveItemStore(store);
    return { item: itemName, shortcut, isNewItem: true };
  }

  // ===== rule-store.js =====
  const RULE_STORE_KEY = "psgTokenRuleStore_v1";
  const RULE_REMOVED_KEY = "psgTokenRuleRemoved_v1";
  const RULE_DATE_RETENTION_DAYS = 60;

  // Drop processed/booked dates older than the retention window. Safe because
  // the portal only offers future dates — an old date will never reappear in a
  // dropdown, so we never need to remember it. Keeps localStorage and the Gist
  // payload from growing forever.
  function pruneRuleDates(rule) {
    const cutoff = Date.now() - RULE_DATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const isFresh = dateKey => {
      const m = String(dateKey).match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (!m) return false; // malformed → drop
      const ts = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
      return ts >= cutoff;
    };
    const before = (rule.processedDates || []).length + (rule.bookedDates || []).length;
    rule.processedDates = (rule.processedDates || []).filter(isFresh);
    rule.bookedDates = (rule.bookedDates || []).filter(isFresh);
    return before - rule.processedDates.length - rule.bookedDates.length;
  }

  function loadRuleStore() {
    try {
      const raw = localStorage.getItem(RULE_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveRuleStore(store) {
    try {
      localStorage.setItem(RULE_STORE_KEY, JSON.stringify(store));
    } catch {
      // non-fatal
    }
  }

  function loadRemovedRuleIds() {
    try {
      const raw = localStorage.getItem(RULE_REMOVED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveRemovedRuleIds(list) {
    try {
      localStorage.setItem(RULE_REMOVED_KEY, JSON.stringify(list));
    } catch {
      // non-fatal
    }
  }

  let ruleStore = loadRuleStore();
  let removedRuleIds = loadRemovedRuleIds();

  ruleStore.forEach(rule => {
    if (!Array.isArray(rule.processedDates)) rule.processedDates = [];
    if (!Array.isArray(rule.bookedDates)) rule.bookedDates = [];
  });

  function getRules() {
    return ruleStore;
  }

  function makeRuleId() {
    return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function resolveItemName(rawItem) {
  const raw = String(rawItem || "").trim();
  if (!raw) return raw;
  const store = getItemAliases();
  const exact = store.find(e => normalize(e.item) === normalize(raw));
  if (exact) return exact.item;
  const alias = findItemAlias(normalize(raw));
  if (alias) return alias.item;
  return raw;
}

  function addOrUpdateRule({ id, item, meal, quantity, weekdays, enabled }) {
    const itemName = resolveItemName(item);
    if (!itemName) throw new Error("Choose an item for this rule.");
    if (!meal) throw new Error("Choose a meal for this rule.");
    if (!Array.isArray(weekdays) || weekdays.length === 0) throw new Error("Pick at least one day of the week.");
    const qty = Math.max(1, Math.min(20, Number(quantity) || 1));

    const now = Date.now();
    if (id) {
      const existing = ruleStore.find(r => r.id === id);
      if (!existing) throw new Error("That rule no longer exists.");
      const retargeted = normalize(existing.item) !== normalize(itemName) || existing.meal !== meal;
      existing.item = itemName;
      existing.meal = meal;
      existing.quantity = qty;
      existing.weekdays = [...new Set(weekdays)].sort();
      existing.enabled = enabled !== false;
      existing.updatedAt = now;
      if (retargeted) {
        existing.processedDates = [];
        existing.bookedDates = [];
      } else {
        if (!Array.isArray(existing.processedDates)) existing.processedDates = [];
        if (!Array.isArray(existing.bookedDates)) existing.bookedDates = [];
        pruneRuleDates(existing);
      }
      saveRuleStore(ruleStore);
      return existing;
    }

    const rule = {
      id: makeRuleId(),
      item: itemName,
      meal,
      quantity: qty,
      weekdays: [...new Set(weekdays)].sort(),
      enabled: enabled !== false,
      processedDates: [],
      bookedDates: [],
      updatedAt: now
    };
    ruleStore.push(rule);
    saveRuleStore(ruleStore);
    return rule;
  }

  function deleteRule(id) {
    const idx = ruleStore.findIndex(r => r.id === id);
    if (idx === -1) return;
    ruleStore.splice(idx, 1);
    if (!removedRuleIds.includes(id)) removedRuleIds.push(id);
    saveRuleStore(ruleStore);
    saveRemovedRuleIds(removedRuleIds);
  }

  function setRuleEnabled(id, enabled) {
    const rule = ruleStore.find(r => r.id === id);
    if (!rule) return;
    rule.enabled = enabled;
    rule.updatedAt = Date.now();
    saveRuleStore(ruleStore);
  }

  const RULES_PAUSED_KEY = "psgTokenRulesPaused_v1";

  function loadRulesPaused() {
    try {
      const raw = localStorage.getItem(RULES_PAUSED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.paused === "boolean") return parsed;
      }
    } catch {
      // fall through
    }
    return { paused: false, updatedAt: 0 };
  }

  function saveRulesPaused(pausedState) {
    try {
      localStorage.setItem(RULES_PAUSED_KEY, JSON.stringify(pausedState));
    } catch {
      // non-fatal
    }
  }

  let rulesPausedState = loadRulesPaused();

  function areRulesPaused() {
    return rulesPausedState.paused;
  }

  function setRulesPaused(paused) {
    rulesPausedState = { paused, updatedAt: Date.now() };
    saveRulesPaused(rulesPausedState);
  }

  const RULE_LOG_KEY = "psgTokenRuleLog_v1";
  const RULE_LOG_MAX_ENTRIES = 50;

  function loadRuleLog() {
    try {
      const raw = localStorage.getItem(RULE_LOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveRuleLog(log) {
    try {
      localStorage.setItem(RULE_LOG_KEY, JSON.stringify(log));
    } catch {
      // non-fatal
    }
  }

  let ruleLog = loadRuleLog();

  function getRuleLog() {
    return ruleLog;
  }

  function addRuleLogEntry({ ruleId, item, meal, quantity, dateKey, ok, error }) {
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ruleId,
      item,
      meal,
      quantity,
      dateKey: dateKey || "—",
      ok: !!ok,
      error: ok ? null : (error || "Unknown error")
    };
    ruleLog.push(entry);
    if (ruleLog.length > RULE_LOG_MAX_ENTRIES) {
      ruleLog = ruleLog.slice(ruleLog.length - RULE_LOG_MAX_ENTRIES);
    }
    saveRuleLog(ruleLog);
    return entry;
  }

  function clearRuleLog() {
    ruleLog = [];
    saveRuleLog(ruleLog);
  }

  const AUTO_CHAIN_KEY = "psgTokenAutoChainRules_v1";

  function loadAutoChainEnabled() {
    try {
      const raw = localStorage.getItem(AUTO_CHAIN_KEY);
      if (raw != null) return raw === "true";
    } catch {
      // fall through
    }
    return false;
  }

  function saveAutoChainEnabled(enabled) {
    try {
      localStorage.setItem(AUTO_CHAIN_KEY, enabled ? "true" : "false");
    } catch {
      // non-fatal
    }
  }

  let autoChainEnabled = loadAutoChainEnabled();

  function isAutoChainEnabled() {
    return autoChainEnabled;
  }

  function setAutoChainEnabled(enabled) {
    autoChainEnabled = !!enabled;
    saveAutoChainEnabled(autoChainEnabled);
  }

  // ===== macro-store.js =====
  const MACRO_STORE_KEY = "psgTokenMacroStore_v1";
  const MACRO_REMOVED_KEY = "psgTokenMacroRemoved_v1";

  function loadMacroStore() {
    try {
      const raw = localStorage.getItem(MACRO_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveMacroStore(store) {
    try {
      localStorage.setItem(MACRO_STORE_KEY, JSON.stringify(store));
    } catch {
      // non-fatal
    }
  }

  function loadRemovedMacroIds() {
    try {
      const raw = localStorage.getItem(MACRO_REMOVED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fall through
    }
    return [];
  }

  function saveRemovedMacroIds(list) {
    try {
      localStorage.setItem(MACRO_REMOVED_KEY, JSON.stringify(list));
    } catch {
      // non-fatal
    }
  }

  let macroStore = loadMacroStore();
  let removedMacroIds = loadRemovedMacroIds();

  function getMacros() {
    return macroStore;
  }

  function makeMacroId() {
    return `macro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function addOrUpdateMacro({ id, name, command }) {
    const macroName = String(name || "").trim();
    const macroCommand = String(command || "").trim();
    if (!macroName) throw new Error("Give the macro a button name.");
    if (!macroCommand) throw new Error("Enter the command this macro should run.");

    const now = Date.now();
    if (id) {
      const existing = macroStore.find(m => m.id === id);
      if (!existing) throw new Error("That macro no