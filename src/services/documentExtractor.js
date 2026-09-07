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

const { PDFParse } = require("pdf-parse");
const ExcelJS = require("exceljs");
const { env } = require("../config/env");

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
      // pdf-parse v2 rewrote the whole API (class-based instead of a
      // plain function) — this broke silently until traced through a
      // real supplier-sent PDF: `npm install pdf-parse` with no version
      // pin pulled v2.4.5, not the v1.x function-call API this was
      // originally written against.
      const parser = new PDFParse({ data: buffer });
      let text;
      try {
        const result = await parser.getText();
        text = (result.text || "").trim();
      } finally {
        await parser.destroy();
      }
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
