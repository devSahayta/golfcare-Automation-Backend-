// src/services/agentEngine/toolLoop.js
//
// Generic Claude tool-use loop. Nothing here knows about products,
// customers, or WhatsApp — it just runs messages through the Anthropic
// API, executes whatever tools come back via the handler map it's given,
// feeds results back, and repeats until Claude stops asking for tools or
// the iteration cap is hit. Every future agent (Supplier, Lifecycle,
// Insights) reuses this file unchanged.

const Anthropic = require("@anthropic-ai/sdk");
const { env } = require("../../config/env");

const anthropic = new Anthropic({
  apiKey: env.anthropicApiKey,
  // Only needed if ANTHROPIC_API_KEY is an identity-linked Console key
  // rather than a standard workspace key. Leave ANTHROPIC_WORKSPACE_ID
  // unset if you're using a standard key — this header is a no-op then.
  ...(env.anthropicWorkspaceId && {
    defaultHeaders: { "anthropic-workspace-id": env.anthropicWorkspaceId },
  }),
});

/**
 * @param {object} input
 * @param {string} input.systemPrompt
 * @param {Array} input.tools - Anthropic tool schema array
 * @param {Object.<string, Function>} input.toolHandlers - name -> async (input) => output
 * @param {Array} input.history - [{role: "user"|"assistant", content: string}]
 * @param {number} input.maxIterations
 */
async function runToolLoop({
  systemPrompt,
  tools,
  toolHandlers,
  history,
  maxIterations,
}) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const toolCallLog = [];
  let iterations = 0;

  while (true) {
    iterations += 1;
    if (iterations > maxIterations) {
      return {
        finalText: null,
        toolCallLog,
        hitIterationCap: true,
        stopReason: "max_iterations",
      };
    }

    const response = await anthropic.messages.create({
      model: env.anthropicModel,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      const finalText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        finalText,
        toolCallLog,
        hitIterationCap: false,
        stopReason: response.stop_reason,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const handler = toolHandlers[block.name];
      let output;
      try {
        output = handler
          ? await handler(block.input)
          : { error: `Unknown tool: ${block.name}` };
      } catch (err) {
        output = { error: err.message || String(err) };
      }
      toolCallLog.push({ tool: block.name, input: block.input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

module.exports = { runToolLoop };
