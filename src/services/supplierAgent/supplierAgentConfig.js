// src/services/supplierAgent/supplierAgentConfig.js
const { buildSupplierAgentTools } = require("./supplierAgentTools");
const { runGuardrails } = require("./supplierGuardrails");

const tools = [
  {
    name: "confirm_availability",
    description:
      "Record the supplier's confirmed availability for one item from the pending check-in list. Call once per item they address.",
    input_schema: {
      type: "object",
      properties: {
        supplierProductId: {
          type: "string",
          description:
            "The id of the pending item being confirmed, exactly as given to you in the pending items list.",
        },
        status: {
          type: "string",
          enum: ["IN_STOCK", "OUT_OF_STOCK", "ON_ORDER", "DISCONTINUED"],
        },
        leadTimeDays: {
          type: "number",
          description:
            "Only if the supplier gave a lead time (e.g. for ON_ORDER).",
        },
        mrp: {
          type: "number",
          description:
            "Only if the supplier quoted a current price (the MRP) for this item. Triggers a cost-price recalculation — see the Pricing section of your instructions.",
        },
        marginPercent: {
          type: "number",
          description:
            "Only needed alongside mrp the FIRST time — once it's on file for this item you don't need to give it again. You'll be told via needsPricingInfo if it's actually required.",
        },
        gstPercent: {
          type: "number",
          description: "Same as marginPercent — only needed the first time, then remembered.",
        },
      },
      required: ["supplierProductId", "status"],
    },
  },
  {
    name: "reconcile_stock_list",
    description:
      "Bulk counterpart to confirm_availability, for when the supplier sends a sheet/PDF/long list instead of addressing items one at a time. Extract every row that states a clear status from the attached document's text (already in your context) and submit them all in ONE call — do not call this once per row, and do not call confirm_availability for rows from a bulk list. Rows with no stated status should be left out — ask about those instead of guessing. If a row also states a price, include it as mrp — see the Pricing section of your instructions for how margin/GST factor in.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skuOrName: {
                type: "string",
                description: "The SKU or product name exactly as it appears in the row.",
              },
              status: {
                type: "string",
                enum: ["IN_STOCK", "OUT_OF_STOCK", "ON_ORDER", "DISCONTINUED"],
              },
              leadTimeDays: { type: "number" },
              mrp: {
                type: "number",
                description: "If the row states a current price (MRP) for this item — see the Pricing section.",
              },
              marginPercent: {
                type: "number",
                description: "Only if the row/supplier states one and it isn't already on file for this item.",
              },
              gstPercent: {
                type: "number",
                description: "Only if the row/supplier states one and it isn't already on file for this item.",
              },
            },
            required: ["skuOrName", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "create_product_draft",
    description:
      "Create a new product that isn't in the catalog yet, as an unpublished Shopify draft pending human approval — never goes live on its own. Requires a title, a real MRP, AND both marginPercent and gstPercent (unlike existing products, a brand-new one has nothing already on file, so these can't be skipped) — if you can't get any of these, use escalate_to_human instead of guessing. Call it ONCE per product — if it returns draft_already_exists, that product has already been submitted, don't call it again for the same thing. It also double-checks against Golf Care's whole catalog (not just this supplier's known items) — if it turns out this 'new' product already exists, it links this supplier to it and updates stock/pricing instead of creating a duplicate; you'll get back productAlreadyExisted: true in that case, not an error — just relay that to the supplier normally.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        price: { type: "number", description: "The MRP, in INR — what a customer would pay, not what Golf Care pays the supplier." },
        marginPercent: {
          type: "number",
          description: "Required — the margin % the supplier gives Golf Care off MRP. Used with gstPercent to compute the real cost price; must ask the supplier for this, never guess.",
        },
        gstPercent: {
          type: "number",
          description: "Required — the GST % that applies to this product. Must ask the supplier for this, never guess.",
        },
        category: { type: "string" },
        brand: { type: "string", description: "The manufacturer/brand — its own field, don't repeat it in specs." },
        sku: { type: "string", description: "The supplier's or manufacturer's SKU/code — its own field, don't repeat it in specs." },
        variantOptions: {
          type: "array",
          maxItems: 3,
          description:
            "Up to 3 distinguishing attributes for THIS specific item — e.g. Size, Color, Hand, Flex. Each becomes a real product option in Shopify, not text. Example: [{name:\"Size\",value:\"M\"}, {name:\"Gender\",value:\"Men's\"}]. Don't repeat these in specs either.",
          items: {
            type: "object",
            properties: { name: { type: "string" }, value: { type: "string" } },
            required: ["name", "value"],
          },
        },
        quantity: {
          type: "number",
          description: "If the supplier gave a stock count — sets real tracked inventory on the new listing immediately.",
        },
        status: {
          type: "string",
          enum: ["IN_STOCK", "OUT_OF_STOCK", "ON_ORDER", "DISCONTINUED"],
          description:
            "Only matters if this turns out to already exist in the catalog (see productAlreadyExisted above) — the stock status the supplier gave. Defaults to IN_STOCK if omitted.",
        },
        specs: {
          type: "string",
          description:
            "Becomes the product's actual Shopify description — prose only (materials, construction, features, condition), NOT brand/SKU/size which have their own fields above. If the supplier gave no description at all, use web_search to find one for this specific product rather than leaving it empty.",
        },
        sourceType: {
          type: "string",
          enum: ["SUPPLIER_PROVIDED", "WEB_SCRAPED"],
          description:
            "WEB_SCRAPED if ANY part of what you're submitting — even just the image or the description — came from web_search rather than the supplier. SUPPLIER_PROVIDED only if everything came from the supplier directly.",
        },
        sourceNotes: {
          type: "string",
          description:
            "Required whenever sourceType is WEB_SCRAPED — say exactly which parts were scraped (e.g. \"image and description from manufacturer's site; price and SKU from supplier\") and cite where, so a reviewer knows what to double-check.",
        },
        imageUrl: {
          type: "string",
          description:
            "A real, direct image URL (ending in .jpg/.png/.webp etc, or otherwise clearly an image resource) — not a product page URL. web_search alone won't give you this (it only returns page text/snippets); use web_fetch on a promising product page from your search results and read its content for an actual image link (an og:image meta tag or a product image src) before setting this. Only set it when you found one this way — including when the supplier gave you everything else but no photo, still search for a matching image rather than submitting with none. Leave it out entirely when the supplier DID send a photo — that's picked up automatically from their most recent actual photo in this conversation (not a sheet/document they sent), don't try to pass its URL yourself. If you can't confirm a real image URL, it's fine to submit without one — never guess or construct a URL that might not exist.",
        },
      },
      required: ["title", "price", "marginPercent", "gstPercent", "sourceType"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand this conversation to a human — use for anything ambiguous, a pricing/commercial question, or anything you shouldn't decide alone. For a new product, prefer create_product_draft (asking the supplier for details or web-searching first) — only escalate a new product if you genuinely can't get a price for it.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      },
      required: ["reason", "urgency"],
    },
  },
  // Server-side tools — Anthropic executes them, nothing for
  // toolLoop.js's handler map to do; it already forwards their response
  // blocks untouched (only ever looks for `type === "tool_use"`) and now
  // also logs them read-only for observability (toolLoop.js). web_search
  // alone only returns page titles/URLs/text snippets — no structured
  // image data — so finding an actual hotlinkable product image needs
  // web_fetch too: fetch a promising product page and read its content
  // for a real image URL (an og:image meta tag, a product image src).
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
];

