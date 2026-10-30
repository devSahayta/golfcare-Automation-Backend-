// app.js

const express = require("express");
const cors = require("cors");
const healthRouter = require("./routes/health");
const userRouter = require("./routes/userRoutes");
const availabilityRouter = require("./routes/availabilityRoutes");
const productDraftRoutes = require("./routes/productDraftRoutes");
const productImportRoutes = require("./routes/productImportRoutes");
const dynamicTemplateRoutes = require("./routes/dynamicTemplateRoutes");
const samvaadikWebhookRouter = require("./webhooks/samvaadik");
const shopifyWebhookRoutes = require("./routes/shopifyWebhookRoutes.js");
const notificationRouter = require("./routes/notificationRoutes.js");

const customerRouter = require("./routes/customerRoutes");
const templateRouter = require("./routes/templateRoutes");
const productRouter = require("./routes/productRoutes");
const supplierRouter = require("./routes/supplierRoutes");
const insightsRouter = require("./routes/insightsRoutes");
const orderRouter = require("./routes/orderRoutes");
const auditLogRouter = require("./routes/auditLogRoutes");
const agentUsageRouter = require("./routes/agentUsageRoutes");
const broadcastCampaignRouter = require("./routes/broadcastCampaignRoutes");
const campaignRouter = require("./routes/campaignRoutes");
const { prisma } = require("./lib/prisma");
const { sendCampaign } = require("./controllers/broadcastCampaignController");

const app = express();

// TEMPORARY DIAGNOSTIC LOGGER — logs every single request this server
// receives, before anything else touches it. Added to find out whether
// Shopify's webhook calls are reaching this server at all. Remove once
// the Shopify order/customer sync issue is confirmed fixed.
app.use((req, res, next) => {
  console.log(`[incoming] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(cors());
app.use("/webhooks/samvaadik", samvaadikWebhookRouter);
app.use("/webhooks/shopify", shopifyWebhookRoutes);
app.use(express.json());
app.use("/health", healthRouter);
app.use("/api/users", userRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/product-drafts", productDraftRoutes);
app.use("/api/product-imports", productImportRoutes);
app.use("/api/dynamic-templates", dynamicTemplateRoutes);

app.use("/api/notifications", notificationRouter);
app.use("/api/customers", customerRouter);
app.use("/api/templates", templateRouter);
app.use("/api/products", productRouter);
app.use("/api/suppliers", supplierRouter);
app.use("/api/insights", insightsRouter);
app.use("/api/orders", orderRouter);
app.use("/api/audit-logs", auditLogRouter);
app.use("/api/agent-usage", agentUsageRouter);
app.use("/api/broadcast-campaigns", broadcastCampaignRouter);
app.use("/api/campaigns", campaignRouter);

app.get("/", (_req, res) => {
  res.json({ service: "Golf Care OS API", status: "running" });
});
const k = process.env.ANTHROPIC_API_KEY;
console.log(
  "[anthropic key]",
  k ? `${k.slice(0, 10)}… len=${k.length}` : "MISSING",
);

module.exports = app;
