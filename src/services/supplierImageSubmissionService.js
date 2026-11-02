// src/services/supplierImageSubmissionService.js
//
// Approve/reject logic for SupplierImageSubmission, shared by the emailed
// approval link (controllers/supplierImageApprovalController.js) — mirrors
// productDraftService.js's approveAndPublish/reject shape exactly, same
// reasoning: the token-lookup/expiry check lives in the controller, this
// file only does the actual decision once a submission is already
// confirmed to be a valid, still-PENDING target.
const { prisma } = require("../lib/prisma");
const { addProductImage } = require("./shopifyProductCreate");

// Approves a submission: pushes its staged Supabase image onto the real
// Shopify product, then records the new URL on Product.imageUrls. Re-checks
// the product still has zero images at approval time (not just at
// submission time) — staff might sit on an email for a while, and another
// submission (or a manual edit) could have added an image in the meantime;
// approving a second image onto a product that already got one defeats the
// whole "only fill genuinely missing images" point of this feature.
async function approveAndPublish(submissionId, { approvedVia }) {
  const submission = await prisma.supplierImageSubmission.findUnique({
    where: { id: submissionId },
    include: { Product: true },
  });
  if (!submission) throw new Error("Submission not found");

  if (submission.Product.imageUrls.length > 0) {
    await prisma.supplierImageSubmission.update({
      where: { id: submissionId },
      data: { status: "REJECTED", decidedAt: new Date(), decidedVia: approvedVia },
    });
    throw new Error(
      "This product already has an image (added since this photo was submitted) — submission auto-rejected instead of adding a second image.",
    );
  }

  await addProductImage(submission.Product.shopifyProductId, submission.imageUrl);

  await prisma.product.update({
    where: { id: submission.productId },
    data: { imageUrls: { push: submission.imageUrl } },
  });

  await prisma.supplierImageSubmission.update({
    where: { id: submissionId },
    data: { status: "APPROVED", decidedAt: new Date(), decidedVia: approvedVia },
  });
}

async function reject(submissionId, { approvedVia }) {
  await prisma.supplierImageSubmission.update({
    where: { id: submissionId },
    data: { status: "REJECTED", decidedAt: new Date(), decidedVia: approvedVia },
  });
}

module.exports = { approveAndPublish, reject };
