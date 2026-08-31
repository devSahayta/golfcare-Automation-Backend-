// src/lib/samvaadik/client.js
//
// Duplicated from golfcare-scheduler/src/lib/samvaadik/client.js — same
// cross-repo constraint as shopifyInventory.js (separate deployables,
// can't require() across repos). Adapted to golfcare-backend's env.js
// pattern instead of raw process.env; logic and error-wrapping unchanged
// from the proven scheduler version.

const axios = require("axios");
const { env } = require("../../config/env");

function getClient() {
  if (!env.samvaadik.baseUrl) {
    throw new Error(
      "Missing SAMVAADIK_API_BASE_URL env var in golfcare-backend.",
    );
  }
  if (!env.samvaadik.apiKey) {
    throw new Error("Missing SAMVAADIK_API_KEY env var in golfcare-backend.");
  }

  return axios.create({
    baseURL: `${env.samvaadik.baseUrl.replace(/\/$/, "")}/v1`,
    headers: {
      "X-API-Key": env.samvaadik.apiKey,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

/**
 * Wraps a Samvaadik API call so failures carry Samvaadik's actual error
 * body, not just a generic axios message.
 */
async function callSamvaadik(fn) {
  try {
    return await fn(getClient());
  } catch (err) {
    const samvaadikError = err.response?.data;
    const status = err.response?.status;
    const detail = samvaadikError
      ? JSON.stringify(samvaadikError)
      : err.message;
    throw new Error(
      `Samvaadik API error${status ? ` (${status})` : ""}: ${detail}`,
    );
  }
}

module.exports = { callSamvaadik };
