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
 * @returns {Promise<{finalText: string|null, toolCallLog: Array, hitIterationCap: boolean, stopReason: string, usage: {inputTokens: number, outputTokens: number}}>}
 *   `usage` is the REAL token count summed across every Anthropic API call this
 *   invocation made (every loop iteration is a separate billed call) — not an
 *   estimate. Use it to compute exact per-conversation cost.
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

  // Real token usage, accumulated across every Anthropic call this loop
  // makes (every iteration is a separate billed API call — see the
  // per-iteration timing logs below). This is the ACTUAL data
  // response.usage gives back on every call, not an estimate — summing
  // it here is what lets a caller compute real, exact per-conversation
  // cost afterward instead of guessing from typical token counts.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (true) {
    iterations += 1;
    if (iterations > maxIterations) {
      return {
        finalText: null,
        toolCallLog,
        hitIterationCap: true,
        stopReason: "max_iterations",
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
      };
    }

    // Timing — diagnostic only, doesn't change any behavior. Added so
    // slow turns (customers have seen replies take 20-30+ seconds even
    // when the message reached the server promptly) can actually be
    // traced to a specific cause — Anthropic API latency vs. tool
    // handler latency (DB/Shopify calls) vs. genuinely needing many
    // sequential iterations — instead of only knowing the total elapsed
    // time after the fact with no visibility into which part was slow.
    const apiCallStartedAt = Date.now();
    const response = await anthropic.messages.create({
      model: env.anthropicModel,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });
    console.log(
      `[toolLoop] iteration ${iterations}: anthropic.messages.create took ${Date.now() - apiCallStartedAt}ms`,
    );

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;
    console.log(
      `[toolLoop] iteration ${iterations}: input_tokens=${response.usage?.input_tokens ?? "n/a"} output_tokens=${response.usage?.output_tokens ?? "n/a"} (running total: ${totalInputTokens} in / ${totalOutputTokens} out)`,
    );

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // Server tools (web_search, web_fetch) are executed by Anthropic, not
    // us — they never appear as `tool_use` blocks (see server_tool_use /
    // *_tool_result below), so toolHandlers never sees them and they'd
    // otherwise be completely invisible in Message.toolCalls, making it
    // impossible to tell from our own logs whether a search actually ran.
    // Logged here, read-only — nothing to execute, nothing pushed back.
    response.content
      .filter((b) => b.type === "server_tool_use")
      .forEach((b) =>
        toolCallLog.push({ tool: b.name, input: b.input, server: true }),
      );
    response.content
      .filter(
        (b) => b.type.endsWith("_tool_result") && b.type !== "tool_result",
      )
      .forEach((b) =>
        toolCallLog.push({
          tool: b.type,
          output: Array.isArray(b.content) ? b.content.slice(0, 5) : b.content,
          server: true,
        }),
      );

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
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
      };
    }

    messages.push({ role: "assistant", content: response.content });

    // UPDATED: same-turn tool calls now run CONCURRENTLY instead of one
    // at a time. Previously this was a sequential `for...await` loop —
    // when Claude requested multiple independent tool calls in a single
    // response (it does this; e.g. two search_products calls with
    // different query phrasings have been observed in the same turn's
    // toolCalls array), each one waited for the previous one to fully
    // finish before starting, even though they don't depend on each
    // other's results. Anthropic's tool-use protocol is explicitly
    // designed for this: multiple tool_use blocks in one response are
    // meant to be executed independently and matched back up by
    // tool_use_id, which is exactly what's happening below — order of
    // execution doesn't matter, only that toolResults ends up containing
    // one entry per block with the right tool_use_id.
    //
    // Per-call error handling is preserved exactly as before (each call
    // still catches its own error and turns it into an {error: ...}
    // output rather than rejecting the whole batch) — Promise.all here is
    // safe because every mapped promise already resolves (never rejects)
    // thanks to that internal try/catch, so one failing tool call can't
    // take down the others or throw past this Promise.all.
    //
    // toolCallLog push order is preserved as the original block order
    // (not finish order) by pushing inside the same per-block async
    // function and relying on Promise.all's guaranteed result ordering —
    // log entries and toolResults stay in the same order they would have
    // been in with the old sequential loop, so nothing downstream
    // (guardrails, logger, UI) needs to change.
    const toolStartedAt = Date.now();
    const perBlockResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const handler = toolHandlers[block.name];
        const singleCallStartedAt = Date.now();
        let output;
        try {
          output = handler
            ? await handler(block.input)
            : { error: `Unknown tool: ${block.name}` };
        } catch (err) {
          output = { error: err.message || String(err) };
        }
        console.log(
          `[toolLoop] iteration ${iterations}: tool "${block.name}" took ${Date.now() - singleCallStartedAt}ms`,
        );
        return {
          logEntry: { tool: block.name, input: block.input, output },
          resultEntry: {
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(output),
          },
        };
      }),
    );
    console.log(
      `[toolLoop] iteration ${iterations}: ${toolUseBlocks.length} tool call(s) took ${Date.now() - toolStartedAt}ms total (parallel)`,
    );

    const toolResults = [];
    for (const { logEntry, resultEntry } of perBlockResults) {
      toolCallLog.push(logEntry);
      toolResults.push(resultEntry);
    }

    messages.push({ role: "user", content: toolResults });
  }
}

module.exports = { runToolLoop };
