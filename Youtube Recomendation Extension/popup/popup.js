/*
  popup.js
  Handles the small popup UI. It reads/writes settings in storage.
*/

(() => {
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const SETTINGS_KEY = "mvSettings";
  const RESCAN_KEY = "mvRescanToken";

  const DEFAULTS = globalThis.MV_DEFAULT_SETTINGS || {
    strongMusicKeywords: [],
    moderateMusicKeywords: [],
    nonMusicKeywords: [],
    channelMusicTokens: [],
    defaultPolicy: "show",
    showBlocked: false,
    debounceMs: 60,
    debugMode: false
  };

  // -----------------------------------------
  // Storage helpers
  // -----------------------------------------
  function storageGet(defaults) {
    return new Promise((resolve) => {
      try {
        if (API?.storage?.local?.get) {
          const maybePromise = API.storage.local.get(defaults, (result) => {
            if (API?.runtime?.lastError) {
              resolve(defaults);
            } else {
              resolve(result);
            }
          });

          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(resolve).catch(() => resolve(defaults));
          }
        } else {
          resolve(defaults);
        }
      } catch (err) {
        resolve(defaults);
      }
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      try {
        if (API?.storage?.local?.set) {
          const maybePromise = API.storage.local.set(data, () => resolve());
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(resolve).catch(resolve);
          }
        } else {
          resolve();
        }
      } catch (err) {
        resolve();
      }
    });
  }

  // -----------------------------------------
  // UI helpers
  // -----------------------------------------
  const showBlockedEl = document.getElementById("showBlocked");
  const debugModeEl = document.getElementById("debugMode");
  const policyShowEl = document.getElementById("policyShow");
  const policyHideEl = document.getElementById("policyHide");
  const rescanButton = document.getElementById("rescan");
  const openOptionsButton = document.getElementById("openOptions");

  function applySettingsToUI(current) {
    showBlockedEl.checked = Boolean(current.showBlocked);
    debugModeEl.checked = Boolean(current.debugMode);
    if (current.defaultPolicy === "hide") {
      policyHideEl.checked = true;
    } else {
      policyShowEl.checked = true;
    }
  }

  async function loadSettings() {
    const data = await storageGet({ [SETTINGS_KEY]: DEFAULTS });
    return { ...DEFAULTS, ...(data[SETTINGS_KEY] || {}) };
  }

  async function saveSettings(newSettings) {
    await storageSet({ [SETTINGS_KEY]: newSettings });
  }

  // -----------------------------------------
  // Event wiring
  // -----------------------------------------
  showBlockedEl.addEventListener("change", async () => {
    const current = await loadSettings();
    current.showBlocked = showBlockedEl.checked;
    await saveSettings(current);
  });

  debugModeEl.addEventListener("change", async () => {
    const current = await loadSettings();
    current.debugMode = debugModeEl.checked;
    await saveSettings(current);
  });

  policyShowEl.addEventListener("change", async () => {
    if (!policyShowEl.checked) return;
    const current = await loadSettings();
    current.defaultPolicy = "show";
    await saveSettings(current);
  });

  policyHideEl.addEventListener("change", async () => {
    if (!policyHideEl.checked) return;
    const current = await loadSettings();
    current.defaultPolicy = "hide";
    await saveSettings(current);
  });

  rescanButton.addEventListener("click", async () => {
    // Update a simple token so content scripts know they must rescan now.
    await storageSet({ [RESCAN_KEY]: Date.now() });
  });

  openOptionsButton.addEventListener("click", () => {
    if (API?.runtime?.openOptionsPage) {
      API.runtime.openOptionsPage();
    }
  });

  // -----------------------------------------
  // Initial load
  // -----------------------------------------
  loadSettings().then(applySettingsToUI);
})();
