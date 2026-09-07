// src/services/pricingCalculator.js
//
// Pure arithmetic, deliberately kept out of the agent's own reasoning —
// the model supplies MRP/margin/GST as three numbers and reads back a
// result; it never computes the cost price itself. Formula, as given:
// take the supplier's margin off MRP, then add GST on top of that.
//
// costPrice = MRP * (1 - marginPercent/100) * (1 + gstPercent/100)

function computeCostPrice({ mrp, marginPercent, gstPercent }) {
  const afterMargin = mrp * (1 - marginPercent / 100);
  const withGst = afterMargin * (1 + gstPercent / 100);
  return Math.round(withGst * 100) / 100; // round to paise
}

module.exports = { computeCostPrice };
