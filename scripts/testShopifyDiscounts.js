// scripts/testShopifyDiscounts.js
//
// DEV STORE ONLY. Creates two REAL, temporary discount codes in your
// Shopify store to prove shopifyDiscounts.js actually works end-to-end
// with your real credentials/scopes, then tells you how to check and
// clean them up. Does not touch your database at all.
//
// Run from the backend repo root:
//   node scripts/testShopifyDiscounts.js

const {
  createStandingMemberDiscountCode,
  createCartDiscountCode,
} = require("../src/services/shopifyDiscounts");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined)
    console.log("  ->", detail?.response?.data || detail?.message || detail);
  process.exitCode = 1;
}

async function main() {
  console.log("=== Shopify discount code test (DEV STORE ONLY) ===\n");

  const testMemberCode = `TESTMEMBER${Date.now().toString().slice(-6)}`;
  try {
    const result = await createStandingMemberDiscountCode({
      memberCode: testMemberCode,
      percentOff: 10,
    });
    pass(
      `standing member code created: ${result.code} (price_rule id ${result.priceRuleId})`,
    );
  } catch (err) {
    fail("standing member code created", err);
  }

  const testCartCode = `TESTCART${Date.now().toString().slice(-6)}`;
  try {
    const result = await createCartDiscountCode({
      code: testCartCode,
      amountOff: 500,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
    });
    pass(
      `cart discount code created: ${result.code} (price_rule id ${result.priceRuleId}), ₹500 off, expires in 2h`,
    );
  } catch (err) {
    fail("cart discount code created", err);
  }

  console.log(
    "\nCheck Shopify Admin -> Discounts to see both test codes " +
      `("${testMemberCode}" and "${testCartCode}"). They're real and ` +
      "usable — delete them from there once you've confirmed they look " +
      "right (or just let the cart one expire in 2h; the member one has " +
      "no expiry, so delete that one manually).",
  );
}

main().catch((err) => {
  console.error("Script crashed:", err?.response?.data || err);
  process.exit(1);
});
