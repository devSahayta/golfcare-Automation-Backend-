// scripts/testAgentLocally.js
//
// Runs the Sales Agent against a seeded test conversation. sendFn just
// logs to console instead of calling Samvaadik, so this works without any
// WhatsApp setup and without needing a real customer.
//
// Usage: node scripts/testAgentLocally.js "do you have taylormade gloves, size M"

require("dotenv").config();
const { prisma } = require("../src/lib/prisma");
const { runAgent } = require("../src/services/agentEngine");
const salesAgentConfig = require("../src/services/salesAgent/salesAgentConfig");

async function main() {
  const inboundText =
    process.argv[2] || "hi, do you have any TaylorMade gloves?";
  const testPhone = "919999999999";

  let customer = await prisma.customer.findUnique({
    where: { waPhone: testPhone },
  });
  if (!customer) {
    customer = await prisma.customer.create({ data: { waPhone: testPhone } });
    console.log("Created test customer:", customer.id);
  }

  let conversation = await prisma.conversation.findFirst({
    where: { customerId: customer.id, state: "AI_HANDLING" },
    orderBy: { lastMessageAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        customerId: customer.id,
        waPhone: testPhone,
        state: "AI_HANDLING",
        lastMessageAt: new Date(),
      },
    });
    console.log("Created test conversation:", conversation.id);
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      sender: "CUSTOMER",
      type: "text",
      body: inboundText,
    },
  });

  const result = await runAgent({
    conversationId: conversation.id,
    config: salesAgentConfig,
    sendFn: async ({ text }) => {
      console.log(
        "\n=== AGENT WOULD SEND ===\n" + text + "\n========================\n",
      );
    },
  });

  console.log("runAgent result:", JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
