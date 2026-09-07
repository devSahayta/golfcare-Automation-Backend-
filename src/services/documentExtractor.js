// src/services/documentExtractor.js
//
// Turns a supplier-sent WhatsApp attachment (PDF or spreadsheet) into
// plain text, so it can become a Message.body and flow through the
// existing agent pipeline unchanged — agentEngine/index.js already builds
// conversation history from Message.body as a flat string, and
// toolLoop.js forwards it to Claude as-is. Doing the extraction once here
// means neither of those files needs to change; the sheet just looks like
// a very long text message to everything downstream.
//
// Detection is by the buffer's own magic bytes, not Samvaadik's
// message_type field — no value that field takes for attachments has
// ever been captured/documented in this codebase, so trusting it would be
// guessing. Supported: PDF (text-layer only — a scanned/photographed PDF
// with no extractable text fails honestly rather than attempting OCR,
// which is out of scope for v1) and modern .xlsx (via exceljs; legacy
// binary .xls is not supported — a different format entirely). Anything
// else falls back to a plain/CSV-ish text decode.

// PDF text extraction uses pdfjs-dist directly (Mozilla's own engine,
// actively maintained), not the pdf-parse wrapper package — two real
// problems ruled that out. pdf-parse v2 wraps pdfjs-dist but adds PDF
// *rendering* features (screenshots, image extraction) that try to set
// up browser-canvas polyfills (DOMMatrix etc, via the optional native
// package @napi-rs/canvas) the moment the module loads, regardless of
// whether those features are used — that native package isn't available
// on Vercel's serverless runtime, so the polyfill setup fails and
// pdf-parse's own code then references DOMMatrix anyway: an uncaught
// ReferenceError that crashed the entire process at startup (confirmed
// via real deploy logs), not just PDF handling, since this module sits
// in the app's main require chain. Falling back to pdf-parse v1 avoids
// that crash but bundles a vendored pdf.js from 2017 that fails to parse
// real-world PDFs with a slightly non-standard XRef table (confirmed:
// "bad XRef entry" on an actual supplier PDF that works fine elsewhere).
// pdfjs-dist's own "legacy" Node build (ESM-only, hence the dynamic
// import) has neither problem — used here for text extraction only, no
// rendering/canvas APIs touched at all.
const ExcelJS = require("exceljs");
const { env } = require("../config/env");

// pdfjs-dist's own Node-environment setup (not pdf-parse — that's already
// gone) tries to require("@napi-rs/canvas") at import time, purely to
// polyfill globalThis.DOMMatrix/Path2D and to build a NodeCanvasFactory
// used only for page *rendering*. We never render pages here (text-only
// extraction via getTextContent()), so the canvas package is never
// actually needed — but on Vercel's Linux runtime the optional native
// binary isn't installed, and pdfjs-dist logs a scary warning (harmless,
// but noisy, and the failed require is the same crash class that broke
// pdf-parse before). Defining minimal stub globals ourselves — the same
// guard pdfjs-dist itself checks (`if (!globalThis.DOMMatrix)`) — makes
// pdfjs-dist skip the require entirely, on every platform, without
// depending on any native binary being present at all. Verified: full
// text extraction on a real supplier PDF is byte-identical with or
// without the real @napi-rs/canvas installed once this stub is in place.
function ensureCanvasStubGlobals() {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {};
  }
  if (typeof globalThis.Path2D === "undefined") {
    globalThis.Path2D = class Path2D {};
  }
}

// The real production failure (confirmed via live Vercel deploy logs and
// the Message rows it wrote to the database — "Setting up fake worker
// failed: Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'
// imported from .../pdf.mjs"): pdfjs-dist locates its own worker script
// internally via a dynamic, relative-to-itself import that Vercel's build
// tracer (@vercel/nft, which decides which node_modules files get
// included in the deployed function bundle) can't follow statically, so
// pdf.worker.mjs silently isn't included in the deployed bundle even
// though pdf.mjs is — file present locally, missing in prod, hence this
// only ever surfaced on Vercel. This is why local testing and even some
// earlier Vercel deploys succeeded (nft's tracing isn't fully
// deterministic build to build) while later ones failed with the exact
// same code. Fix: resolve the worker file ourselves via require.resolve()
// with a literal string — nft *does* trace plain require.resolve() calls
// — and hand pdfjs-dist that exact path via GlobalWorkerOptions.workerSrc,
// so it never has to guess its own location at runtime.
//
// pdfjs-dist loads workerSrc via a raw dynamic import(), which requires a
// proper URL, not a bare OS path — a POSIX absolute path happens to work,
// but a Windows one doesn't (its drive letter, e.g. "C:\\...", is parsed
// as a URL scheme and rejected: confirmed locally, "Received protocol
// 'c:'"). pathToFileURL() produces a valid file:// URL on every platform.
function getWorkerSrc() {
  const { pathToFileURL } = require("url");
  return pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    ensureCanvasStubGlobals();
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = getWorkerSrc();
      return lib;
    });
  }
  return pdfjsLibPromise;
}

