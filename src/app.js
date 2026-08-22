const express = require("express");
const cors = require("cors");
const healthRouter = require("./routes/health");
const samvaadikWebhookRouter = require("./webhooks/samvaadik");

const app = express();
app.use(cors());
app.use("/webhooks/samvaadik", samvaadikWebhookRouter);
app.use(express.json());
app.use("/health", healthRouter);

module.exports = app;