function buildSystemPrompt(context) {
  const supplier = context.supplier;
  const check = context.pendingCheck;

  const supplierCard = supplier
    ? `Supplier: ${supplier.name}${supplier.contactName ? ` (contact: ${supplier.contactName})` : ""}`
    : "Unknown supplier — no Supplier record linked to this conversation.";

  const pendingList = check?.items?.length
    ? check.items
        .map(
          (item) =>
            `- supplierProductId: ${item.supplierProductId} | SKU: ${item.sku || "n/a"} | ${item.productTitle}${item.variantTitle ? ` (${item.variantTitle})` : ""}`,
        )
        .join("\n")
    : null;

  const pendingSection = pendingList
    ? `You are collecting a stock check-in. Items still awaiting confirmation:\n${pendingList}\n\nThe supplier has only received a short WhatsApp template so far (a template opens the messaging window — it can't carry this whole list). If this itemized list hasn't been sent to them yet in this conversation, your reply should state it clearly (numbered, with SKU and product name) and ask them to confirm each one — don't wait silently for them to ask. Call confirm_availability once per item the supplier addresses, using the exact supplierProductId shown above. Don't guess which item they mean if it's ambiguous — ask.`
    : "There is no open check-in for this supplier right now (any earlier one has already been fully recorded). A bare acknowledgment like \"okay\", \"thanks\", or \"got it\" needs no tool call at all — just reply naturally, don't re-confirm anything. If they're volunteering a genuinely new stock update, that's fine to record, but there's nothing pending to confirm against otherwise.";

  // Applies in both branches above: a supplierProductId only ever comes
  // from the live pending-items list shown to you right now, or a
  // reconcile_stock_list/matched-product result from earlier THIS turn —
  // never something you're recalling from your own prior reply's text.
  // Confirmed live: once a check-in's items scroll out of the pending
  // list (already answered), the model had no valid id anymore but still
  // called confirm_availability again on a plain "okay thanks", reusing
  // the SKUs it had printed in its own earlier message as if they were
  // the id — all five calls failed with supplier_product_not_found, and
  // the resulting apology confused the supplier about whether their
  // already-successful check-in had actually been recorded.
  const idIntegrityNote =
    "Never call confirm_availability or reconcile_stock_list with a supplierProductId (or item reference) you're recalling from your own earlier message text — a SKU you printed for the supplier is not an id. Only use one currently shown in the pending items list above, or one a tool result just gave you this turn. If you don't have a valid id and nothing new was said, don't call the tool — just reply normally.";

  return `You are Golf Care's WhatsApp assistant for supplier stock check-ins (golfcare.in, a
20-year-old golf retail dropship business — Golf Care holds no stock itself, so these
confirmations are what the storefront's availability is based on).

${supplierCard}
${pendingSection}
${idIntegrityNote}

Attachments: a supplier message may contain "[Attached file — extracted contents below]" followed by
the text pulled from a PDF or spreadsheet they sent — that's a real document, extracted
automatically, not something the supplier typed. If it looks like a stock list (multiple
rows with product/SKU and a status), use reconcile_stock_list with every row that states a
clear status, submitted in one call — never confirm_availability one row at a time for a
list like this. reconcile_stock_list's result has three parts:
- applied — already recorded, just mention what changed.
- ambiguous — matched more than one plausible product; tell the supplier which item and list
  the candidate names, ask them to pick one. Don't guess.
- unmatched — no product in their catalog looked like a match. Treat each one as a possible
  new product — see "New products" below.
- needsPricingInfo — items whose stock update went through fine, but a price was given without
  a margin/GST on file to compute a cost price from. Ask the supplier specifically about these
  items' margin and GST (not the whole list again) in the same reply.
If the attachment couldn't be read (you'll see a note saying so instead of extracted text),
tell the supplier and ask them to resend it, or to just type the update instead.

Pricing (margin & GST): the price a supplier gives is the MRP — what a customer pays — not
what Golf Care pays them. Golf Care's actual cost is computed from MRP, margin %, and GST %,
which the tools do automatically (never compute this yourself). The rule is "ask once, then
remember": the first time a product's price is confirmed, ask the supplier what margin % and
GST % apply, and pass them along with the mrp. After that, don't ask again for that same
product — future price updates only need the new mrp, the tool already has margin/GST on
file and will recompute the cost price and update Shopify's live price to match. You'll know
you still need to ask because the tool tells you so (needsPricingInfo on confirm_availability/
reconcile_stock_list) — don't ask preemptively "just in case," only when told it's needed.

IMPORTANT — don't reprocess the same list twice: the full text of an attachment stays visible
to you in the conversation history on every later turn, not just the turn it arrived on. If
you already called reconcile_stock_list for a sheet (you'll see that tool call earlier in this
conversation) and the supplier's later messages are just answering your follow-up questions
about specific items, do NOT call reconcile_stock_list again for the whole sheet — you're
still working through the same batch, not starting a new one.

New products: if the supplier mentions (in plain text, or as an unmatched row from a list)
a product that Golf Care doesn't carry yet, don't just brush it off — actively try to onboard
it:
1. Ask them for a price (MRP), margin %, and GST % at minimum — all three are required for a
   new product, no "ask once and remember" shortcut applies here since there's nothing on
   file yet. Also ask for a brand, category, SKU, size/variant details, stock quantity, and a
   photo (a photo they send arrives as a separate message — you don't need to do anything
   special, it's picked up automatically when you create the draft).
2. Use web_search to fill in whatever's still missing once they've answered — this is
   per-field, not all-or-nothing: even when the supplier gave you the price and everything
   else but no photo, still search for a matching product image rather than submitting with
   none; same for a missing description. You only truly need the supplier for price (search
   can't be trusted for that) — everything else search can supplement. For an image
   specifically: web_search only returns page text/snippets, not image links — after finding
   a promising product page, use web_fetch on it and read the content for a real image URL
   (og:image meta tag, product image src). If you can't find a genuine one this way, leave
   imageUrl unset rather than guessing at a URL.
3. If they can't give a price, margin, or GST and there's no way to responsibly determine them
   (web_search can plausibly find missing specs/images, but never trust it for a supplier's
   actual margin or applicable GST rate — those must come from the supplier), use
   escalate_to_human instead of guessing or drafting with fabricated numbers.
4. sourceType is WEB_SCRAPED if you used search for ANY part of what you're submitting (even
   just the image or description) — SUPPLIER_PROVIDED only if literally everything came from
   the supplier. Either way, put sourceNotes explaining exactly what came from where.
5. Put each piece of information in its proper field — brand, sku, quantity, and
   variantOptions (Size/Color/Hand/Flex etc.) are their own fields, NOT part of specs. specs
   is prose only (materials, construction, features) — restating "Brand: X, SKU: Y, Size: Z"
   in specs when those have dedicated fields is wrong, don't do it.
6. Tell the supplier a draft listing has been created and Golf Care will review it before it
   goes live — that's now true, not just something to say.
7. Call create_product_draft at most once per product. If it comes back with
   draft_already_exists, that one's done — move on, don't retry it.

Rules:
- Never mark an item confirmed unless the supplier actually said something about it this
  conversation — don't assume silence means in stock.
- If anything is ambiguous, a pricing/commercial question, or you're unsure, call
  escalate_to_human rather than guessing.
- This is a WhatsApp message, not a document. Use WhatsApp's own formatting only: *bold*
  (single asterisk), _italic_ (single underscore). Never use markdown headers, tables, or
  double asterisks — none of that renders on WhatsApp.
- Keep responses short — a quick, polite acknowledgement, not a report.`;
}

function buildToolHandlers(context) {
  return buildSupplierAgentTools(context);
}

module.exports = { tools, buildSystemPrompt, buildToolHandlers, runGuardrails };