let standardFontDataUrl = null;
function getStandardFontDataUrl() {
  // Best-effort only — this just silences a benign "provide
  // standardFontDataUrl" warning pdfjs-dist logs when a PDF references a
  // standard (non-embedded) font; extraction already works without it.
  if (standardFontDataUrl === null) {
    try {
      const path = require("path");
      standardFontDataUrl =
        path.join(require.resolve("pdfjs-dist/package.json"), "..", "standard_fonts") + "/";
    } catch {
      standardFontDataUrl = undefined;
    }
  }
  return standardFontDataUrl;
}

async function extractPdfText(buffer) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: getStandardFontDataUrl(),
  });
  try {
    const doc = await loadingTask.promise;
    const pageTexts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(" "));
    }
    return pageTexts.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

function detectFormat(buffer) {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF") {
    return "pdf";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return "xlsx"; // zip signature — .xlsx is a zip archive under the hood
  }
  // Module 5.2 — a supplier's product photo needs to be recognized (and
  // NOT run through the text fallback, which would correctly-but-
  // unhelpfully reject it as unreadable). Nothing to extract from an
  // image as text; the caller keeps using Message.mediaUrl directly.
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image"; // JPEG
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image"; // PNG
  }
  return "text";
}

function cellToText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.richText) return value.richText.map((r) => r.text).join("");
    if (value.text != null) return String(value.text); // hyperlink cell
    if (value.result != null) return String(value.result); // formula cell
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return "";
  }
  return String(value);
}

async function extractXlsxText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return "";

  const lines = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    lines.push(cells.map(cellToText).join(" | "));
  });
  return lines.join("\n");
}

// Deliberately not a regex-based CSV parser (avoids any ReDoS surface on
// untrusted input) — a small linear-time character scan instead. Good
// enough for turning a supplier's export into readable text; this is not
// a round-trippable CSV writer, just a text-extraction step for an LLM to
// read, so minor fidelity loss on unusual quoting is an acceptable
// tradeoff (the agent asks for clarification on anything ambiguous
// anyway).
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function extractDelimitedText(buffer) {
  const raw = buffer.toString("utf8");
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => (line.includes(",") ? parseCsvLine(line).join(" | ") : line))
    .join("\n");
}

// Guards the plain/CSV fallback path against binary garbage decoding to a
// non-empty but meaningless string (control characters, invalid-UTF-8
// replacement characters) — that would otherwise pass the plain `!text`
// check and get fed into the model's context as if it were real content.
function looksLikeText(str) {
  if (!str) return false;
  let badChars = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !isAllowedWhitespace) || code === 0xfffd) badChars++;
  }
  return badChars / str.length < 0.05;
}

function finalize(text, format) {
  const max = env.documentExtractMaxChars;
  if (text.length > max) {
    return {
      ok: true,
      format,
      text: `${text.slice(0, max)}\n\n[...truncated — the attachment was longer than the ${max}-character extraction limit...]`,
      truncated: true,
    };
  }
  return { ok: true, format, text, truncated: false };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ok: true, format: string, text: string, truncated: boolean} | {ok: false, reason: string}>}
 */
async function extractTextFromDocument(buffer) {
  const format = detectFormat(buffer);

  try {
    if (format === "pdf") {
      const text = (await extractPdfText(buffer)).trim();
      if (!text) return { ok: false, reason: "pdf_has_no_extractable_text" };
      return finalize(text, "pdf");
    }

    if (format === "image") {
      // Nothing to extract — the caller (webhooks/samvaadik.js) uses
      // Message.mediaUrl directly for images (already stored
      // unconditionally), this just signals "don't try to read this as
      // text" and "don't treat it as a failed extraction" at once.
      return { ok: true, format: "image", text: "", truncated: false };
    }

    if (format === "xlsx") {
      const text = (await extractXlsxText(buffer)).trim();
      if (!text) return { ok: false, reason: "spreadsheet_appears_empty" };
      return finalize(text, "xlsx");
    }

    const text = extractDelimitedText(buffer).trim();
    if (!text || !looksLikeText(text)) {
      return { ok: false, reason: "unreadable_attachment" };
    }
    return finalize(text, "text");
  } catch (err) {
    return { ok: false, reason: `extraction_error: ${err.message}` };
  }
}

module.exports = { extractTextFromDocument };
