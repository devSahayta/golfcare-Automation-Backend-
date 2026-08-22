const { Router } = require("express");
const express = require("express");

const router = Router();

router.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  // TODO (Module 1): verify signature, parse via samvaadikAdapter.parseWebhook(),
  // persist to Conversation/Message, respond 200 immediately, process async.
  res.status(200).send("ok");
});

module.exports = router;
