/*
  content.js
  This runs on YouTube pages. It finds recommendation tiles, classifies them
  as music or non-music, and hides the non-music ones.

  Everything is local and deterministic. There are no network calls.
*/

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1) Basic extension API wrapper (Firefox uses `browser`, Chrome uses `chrome`)
  // ---------------------------------------------------------------------------
  const API = typeof browser !== "undefined" ? browser : chrome;

  // Storage keys so we do not collide with other extensions.
  const SETTINGS_KEY = "mvSettings";
  const CACHE_KEY = "mvCache";
  const RESCAN_KEY = "mvRescanToken";

  // How many cached decisions we keep before trimming.
  const MAX_CACHE_ENTRIES = 5000;

  // How long we wait before fully removing a blocked item from layout.
  const HIDE_DELAY_MS = 150;

  // Duration heuristics (in seconds)
  const MUSIC_MIN_SECONDS = 90;      // 1.5 minutes
  const MUSIC_MAX_SECONDS = 600;     // 10 minutes
  const EXTREME_SHORT = 30;          // 30 seconds
  const EXTREME_LONG = 30 * 60;      // 30 minutes

  // The list of YouTube recommendation renderers we check.
  // We keep them split by page context so we can limit scope.
  const HOME_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-grid-video-renderer"
  ];

  const VIDEO_CONTAINER_SELECTOR = [
    "ytd-compact-video-renderer",
    "ytd-compact-autoplay-renderer",
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-grid-video-renderer",
    "ytd-video-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-playlist-renderer",
    "ytd-compact-radio-renderer",
    "ytd-compact-mix-renderer",
    "ytd-compact-movie-renderer",
    "ytd-compact-show-renderer",
    "ytd-compact-station-renderer",
    "yt-lockup-view-model"
  ].join(",");

  const FALLBACK_LINK_SELECTOR = [
    "a#video-title",
    "a#video-title-link",
    "a[href*=\"watch?v=\"]",
    "a[href*=\"/shorts/\"]",
    "a[href^=\"https://youtu.be/\"]",
    "a[href^=\"https://www.youtube.com/watch\"]"
  ].join(",");

  const WATCH_SELECTORS = [
    "ytd-compact-video-renderer",
    "ytd-compact-autoplay-renderer",
    "ytd-grid-video-renderer",
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-playlist-renderer",
    "ytd-compact-radio-renderer",
    "ytd-compact-mix-renderer",
    "ytd-compact-movie-renderer",
    "ytd-compact-show-renderer",
    "ytd-compact-station-renderer",
    "yt-lockup-view-model"
  ];

  // ---------------------------------------------------------------------------
  // 2) Settings and cache (in-memory for speed, persisted for next visit)
  // ---------------------------------------------------------------------------
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

  let settings = { ...DEFAULTS };

  // Map<cacheKey, { isMusic: boolean, ts: number }>
  const decisionCache = new Map();
  let cacheSaveTimer = null;

  // Keyword matchers are the normalized versions of the lists.
  let matchers = buildMatchers(settings);

  // Debug info (only used when debugMode is true).
  const debugState = {
    scanned: 0,
    blocked: 0,
    allowed: 0,
    lastScanAt: 0,
    lastReason: "",
    lastContext: "",
    lastPath: "",
    candidates: 0,
    skippedNoData: 0,
    skippedProcessed: 0,
    cacheHits: 0
  };

  const DEBUG_BADGE_ID = "mv-debug-badge";

  // ---------------------------------------------------------------------------
  // 3) Storage helpers (Promise-based so we can `await` them)
  // ---------------------------------------------------------------------------
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

          // If the API returns a Promise (Firefox), use it.
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

  // ---------------------------------------------------------------------------
  // 4) Text normalization and matching helpers
  // ---------------------------------------------------------------------------
  function normalizeText(text) {
    if (!text) return "";
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function containsToken(normalizedText, normalizedToken) {
    if (!normalizedText || !normalizedToken) return false;
    const hay = ` ${normalizedText} `;
    const needle = ` ${normalizedToken} `;
    return hay.includes(needle);
  }

  function containsAny(normalizedText, normalizedTokens) {
    for (const token of normalizedTokens) {
      if (containsToken(normalizedText, token)) {
        return true;
      }
    }
    return false;
  }

  function normalizeList(listValue) {
    // We accept arrays or strings. If a string slips in, split by newline or comma.
    if (Array.isArray(listValue)) {
      return listValue.map(normalizeText).filter(Boolean);
    }
    if (typeof listValue === "string") {
      return listValue
        .split(/\n|,/)
        .map(normalizeText)
        .filter(Boolean);
    }
    return [];
  }

  function buildMatchers(currentSettings) {
    return {
      strong: normalizeList(currentSettings.strongMusicKeywords),
      moderate: normalizeList(currentSettings.moderateMusicKeywords),
      non: normalizeList(currentSettings.nonMusicKeywords),
      channel: normalizeList(currentSettings.channelMusicTokens)
    };
  }

  // ---------------------------------------------------------------------------
  // 5) Duration parsing
  // ---------------------------------------------------------------------------
  function durationToSeconds(text) {
    if (!text) return null;

    const cleaned = text.toLowerCase().replace(/\s+/g, " ").trim();

    // If there are no digits at all, we can't parse a time.
    if (!/\d/.test(cleaned)) return null;

    // Keep only digits and colons, then split by colon.
    const parts = cleaned.replace(/[^0-9:]/g, "").split(":").filter(Boolean);
    if (parts.length === 0) return null;

    // Parse from right to left (seconds, minutes, hours).
    let seconds = 0;
    let multiplier = 1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const value = parseInt(parts[i], 10);
      if (Number.isNaN(value)) return null;
      seconds += value * multiplier;
      multiplier *= 60;
    }

    return seconds;
  }

  function durationInMusicRange(seconds) {
    if (seconds == null) return false;
    return seconds >= MUSIC_MIN_SECONDS && seconds <= MUSIC_MAX_SECONDS;
  }

  function durationStronglyContradicts(seconds) {
    if (seconds == null) return false;
    return seconds < EXTREME_SHORT || seconds > EXTREME_LONG;
  }

  // ---------------------------------------------------------------------------
  // 6) Extract data from a recommendation element
  // ---------------------------------------------------------------------------
  function extractVideoId(href, root) {
    // First: check attributes on the root element (new YouTube layouts sometimes store it there).
    if (root) {
      const directId =
        root.getAttribute("video-id") ||
        root.getAttribute("data-video-id") ||
        root.getAttribute("data-videoid");

      if (directId) return directId;
    }

    if (!href) return null;
    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch (err) {
      return null;
    }

    // Standard watch URLs: /watch?v=VIDEO_ID
    const vParam = url.searchParams.get("v");
    if (vParam) return vParam;

    // Shorts: /shorts/VIDEO_ID
    if (url.pathname.startsWith("/shorts/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return parts[1];
    }

    // youtu.be/VIDEO_ID
    if (url.hostname === "youtu.be") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 1) return parts[0];
    }

    return null;
  }

  function findBestLink(root) {
    // Prefer title link if it exists.
    const titleLink = root.querySelector("a#video-title, a#video-title-link");
    if (titleLink) return titleLink;

    // Next, prefer thumbnail link.
    const thumbLink = root.querySelector("a#thumbnail");
    if (thumbLink) return thumbLink;

    // Fallback: any anchor that points to a watch or shorts URL.
    const anyWatch = root.querySelector(
      "a[href*=\"watch?v=\"], a[href*=\"/shorts/\"], a[href^=\"https://youtu.be/\"], a[href^=\"https://www.youtube.com/watch\"]"
    );
    if (anyWatch) return anyWatch;

    return null;
  }

  function extractTitle(root) {
    const titleEl = root.querySelector("a#video-title, a#video-title-link");
    if (titleEl) {
      // Prefer visible text.
      const text = (titleEl.textContent || "").trim();
      if (text) return text;

      // Fallbacks often used by YouTube.
      const attrTitle = (titleEl.getAttribute("title") || "").trim();
      if (attrTitle) return attrTitle;

      const aria = (titleEl.getAttribute("aria-label") || "").trim();
      if (aria) return aria;
    }

    // Newer layouts often store the title in yt-formatted-string nodes.
    const formatted = root.querySelector("yt-formatted-string#video-title, #video-title, h3 a, h3 span");
    if (formatted && formatted.textContent) {
      const t = formatted.textContent.trim();
      if (t) return t;
    }

    // Final fallback: use the best link's text or attributes.
    const link = findBestLink(root);
    if (link) {
      const linkText = (link.textContent || "").trim();
      if (linkText) return linkText;

      const linkTitle = (link.getAttribute("title") || "").trim();
      if (linkTitle) return linkTitle;

      const linkAria = (link.getAttribute("aria-label") || "").trim();
      if (linkAria) return linkAria;
    }

    return "";
  }

  function extractHref(root) {
    const link = findBestLink(root);
    if (link) {
      return link.getAttribute("href") || "";
    }

    return "";
  }

  function extractChannel(root) {
    // Prefer explicit channel containers.
    const channelContainer = root.querySelector("ytd-channel-name, #channel-name");
    if (channelContainer) {
      const channelLink = channelContainer.querySelector("a");
      if (channelLink) {
        const linkText = (channelLink.textContent || "").trim();
        if (linkText) return linkText;

        const linkTitle = (channelLink.getAttribute("title") || "").trim();
        if (linkTitle) return linkTitle;
      }

      const containerText = (channelContainer.textContent || "").trim();
      if (containerText) return containerText;
    }

    // Fallback: any formatted channel link that is NOT the video title link
    // and does not look like a watch link.
    const fallback = root.querySelector(
      "a.yt-simple-endpoint.yt-formatted-string:not(#video-title)"
    );
    if (fallback) {
      const text = (fallback.textContent || "").trim();
      if (text) return text;

      const titleAttr = (fallback.getAttribute("title") || "").trim();
      if (titleAttr) return titleAttr;
    }

    // Final fallback: look for any anchor that points to a channel or @handle.
    const channelLink = root.querySelector(
      "a[href*=\"/channel/\"], a[href*=\"/user/\"], a[href*=\"/@\"]"
    );
    if (channelLink) {
      const text = (channelLink.textContent || "").trim();
      if (text) return text;
    }

    return "";
  }

  function extractDurationText(root) {
    // The duration overlay is usually here.
    const durationEl = root.querySelector("ytd-thumbnail-overlay-time-status-renderer");
    if (durationEl) {
      const textNode = durationEl.querySelector("#text");
      if (textNode && textNode.textContent) {
        return textNode.textContent.trim();
      }

      if (durationEl.textContent) {
        return durationEl.textContent.trim();
      }
    }

    // Fallback: any span that looks like a duration overlay.
    const spanFallback = root.querySelector("span.ytd-thumbnail-overlay-time-status-renderer");
    if (spanFallback && spanFallback.textContent) {
      return spanFallback.textContent.trim();
    }

    return "";
  }

  function extractVideoData(root) {
    const title = extractTitle(root);
    const href = extractHref(root);
    const channel = extractChannel(root);
    const durationText = extractDurationText(root);
    const durationSeconds = durationToSeconds(durationText);

    const videoId = extractVideoId(href, root);
    const normalizedTitle = normalizeText(title);

    const cacheKey = videoId
      ? `id:${videoId}`
      : (normalizedTitle ? `title:${normalizedTitle}` : null);

    return {
      title,
      href,
      channel,
      durationText,
      durationSeconds,
      videoId,
      normalizedTitle,
      cacheKey
    };
  }

  // ---------------------------------------------------------------------------
  // 7a) Debug helpers (only when enabled)
  // ---------------------------------------------------------------------------
  function debugLog(...args) {
    if (!settings.debugMode) return;
    // Prefix so it is easy to filter in the console.
    console.log("[MV-DEBUG]", ...args);
  }

  function updateDebugBadge() {
    if (!settings.debugMode) {
      const existing = document.getElementById(DEBUG_BADGE_ID);
      if (existing) existing.remove();
      document.documentElement.classList.remove("mv-debug");
      return;
    }

    document.documentElement.classList.add("mv-debug");
    let badge = document.getElementById(DEBUG_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = DEBUG_BADGE_ID;
      badge.className = "mv-debug-badge";
      badge.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const text = badge.textContent || "";
        if (!text) return;

        try {
          await navigator.clipboard.writeText(text);
          debugLog("Copied debug badge text to clipboard.");
        } catch (err) {
          debugLog("Clipboard copy failed:", err);
        }
      });
      document.documentElement.appendChild(badge);
    }

    const last = debugState.lastScanAt
      ? new Date(debugState.lastScanAt).toLocaleTimeString()
      : "never";

    badge.textContent =
      `MV DEBUG\n` +
      `Context: ${debugState.lastContext || "-"}\n` +
      `Path: ${debugState.lastPath || "-"}\n` +
      `Candidates: ${debugState.candidates}\n` +
      `Classified: ${debugState.scanned}\n` +
      `Blocked: ${debugState.blocked}\n` +
      `Allowed: ${debugState.allowed}\n` +
      `Skipped(no data): ${debugState.skippedNoData}\n` +
      `Skipped(processed): ${debugState.skippedProcessed}\n` +
      `Cache hits: ${debugState.cacheHits}\n` +
      `Last: ${last}\n` +
      `Reason: ${debugState.lastReason || "-"}`;
  }

  // ---------------------------------------------------------------------------
  // 7) Classification algorithm (exact flow from the requirements)
  // ---------------------------------------------------------------------------
  function classifyVideo(data) {
    const combined = normalizeText(`${data.title} ${data.channel}`);
    const channelNormalized = normalizeText(data.channel);

    // 1) Strong music keywords -> MUSIC
    if (containsAny(combined, matchers.strong)) {
      return { isMusic: true, reason: "strong" };
    }

    // 2) Non-music keywords -> NON-MUSIC
    if (containsAny(combined, matchers.non)) {
      return { isMusic: false, reason: "non" };
    }

    // 3) Moderate keywords -> MUSIC unless duration strongly contradicts
    if (containsAny(combined, matchers.moderate)) {
      if (durationStronglyContradicts(data.durationSeconds)) {
        return { isMusic: false, reason: "moderate+duration" };
      }
      return { isMusic: true, reason: "moderate" };
    }

    // 4) Duration in music range AND channel looks music-ish -> MUSIC
    if (durationInMusicRange(data.durationSeconds) && containsAny(channelNormalized, matchers.channel)) {
      return { isMusic: true, reason: "duration+channel" };
    }

    // 5) Default policy (conservative: do NOT hide unless confident)
    const defaultIsMusic = settings.defaultPolicy !== "hide";
    return { isMusic: defaultIsMusic, reason: "default" };
  }

  // ---------------------------------------------------------------------------
  // 8) Cache helpers
  // ---------------------------------------------------------------------------
  function cacheGet(key) {
    if (!key) return null;
    const entry = decisionCache.get(key);
    if (!entry) return null;

    // Touch the entry to keep it fresh (LRU-ish behavior).
    decisionCache.delete(key);
    decisionCache.set(key, { ...entry, ts: Date.now() });

    return entry.isMusic;
  }

  function cacheSet(key, isMusic) {
    if (!key) return;

    decisionCache.set(key, { isMusic, ts: Date.now() });

    // Trim the cache if it grows too large.
    if (decisionCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = decisionCache.keys().next().value;
      decisionCache.delete(oldestKey);
    }

    scheduleCacheSave();
  }

  function scheduleCacheSave() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;

      // Convert Map -> plain object for storage.
      const obj = {};
      for (const [key, value] of decisionCache.entries()) {
        obj[key] = value;
      }

      storageSet({ [CACHE_KEY]: obj });
    }, 1000);
  }

  async function loadCache() {
    const data = await storageGet({ [CACHE_KEY]: {} });
    const raw = data[CACHE_KEY] || {};

    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value.isMusic === "boolean") {
        decisionCache.set(key, value);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 9) DOM hide/show helpers
  // ---------------------------------------------------------------------------
  function hideElement(el) {
    el.classList.add("mv-blocked");

    // If user wants to see blocked items, do not fully hide.
    if (settings.showBlocked) return;

    // Fade out, then remove from layout.
    setTimeout(() => {
      // Only hide if it is still blocked and we are not in "show blocked" mode.
      if (!settings.showBlocked && el.classList.contains("mv-blocked")) {
        el.classList.add("mv-hidden");
      }
    }, HIDE_DELAY_MS);
  }

  function unhideElement(el) {
    el.classList.remove("mv-hidden");
    el.classList.remove("mv-blocked");
  }

  function applyShowBlocked(show) {
    settings.showBlocked = show;

    if (show) {
      document.documentElement.classList.add("mv-show-blocked");
      // Remove mv-hidden so elements are visible again.
      document.querySelectorAll(".mv-blocked").forEach((el) => {
        el.classList.remove("mv-hidden");
      });
    } else {
      document.documentElement.classList.remove("mv-show-blocked");
      // Re-hide currently blocked elements.
      document.querySelectorAll(".mv-blocked").forEach((el) => {
        if (!el.classList.contains("mv-hidden")) {
          hideElement(el);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 10) Page context detection (only scan Home + Watch sidebar)
  // ---------------------------------------------------------------------------
  function isElementVisible(el) {
    if (!el) return false;
    if (el.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function getHomeRoot() {
    if (window.location.pathname !== "/") return null;

    const browseHome = document.querySelector(
      "ytd-browse[page-subtype=\"home\"], ytd-browse[page-subtype=\"home-feed\"]"
    );
    if (isElementVisible(browseHome)) return browseHome;

    const richGrid = document.querySelector("ytd-rich-grid-renderer");
    if (isElementVisible(richGrid)) return richGrid;

    return null;
  }

  function getWatchSidebarRoot() {
    if (window.location.pathname !== "/watch") return null;

    const secondaryResults = document.querySelector("ytd-watch-next-secondary-results-renderer");
    const related = document.querySelector("#secondary #related");
    const secondary = document.querySelector("ytd-watch-flexy #secondary");

    if (isElementVisible(related)) return related;
    if (isElementVisible(secondaryResults)) return secondaryResults;
    if (isElementVisible(secondary)) return secondary;

    // Fallback: if we are on a watch page but cannot find a sidebar root,
    // scan the document so we still catch compact renderers.
    return document.body || null;
  }

  function getCurrentWatchVideoId() {
    if (window.location.pathname !== "/watch") return null;
    const params = new URLSearchParams(window.location.search || "");
    return params.get("v");
  }

  function getScanTargets() {
    const targets = [];

    const homeRoot = getHomeRoot();
    if (homeRoot) {
      targets.push({
        context: "home",
        root: homeRoot,
        selector: HOME_SELECTORS.join(",")
      });
    }

    const watchRoot = getWatchSidebarRoot();
    if (watchRoot) {
      // Sidebar recommendations are in these containers.
      targets.push({
        context: "watch-sidebar",
        root: watchRoot,
        selector: WATCH_SELECTORS.join(",")
      });
    }

    return targets;
  }

  // ---------------------------------------------------------------------------
  // 11) Scanning and processing
  // ---------------------------------------------------------------------------
  let scanTimer = null;
  let scanEpoch = 0;

  function scheduleScan() {
    if (scanTimer) return;
    const delay = Number(settings.debounceMs) || DEFAULTS.debounceMs || 60;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanNow();
    }, delay);
  }

  function collectCandidates(root, selector, context) {
    const candidates = new Set();
    if (!root) return candidates;

    root.querySelectorAll(selector).forEach((el) => candidates.add(el));

    // Fallback: on watch pages, YouTube sometimes uses different renderers.
    if (context === "watch-sidebar") {
      root.querySelectorAll(FALLBACK_LINK_SELECTOR).forEach((link) => {
        const container = link.closest(VIDEO_CONTAINER_SELECTOR);
        if (container) {
          candidates.add(container);
        }
      });
    }

    return candidates;
  }

  function processCandidate(element, context) {
    if (!element || element.nodeType !== 1) return;

    // Avoid double-processing the same node within the same scan.
    if (element.dataset.mvEpoch === String(scanEpoch)) {
      return;
    }
    element.dataset.mvEpoch = String(scanEpoch);

    const data = extractVideoData(element);

    // If we have no useful info yet, skip for now and try later.
    if (!data.title && !data.videoId) {
      if (settings.debugMode) {
        debugState.skippedNoData += 1;
      }
      debugLog("Skipping element (no title/id yet)", element);
      return;
    }

    // Build a stable per-element key so we can reprocess if YouTube reuses nodes.
    const elementKey = data.cacheKey || data.normalizedTitle || data.title;
    const previousKey = element.dataset.mvKey || "";

    // On watch pages, YouTube reuses DOM nodes for new videos.
    // If the watch video changed, force reprocessing.
    const currentWatchId = getCurrentWatchVideoId();
    if (currentWatchId && element.dataset.mvWatchId !== currentWatchId) {
      element.dataset.mvProcessed = "";
      element.dataset.mvKey = "";
      element.dataset.mvWatchId = currentWatchId;
    }

    const allowSkip = context !== "watch-sidebar";
    if (allowSkip && element.dataset.mvProcessed === "1" && previousKey === elementKey) {
      if (settings.debugMode) {
        debugState.skippedProcessed += 1;
      }
      return;
    }

    if (elementKey) {
      element.dataset.mvKey = elementKey.slice(0, 200);
    }
    if (currentWatchId) {
      element.dataset.mvWatchId = currentWatchId;
    }

    // 1) Check cache first (fast, synchronous) if we have a cache key.
    if (data.cacheKey) {
      const cached = cacheGet(data.cacheKey);
      if (cached !== null) {
        if (!cached) {
          hideElement(element);
        } else {
          unhideElement(element);
        }
        if (settings.debugMode) {
          debugState.cacheHits += 1;
          element.dataset.mvReason = "cache";
        }
        element.dataset.mvProcessed = "1";
        return;
      }
    }

    // 2) Classify locally.
    const result = classifyVideo(data);

    // 3) Apply the result.
    if (!result.isMusic) {
      hideElement(element);
    } else {
      unhideElement(element);
    }

    // 4) Save to cache.
    if (data.cacheKey) {
      cacheSet(data.cacheKey, result.isMusic);
    }

    if (settings.debugMode) {
      element.dataset.mvReason = result.reason;
      element.dataset.mvTitle = (data.title || "").slice(0, 80);
      element.dataset.mvId = data.videoId || "";
    }

    debugState.scanned += 1;
    if (result.isMusic) {
      debugState.allowed += 1;
    } else {
      debugState.blocked += 1;
    }
    debugState.lastReason = result.reason;

    // 5) Mark as processed so we do not repeat work.
    element.dataset.mvProcessed = "1";
  }

  function scanNow() {
    if (settings.debugMode) {
      debugState.scanned = 0;
      debugState.blocked = 0;
      debugState.allowed = 0;
      debugState.lastScanAt = Date.now();
      debugState.lastReason = "";
      debugState.lastContext = "";
      debugState.lastPath = window.location.pathname;
      debugState.candidates = 0;
      debugState.skippedNoData = 0;
      debugState.skippedProcessed = 0;
      debugState.cacheHits = 0;
    }

    scanEpoch += 1;

    const targets = getScanTargets();
    if (settings.debugMode) {
      debugState.lastContext = targets.map((t) => t.context).join(",") || "-";
    }

    if (settings.debugMode && targets.length === 0) {
      debugLog("No scan targets for this page", {
        pathname: window.location.pathname,
        href: window.location.href
      });
    }

    targets.forEach((target) => {
      if (!target.root) return;
      const candidates = collectCandidates(target.root, target.selector, target.context);
      if (settings.debugMode) {
        debugState.candidates += candidates.size;
      }
      candidates.forEach((el) => processCandidate(el, target.context));
    });

    if (settings.debugMode) {
      updateDebugBadge();
      debugLog("Scan complete", {
        total: debugState.scanned,
        blocked: debugState.blocked,
        allowed: debugState.allowed
      });
    }
  }

  function rescanAll() {
    // Remove processed marks so we re-evaluate (only in allowed contexts).
    const targets = getScanTargets();
    targets.forEach((target) => {
      if (!target.root) return;
      const candidates = collectCandidates(target.root, target.selector, target.context);
      candidates.forEach((el) => {
        el.dataset.mvProcessed = "";
        el.dataset.mvKey = "";
        unhideElement(el);
      });
    });
    scanNow();
  }

  // ---------------------------------------------------------------------------
  // 12) Listen for changes from the popup/options
  // ---------------------------------------------------------------------------
  if (API?.runtime?.onMessage) {
    API.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "MV_TOGGLE_SHOW_BLOCKED") {
        applyShowBlocked(Boolean(message.show));
      }

      if (message.type === "MV_REFRESH") {
        rescanAll();
      }
    });
  }

  if (API?.storage?.onChanged) {
    API.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes[SETTINGS_KEY]) {
        const newValue = changes[SETTINGS_KEY].newValue;
        if (newValue && typeof newValue === "object") {
          settings = { ...DEFAULTS, ...newValue };
          matchers = buildMatchers(settings);
          applyShowBlocked(settings.showBlocked);
          updateDebugBadge();
          rescanAll();
        }
      }

      // A simple \"rescan now\" signal set by the popup/options page.
      if (changes[RESCAN_KEY]) {
        rescanAll();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 13) Initialization
  // ---------------------------------------------------------------------------
  async function init() {
    // Load settings
    const data = await storageGet({ [SETTINGS_KEY]: DEFAULTS });
    settings = { ...DEFAULTS, ...(data[SETTINGS_KEY] || {}) };
    matchers = buildMatchers(settings);

    // Load cache (async, but does not block initial scan).
    loadCache();

    // Apply show-blocked state immediately.
    applyShowBlocked(Boolean(settings.showBlocked));
    updateDebugBadge();

    // First scan as soon as possible.
    scheduleScan();

    // Observe the page for new recommendations.
    const observer = new MutationObserver(() => {
      scheduleScan();
    });

    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      // YouTube often updates text/attributes without inserting new nodes.
      attributes: true,
      attributeFilter: [
        "href",
        "title",
        "aria-label",
        "video-id",
        "data-video-id",
        "hidden",
        "style",
        "class"
      ],
      characterData: true
    });

    // YouTube is a single-page app. These events fire on in-app navigation.
    document.addEventListener("yt-navigate-finish", () => scheduleScan(), true);
    document.addEventListener("yt-page-data-updated", () => scheduleScan(), true);
    document.addEventListener("yt-navigate-start", () => scheduleScan(), true);
    document.addEventListener("yt-page-data-fetched", () => scheduleScan(), true);
    window.addEventListener("popstate", () => scheduleScan(), true);
  }

  init();
})();
