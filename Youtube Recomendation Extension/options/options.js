/*
  options.js
  Handles loading/saving the keyword lists and settings.
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
  // UI elements
  // -----------------------------------------
  const strongListEl = document.getElementById("strongList");
  const moderateListEl = document.getElementById("moderateList");
  const nonMusicListEl = document.getElementById("nonMusicList");
  const channelTokensEl = document.getElementById("channelTokens");
  const defaultShowEl = document.getElementById("defaultShow");
  const defaultHideEl = document.getElementById("defaultHide");
  const showBlockedEl = document.getElementById("showBlocked");
  const debugModeEl = document.getElementById("debugMode");
  const debounceEl = document.getElementById("debounceMs");
  const saveButton = document.getElementById("save");
  const resetButton = document.getElementById("reset");

  // -----------------------------------------
  // Helper functions for lists
  // -----------------------------------------
  function listToText(list) {
    if (!Array.isArray(list)) return "";
    return list.join("\n");
  }

  function textToList(text) {
    return text
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // -----------------------------------------
  // Load settings into the form
  // -----------------------------------------
  async function loadSettings() {
    const data = await storageGet({ [SETTINGS_KEY]: DEFAULTS });
    const current = { ...DEFAULTS, ...(data[SETTINGS_KEY] || {}) };

    strongListEl.value = listToText(current.strongMusicKeywords);
    moderateListEl.value = listToText(current.moderateMusicKeywords);
    nonMusicListEl.value = listToText(current.nonMusicKeywords);
    channelTokensEl.value = listToText(current.channelMusicTokens);

    if (current.defaultPolicy === "hide") {
      defaultHideEl.checked = true;
    } else {
      defaultShowEl.checked = true;
    }

    showBlockedEl.checked = Boolean(current.showBlocked);
    debugModeEl.checked = Boolean(current.debugMode);
    debounceEl.value = Number(current.debounceMs) || DEFAULTS.debounceMs;
  }

  // -----------------------------------------
  // Save settings from the form
  // -----------------------------------------
  async function saveSettings() {
    const newSettings = {
      strongMusicKeywords: textToList(strongListEl.value),
      moderateMusicKeywords: textToList(moderateListEl.value),
      nonMusicKeywords: textToList(nonMusicListEl.value),
      channelMusicTokens: textToList(channelTokensEl.value),
      defaultPolicy: defaultHideEl.checked ? "hide" : "show",
      showBlocked: showBlockedEl.checked,
      debounceMs: Number(debounceEl.value) || DEFAULTS.debounceMs,
      debugMode: debugModeEl.checked
    };

    await storageSet({ [SETTINGS_KEY]: newSettings });

    // Trigger an immediate rescan on any open YouTube tabs.
    await storageSet({ [RESCAN_KEY]: Date.now() });
  }

  // -----------------------------------------
  // Reset to defaults
  // -----------------------------------------
  async function resetSettings() {
    await storageSet({ [SETTINGS_KEY]: DEFAULTS });
    await storageSet({ [RESCAN_KEY]: Date.now() });
    await loadSettings();
  }

  // -----------------------------------------
  // Wire buttons
  // -----------------------------------------
  saveButton.addEventListener("click", saveSettings);
  resetButton.addEventListener("click", resetSettings);

  // -----------------------------------------
  // Initial load
  // -----------------------------------------
  loadSettings();
})();
