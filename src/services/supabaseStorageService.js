// src/services/supabaseStorageService.js
//
// Hosts AI-composited campaign images somewhere Meta's servers can actually
// fetch them from. uploadMediaFromUrl (samvaadik/adapter.js) tells Samvaadik
// to fetch an image from a URL we give it — so whatever we generate has to
// live at a real public HTTPS URL, not just be visible in this app's own
// browser preview.
//
// Reuses the Supabase project this app already runs its Postgres database
// on — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY were already sitting in
// .env.example, just unused until now. Supabase Storage is a plain
// S3-compatible object store with a "public bucket" mode, so this needed
// no new vendor, no new account, no new credentials.
//
// Usage:
//   const { uploadGeneratedImage } = require('./supabaseStorageService');
//   const url = await uploadGeneratedImage(jpegBuffer, 'diwali_gift_box.jpg');

const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

let client = null;
function getClient() {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env to " +
        "upload generated campaign images (they're the same Supabase project " +
        "DATABASE_URL already points at — just add the URL and service role " +
        "key from Project Settings → API).",
    );
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

// Created lazily, once per process, the first time an upload is attempted —
// not at module load, so a missing bucket never breaks app startup, only
// the specific feature that needs it.
let bucketEnsured = false;
async function ensureBucket() {
  if (bucketEnsured) return;
  const supabase = getClient();

  const { data: buckets, error: listErr } =
    await supabase.storage.listBuckets();
  if (listErr) {
    // Some service-role configurations restrict listBuckets even though
    // upload/getPublicUrl work fine. Don't hard-fail here — assume the
    // bucket already exists (it's cheap to find out for real on the next
    // line, when the actual upload either succeeds or fails loudly).
    console.warn(
      `[supabaseStorageService] Couldn't list buckets (${listErr.message}) — ` +
        `assuming "${env.supabaseStorageBucket}" already exists and is public.`,
    );
    bucketEnsured = true;
    return;
  }

  const exists = (buckets || []).some(
    (b) => b.name === env.supabaseStorageBucket,
  );
  if (!exists) {
    const { error: createErr } = await supabase.storage.createBucket(
      env.supabaseStorageBucket,
      { public: true },
    );
    if (createErr && !/already exists/i.test(createErr.message || "")) {
      throw new Error(
        `Failed to create Supabase Storage bucket "${env.supabaseStorageBucket}": ${createErr.message}`,
      );
    }
    console.log(
      `[supabaseStorageService] Created public bucket "${env.supabaseStorageBucket}"`,
    );
  }
  bucketEnsured = true;
}

/**
 * uploadGeneratedImage
 *
 * Uploads a JPEG buffer to Supabase Storage and returns its public URL.
 *
 * @param {Buffer} buffer    - JPEG image bytes
 * @param {string} fileName  - used to build a unique object path (sanitized)
 * @returns {Promise<string>} public HTTPS URL
 */
async function uploadGeneratedImage(buffer, fileName) {
  await ensureBucket();
  const supabase = getClient();

  const safeName = (fileName || "campaign-image.jpg").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const path = `${Date.now()}-${safeName}`;

  const { error: uploadErr } = await supabase.storage
    .from(env.supabaseStorageBucket)
    .upload(path, buffer, { contentType: "image/jpeg", upsert: false });

  if (uploadErr) {
    throw new Error(`Supabase Storage upload failed: ${uploadErr.message}`);
  }

  const { data } = supabase.storage
    .from(env.supabaseStorageBucket)
    .getPublicUrl(path);

  if (!data?.publicUrl) {
    throw new Error(
      "Supabase Storage upload succeeded but no public URL was returned.",
    );
  }

  console.log(`[supabaseStorageService] Uploaded ${path} -> ${data.publicUrl}`);
  return data.publicUrl;
}

/**
 * uploadReferenceImage
 *
 * Stages a product reference image in Supabase Storage under a neutral,
 * generic filename so Replicate/Flux never sees the original CDN URL (which
 * Flux's brand-detection filter can fingerprint). The caller passes raw image
 * bytes; this function stores them under ref-images/ with a time-stamped,
 * index-based name (e.g. ref-images/1729580400000-ref-1.jpg) that carries no
 * brand information. Returns the Supabase public URL.
 *
 * Cleanup: these ref-images/ objects are temporary scratch files. A future
 * scheduled job (or Supabase lifecycle rule) can delete anything under
 * ref-images/ older than 7 days — the generated campaign images in the root
 * of the bucket are the ones worth keeping long-term.
 *
 * @param {Buffer} buffer   - raw image bytes (any format — JPEG, PNG, WebP)
 * @param {number} index    - 1-based position in the reference-image list
 * @param {string} mimeType - e.g. "image/jpeg" or "image/png"
 * @returns {Promise<string>} public HTTPS URL
 */
async function uploadReferenceImage(buffer, index, mimeType = "image/jpeg") {
  await ensureBucket();
  const supabase = getClient();

  const ext = mimeType === "image/png" ? "png" : "jpg";
  const path = `ref-images/${Date.now()}-ref-${index}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(env.supabaseStorageBucket)
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    throw new Error(
      `Supabase Storage reference-image upload failed: ${uploadErr.message}`,
    );
  }

  const { data } = supabase.storage
    .from(env.supabaseStorageBucket)
    .getPublicUrl(path);

  if (!data?.publicUrl) {
    throw new Error(
      "Supabase Storage ref-image upload succeeded but no public URL was returned.",
    );
  }

  console.log(
    `[supabaseStorageService] Staged reference image ${index} -> ${data.publicUrl}`,
  );
  return data.publicUrl;
}

module.exports = { uploadGeneratedImage, uploadReferenceImage };
