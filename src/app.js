// app.js

const express = require("express");
const cors = require("cors");
const healthRouter = require("./routes/health");
const userRouter = require("./routes/userRoutes");
const availabilityRouter = require("./routes/availabilityRoutes");
const productDraftRoutes = require("./routes/productDraftRoutes");
const dynamicTemplateRoutes = require("./routes/dynamicTemplateRoutes");
const samvaadikWebhookRouter = require("./webhooks/samvaadik");
const shopifyWebhookRoutes = require("./routes/shopifyWebhookRoutes.js");
const notificationRouter = require("./routes/notificationRoutes.js");

const customerRouter = require("./routes/customerRoutes");
const templateRouter = require("./routes/templateRoutes");
const productRouter = require("./routes/productRoutes");
const supplierRouter = require("./routes/supplierRoutes");
const insightsRouter = require("./routes/insightsRoutes");

const app = express();
app.use(cors());
app.use("/webhooks/samvaadik", samvaadikWebhookRouter);
app.use("/webhooks/shopify", shopifyWebhookRoutes);
app.use(express.json());
app.use("/health", healthRouter);
app.use("/api/users", userRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/product-drafts", productDraftRoutes);
app.use("/api/dynamic-templates", dynamicTemplateRoutes);

app.use("/api/notifications", notificationRouter);
app.use("/api/customers", customerRouter);
app.use("/api/templates", templateRouter);
app.use("/api/products", productRouter);
app.use("/api/suppliers", supplierRouter);
app.use("/api/insights", insightsRouter);

app.get("/", (_req, res) => {
  res.json({ service: "Golf Care OS API", status: "running" });
});

module.exports = app;
