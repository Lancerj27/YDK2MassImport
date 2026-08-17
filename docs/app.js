"use strict";

/* ==========================================================================
 * ydk2tcg — browser port of ydk2tcg_gui.py
 * Parses .ydk files, resolves passcodes via a bundled local card database
 * (cards.json) with the YGOPRODeck API as a fallback for anything missing
 * (new cards released after cards.json was generated), tallies duplicates,
 * and produces a TCGplayer Mass Entry list.
 *
 * cards.json is a static file shipped alongside this script, built with
 * build_card_cache.py / convert_card_cache.py. It maps every known
 * passcode (incl. alt-art ids) to {name, tcg}. Because nearly all lookups
 * are satisfied locally, there's effectively no per-user rate-limit
 * concern anymore -- the live API is only touched for genuine misses.
 * ========================================================================== */

const API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const MASSENTRY_URL = "https://www.tcgplayer.com/massentry";
const LOCAL_CARDS_URL = "cards.json"; // static file shipped next to this script

const CHUNK_SIZE = 100;
const URL_SOFT_LIMIT = 7000;

// YGOPRODeck allows 20 requests/sec and blocks for an hour if you exceed it.
// We deliberately sit an order of magnitude below that ceiling. This only
// matters now for the rare fallback lookups the local cache doesn't cover.
const MIN_REQUEST_GAP_MS = 500; // 2 req/sec

const CACHE_KEY = "ydk2tcg_cache_v2";
// Passcodes the database genuinely doesn't know (anime-only, brand new) are
// remembered as misses so we stop re-asking every single run, but not
// forever, since new cards do get added.
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

const SECTION_HEADERS = {
  "#main": "main",
  "#extra": "extra",
  "!side": "side",
  "#side": "side",
};

// ---------------------------------------------------------------------
// Rate limiter — simple serialized delay between requests
// ---------------------------------------------------------------------

let lastRequestTime = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastRequestTime + MIN_REQUEST_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// .ydk parsing
// ---------------------------------------------------------------------

function parseYdk(text) {
  const sections = { main: [], extra: [], side: [] };
  let current = "main"; // ids before any header belong to the main deck

  const lines = text.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const key = line.toLowerCase();
    if (SECTION_HEADERS[key]) {
      current = SECTION_HEADERS[key];
      continue;
    }
    if (line[0] === "#" || line[0] === "!") continue;

    const digits = line.split(/\s+/)[0];
    if (!/^\d+$/.test(digits)) continue;

    // Some exporters zero-pad passcodes; normalise so 0023434538 and
    // 23434538 are counted as the same card.
    sections[current].push(parseInt(digits, 10));
  }
  return sections;
}

// ---------------------------------------------------------------------
// Local static card database (cards.json)
// ---------------------------------------------------------------------

// Loaded once and reused for the lifetime of the page. Shape matches the
// in-memory `cards` cache used elsewhere: { [passcode]: { name, tcg } }.
let localCardsPromise = null;

function loadLocalCards() {
  if (!localCardsPromise) {
    localCardsPromise = fetch(LOCAL_CARDS_URL)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((exc) => {
        // Not fatal -- we just fall back to the live API for everything.
        console.warn(`Could not load local card database (${LOCAL_CARDS_URL}): ${exc.message}`);
        return {};
      });
  }
  return localCardsPromise;
}

// ---------------------------------------------------------------------
// Cache (localStorage stands in for the on-disk JSON cache)
// ---------------------------------------------------------------------

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { cards: {}, misses: {} };
    const data = JSON.parse(raw);
    return {
      cards: data.cards && typeof data.cards === "object" ? data.cards : {},
      misses: data.misses && typeof data.misses === "object" ? data.misses : {},
    };
  } catch {
    return { cards: {}, misses: {} };
  }
}

function saveCache(cards, misses) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ cards, misses }));
  } catch {
    // a cache miss is survivable; a storage error is not fatal either
  }
}

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------

class ApiError extends Error {}
class RateLimited extends ApiError {}

