// app.js

const express = require("express");
const cors = require("cors");
const healthRouter = require("./routes/health");
const userRouter = require("./routes/userRoutes");
const samvaadikWebhookRouter = require("./webhooks/samvaadik");
const shopifyWebhookRoutes = require("./routes/shopifyWebhookRoutes.js");

const app = express();
app.use(cors());
app.use("/webhooks/samvaadik", samvaadikWebhookRouter);
app.use("/webhooks/shopify", shopifyWebhookRoutes);
app.use(express.json());
app.use("/health", healthRouter);
app.use("/api/users", userRouter);

app.get("/", (_req, res) => {
  res.json({ service: "Golf Care OS API", status: "running" });
});

module.exports = app;
