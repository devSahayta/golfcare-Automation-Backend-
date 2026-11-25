// src/services/rehostImage.js
//
// Copies a product image found by web research into our own Supabase bucket
// and returns that copy's URL, or null if it can't be fetched or isn't
// really an image. Mirrors the scheduler's src/lib/rehostImage.js
// (separate repo, duplicated on purpose like productCatalogMatch.js).
//
// Why: Shopify downloads an image `src` from its own servers, and several
// brand/retailer sites block that. Confirmed live (Nov 2026): footjoy.com
// answers 403 to non-browser requests ("file not found" in Shopify), so
// 23 of 24 FootJoy drafts got no image though research had found a real
// one. Handing Shopify our own copy fixes every such host, and dead or
// non-image URLs are dropped before they reach a draft.

const axios = require("axios");
const { uploadNewProductImage } = require("./supabaseStorageService");

const MAX_BYTES = 15 * 1024 * 1024;
const MIN_BYTES = 1024;
// Tried in order. Tested live: footjoy.com and titleist.com refuse both
// Node's default User-Agent and a full Chrome one (their bot check spots a
// Chrome identity on a non-Chrome connection) but accept a plain
// "Mozilla/5.0"; the full Chrome one is kept as a fallback for sites that
// want it.
const HEADER_SETS = [
  { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*;q=0.8" },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
  },
];

async function download(url) {
  let lastErr;
  for (const headers of HEADER_SETS) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
        maxContentLength: MAX_BYTES,
        headers,
        validateStatus: (s) => s === 200,
      });
      return Buffer.from(res.data);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function sniffImageMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * @param {string|null} url
 * @param {string} [ownerKey] - goes into the stored path (e.g. supplier id)
 * @returns {Promise<string|null>}
 */
async function rehostImage(url, ownerKey = "web-research") {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (/\.supabase\.co\//i.test(url)) return url;
  try {
    const buf = await download(url);
    const mime = sniffImageMime(buf);
    if (!mime || buf.length < MIN_BYTES) {
      console.warn(`[rehostImage] not a usable image (${buf.length} bytes): ${url}`);
      return null;
    }
    const upload = () => uploadNewProductImage(buf, ownerKey, mime);
    // One retry: a storage upload failed once with no error message during
    // the Nov 2026 image repair and succeeded straight after.
    return await upload().catch(upload);
  } catch (err) {
    console.warn(`[rehostImage] could not fetch ${url}: ${err.response?.status || err.code || err.message}`);
    return null;
  }
}

module.exports = { rehostImage };