async function apiGet(params, retries = 2) {
  const url = API_URL + "?" + new URLSearchParams(params).toString();

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    await throttle();
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (resp.status === 400) {
        // "none of those passcodes matched" is an answer, not a failure.
        try {
          return await resp.json();
        } catch {
          return { error: await resp.text() };
        }
      }
      if (resp.status === 429) {
        throw new RateLimited(
          "the card database is rate-limiting this connection"
        );
      }
      if (!resp.ok) {
        if ([500, 502, 503, 504].includes(resp.status)) {
          lastErr = new Error(`HTTP ${resp.status}`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new ApiError(`HTTP ${resp.status}`);
      }
      return await resp.json();
    } catch (exc) {
      if (exc instanceof RateLimited) throw exc;
      lastErr = exc;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new ApiError(String(lastErr));
}

function indexResponse(payload, out) {
  // Map every passcode a card is known by (incl. alt arts) to its record.
  // Asking for an alternate-artwork passcode can return the parent card
  // under a different top-level id, so index card_images too or those
  // lookups come back looking unmatched.
  const data = payload.data || [];
  for (const card of data) {
    const name = card.name;
    if (!name) continue;

    const record = { name };
    const misc = card.misc_info;
    if (Array.isArray(misc) && misc.length && typeof misc[0] === "object") {
      record.tcg = Boolean(misc[0].tcg_date);
    }

    const ids = new Set([card.id]);
    for (const img of card.card_images || []) {
      if (img && img.id != null) ids.add(img.id);
    }

    for (const cid of ids) {
      if (cid != null) out[String(parseInt(cid, 10))] = record;
    }
  }
}

async function resolveNames(passcodes, checkTcg, onProgress) {
  // Local static database first -- this satisfies the overwhelming
  // majority of lookups with zero network calls.
  onProgress && onProgress("Loading local card database...");
  const localCards = await loadLocalCards();

  const { cards, misses } = loadCache();
  const now = Date.now();

  // Merge local cards into the working set. localStorage-cached entries
  // (from earlier live lookups, e.g. brand-new cards) take precedence
  // since they may be more complete (e.g. include the tcg flag).
  const merged = { ...localCards, ...cards };

  function satisfied(cid) {
    const key = String(cid);
    const rec = merged[key];
    if (rec) return !(checkTcg && !("tcg" in rec));
    const seen = misses[key];
    return typeof seen === "number" && now - seen < MISS_TTL_MS;
  }

  const missingSet = new Set(passcodes.filter((c) => !satisfied(c)));
  const missing = Array.from(missingSet).sort((a, b) => a - b);
  let warning = null;

  if (missing.length === 0) {
    onProgress &&
      onProgress("All names resolved from the local database — no lookup needed.");
    return { cards: merged, warning: null, usedApi: false, apiLookupCount: 0 };
  }

  const chunks = [];
  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    chunks.push(missing.slice(i, i + CHUNK_SIZE));
  }

  onProgress &&
    onProgress(
      `${passcodes.length - missing.length} card(s) resolved locally. ` +
        `Looking up ${missing.length} more from the live database...`
    );

  // We're about to attempt at least one live request -- track that
  // regardless of whether it ultimately succeeds, so the UI can tell the
  // user the local database alone wasn't enough this time.
  const usedApi = true;

  for (let n = 0; n < chunks.length; n++) {
    const chunk = chunks[n];
    onProgress &&
      onProgress(`Looking up ${chunk.length} card(s)... [${n + 1}/${chunks.length}]`);

    const params = { id: chunk.join(",") };
    if (checkTcg) params.misc = "yes";

    let payload;
    try {
      payload = await apiGet(params);
    } catch (exc) {
      if (exc instanceof RateLimited) {
        warning =
          "Rate limited by the card database. It blocks a connection for " +
          "up to an hour once tripped, so try again later. Cached names " +
          "were used where available.";
      } else {
        warning = `Could not reach the card database (${exc.message}). Using cached names only.`;
      }
      break;
    }

    indexResponse(payload, cards);
    indexResponse(payload, merged);

    // Anything the server answered about but did not return is genuinely
    // unknown to it. Record that so we stop asking on every future run.
    for (const cid of chunk) {
      if (!(String(cid) in merged)) misses[String(cid)] = now;
    }
  }

  // Count how many of the originally-missing passcodes actually got
  // resolved, rather than how many were merely asked about -- a chunk can
  // include ids the API doesn't recognise, which don't count as resolved.
  let apiLookupCount = 0;
  for (const cid of missing) {
    if (String(cid) in merged) apiLookupCount++;
  }

  // Only the live-lookup results (and misses) go into localStorage --
  // the local static database is re-fetched from cards.json each load,
  // so there's no need to duplicate it into localStorage too.
  saveCache(cards, misses);
  return { cards: merged, warning, usedApi, apiLookupCount };
}

function tally(ids) {
  const counts = new Map();
  for (const cid of ids) counts.set(cid, (counts.get(cid) || 0) + 1);
  return counts;
}

function buildLines(counts, cache) {
  const lines = [];
  const unresolved = [];
  const ocgOnly = [];

  for (const [cid, qty] of counts.entries()) {
    const rec = cache[String(cid)];
    if (!rec) {
      unresolved.push(cid);
      continue;
    }
    lines.push(`${qty} ${rec.name}`);
    if (rec.tcg === false) ocgOnly.push(rec.name);
  }
  return { lines, unresolved, ocgOnly };
}

function massentryUrl(lines) {
  const payload = lines.join("||");
  return `${MASSENTRY_URL}?productline=YuGiOh&c=${encodeURIComponent(payload)}`;
}

// ---------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------

const state = {
  files: [], // { name, text }
  lines: [],
};

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  fileList: document.getElementById("fileList"),
  fileHint: document.getElementById("fileHint"),
  optMain: document.getElementById("optMain"),
  optExtra: document.getElementById("optExtra"),
  optSide: document.getElementById("optSide"),
  optTcgFlag: document.getElementById("optTcgFlag"),
  convertBtn: document.getElementById("convertBtn"),
  spinner: document.getElementById("spinner"),
  status: document.getElementById("status"),
  output: document.getElementById("output"),
  notes: document.getElementById("notes"),
  copyBtn: document.getElementById("copyBtn"),
  saveBtn: document.getElementById("saveBtn"),
  openBtn: document.getElementById("openBtn"),
  clearBtn: document.getElementById("clearBtn"),
};

