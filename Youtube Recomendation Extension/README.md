# YouTube Music-Only Recommendations (Firefox / LibreWolf)

This extension hides non-music recommendation tiles on YouTube **locally** using simple keyword and duration rules. It does **not** contact any servers.

## Install in LibreWolf (temporary install)
1. Open LibreWolf.
2. In the address bar, type `about:debugging#/runtime/this-firefox` and press Enter.
3. Click **Load Temporary Add-on...**.
4. Choose the file `manifest.json` inside this folder.

LibreWolf will load the extension immediately. It stays active until you close the browser.

## Install in Chrome (unpacked)
1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select this folder.
6. Click the extension’s **Details** button.
7. Under **Site access**, choose **On all sites** (or **On specific sites** and add `https://www.youtube.com`).

## How to use
1. Open YouTube.
2. The extension will automatically hide non-music recommendations.
3. Click the extension icon to temporarily show blocked items or change the default policy.
4. Click **Edit keyword lists** to open the options page and customize the keyword lists.

## Page scope (by request)
- Only the YouTube **Home** feed and the **Watch page sidebar** are filtered.
- Search results, channel pages, and other feeds are not touched.

## Debug mode (if it is not working)
1. Click the extension icon.
2. Enable **Debug mode (badge + logs)**.
3. Reload the YouTube page.
4. You should see a small badge in the top-right corner that says `MV DEBUG`.
5. Open DevTools (F12) and look for console messages that start with `[MV-DEBUG]`.

## Files you might edit
- `manifest.json` — extension metadata and permissions.
- `src/content.js` — main logic that scans and blocks items.
- `src/content.css` — hiding/showing styles.
- `popup/popup.html` / `popup/popup.js` — small popup controls.
- `options/options.html` / `options/options.js` — full settings editor.

## Notes
- Everything runs locally; no remote calls are made.
- If a change does not appear immediately, press **Rescan this page** in the popup.