function refreshFileList() {
  els.fileList.innerHTML = "";
  for (const [i, f] of state.files.entries()) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = f.name;
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Remove";
    btn.addEventListener("click", () => {
      state.files.splice(i, 1);
      refreshFileList();
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.fileList.appendChild(li);
  }
  els.fileHint.textContent = state.files.length
    ? `${state.files.length} deck file(s) ready.`
    : "Choose one or more .ydk files.";
}

async function addFiles(fileObjs) {
  for (const file of fileObjs) {
    if (!file.name.toLowerCase().endsWith(".ydk")) continue;
    if (state.files.some((f) => f.name === file.name)) continue;
    const text = await file.text();
    state.files.push({ name: file.name, text });
  }
  refreshFileList();
}

els.fileInput.addEventListener("change", (e) => {
  addFiles(Array.from(e.target.files));
  e.target.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("drag-over");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  addFiles(files);
});

function setBusy(busy) {
  els.convertBtn.disabled = busy;
  els.spinner.classList.toggle("hidden", !busy);
  if (busy) {
    els.status.textContent = "Working...";
    setSourceBadge(null);
  }
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// Small pill badge shown next to the status line indicating whether the
// last conversion's card names came from the local database, a live
// YGOPRODeck lookup, or both. Built lazily and inserted right after the
// status element so no HTML changes are required.
let sourceBadgeEl = null;
function getSourceBadge() {
  if (!sourceBadgeEl) {
    sourceBadgeEl = document.createElement("span");
    sourceBadgeEl.className = "source-badge hidden";
    els.status.insertAdjacentElement("afterend", sourceBadgeEl);
  }
  return sourceBadgeEl;
}

function setSourceBadge(kind) {
  const badge = getSourceBadge();
  if (!kind) {
    badge.classList.add("hidden");
    return;
  }
  const variants = {
    local: { cls: "local", label: "Pulled from local data" },
    api: { cls: "api", label: "Pulled from API" },
  };
  const v = variants[kind];
  badge.className = `source-badge ${v.cls}`;
  badge.textContent = v.label;
  badge.title =
    kind === "local"
      ? "All card names resolved from the bundled local database — no network lookup needed."
      : "One or more card names required a live lookup to YGOPRODeck (not found in the local database).";
}

function showError(text) {
  els.output.value = text;
  els.notes.innerHTML = "";
  [els.copyBtn, els.saveBtn, els.openBtn].forEach((b) => (b.disabled = true));
  setStatus("Nothing to convert.");
  setSourceBadge(null);
}

function render({ lines, unresolved, ocgOnly, warning, empty, total, usedApi, apiLookupCount }) {
  state.lines = lines;
  els.output.value = lines.join("\n");

  const notes = [];
  if (usedApi && apiLookupCount > 0) {
    notes.push([
      "info",
      `${apiLookupCount} card(s) weren't in the local database and were ` +
        "looked up live from YGOPRODeck.",
    ]);
  } else if (usedApi && apiLookupCount === 0 && !warning) {
    notes.push([
      "info",
      "Some card(s) weren't in the local database and a live lookup was " +
        "attempted, but none were found.",
    ]);
  }
  if (warning) notes.push(["err", warning]);
  if (unresolved.length) {
    notes.push([
      "warn",
      "Not found: passcode(s) " +
        unresolved.join(", ") +
        " — usually anime-only, Rush Duel, or too new for the database. " +
        "These are NOT in the list above.",
    ]);
  }
  if (ocgOnly.length) {
    notes.push([
      "warn",
      "OCG-only, TCGplayer will not stock these: " +
        Array.from(new Set(ocgOnly)).sort().join(", "),
    ]);
  }
  if (empty.length) {
    notes.push([
      "dim",
      "No cards in the ticked sections for: " + empty.join(", "),
    ]);
  }

  els.notes.innerHTML = "";
  for (const [cls, text] of notes) {
    const div = document.createElement("div");
    div.className = `note ${cls}`;
    div.textContent = text;
    els.notes.appendChild(div);
  }

  const enabled = lines.length > 0;
  [els.copyBtn, els.saveBtn, els.openBtn].forEach((b) => (b.disabled = !enabled));

  setSourceBadge(usedApi ? "api" : "local");

  setStatus(
    `${lines.length} unique card(s), ${total} total.` +
      (enabled ? "  Copy the list and paste it at tcgplayer.com/massentry." : "")
  );
}

async function convert() {
  if (state.files.length === 0) {
    alert("Add at least one .ydk file first.");
    return;
  }

  const wanted = [
    ["main", els.optMain.checked],
    ["extra", els.optExtra.checked],
    ["side", els.optSide.checked],
  ]
    .filter(([, on]) => on)
    .map(([s]) => s);

  if (wanted.length === 0) {
    alert("Tick at least one deck section.");
    return;
  }

  const ids = [];
  const empty = [];
  for (const f of state.files) {
    let sections;
    try {
      sections = parseYdk(f.text);
    } catch (exc) {
      showError(`Cannot read ${f.name}\n\n${exc}`);
      return;
    }
    const got = wanted.flatMap((s) => sections[s]);
    if (got.length === 0) empty.push(f.name);
    ids.push(...got);
  }

  if (ids.length === 0) {
    showError(
      "No cards found in the selected sections.\n" +
        "Check that the deck actually has cards in the parts you ticked."
    );
    return;
  }

  setBusy(true);
  try {
    const checkTcg = els.optTcgFlag.checked;
    const { cards, warning, usedApi, apiLookupCount } = await resolveNames(
      ids,
      checkTcg,
      setStatus
    );
    const counts = tally(ids);
    const { lines, unresolved, ocgOnly } = buildLines(counts, cards);
    let total = 0;
    for (const v of counts.values()) total += v;
    render({ lines, unresolved, ocgOnly, warning, empty, total, usedApi, apiLookupCount });
  } catch (exc) {
    showError(`${exc.name || "Error"}: ${exc.message}`);
  } finally {
    setBusy(false);
  }
}

els.convertBtn.addEventListener("click", convert);

els.copyBtn.addEventListener("click", async () => {
  const text = state.lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback: select the textarea for manual copy
    els.output.select();
    document.execCommand("copy");
  }
  setStatus(
    `Copied ${state.lines.length} line(s). Paste at tcgplayer.com/massentry, Product Line: YuGiOh.`
  );
});

els.saveBtn.addEventListener("click", () => {
  const text = state.lines.join("\n") + "\n";
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "massentry.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Saved massentry.txt");
});

els.clearBtn.addEventListener("click", () => {
  state.lines = [];
  state.files = [];
  refreshFileList();
  els.output.value = "";
  els.notes.innerHTML = "";
  [els.copyBtn, els.saveBtn, els.openBtn].forEach((b) => (b.disabled = true));
  setStatus("Cleared. Choose one or more .ydk files.");
  setSourceBadge(null);
});

els.openBtn.addEventListener("click", () => {
  const url = massentryUrl(state.lines);
  if (url.length > URL_SOFT_LIMIT) {
    const ok = confirm(
      "This list makes a very long link, which TCGplayer may truncate.\n\n" +
        "Copying the text and pasting it into Mass Entry is more reliable.\n\n" +
        "Open the link anyway?"
    );
    if (!ok) return;
  }
  window.open(url, "_blank", "noopener");
  setStatus("Opened TCGplayer Mass Entry in a new tab.");
});

refreshFileList();
