import { authenticate } from "../shopify.server";
import db from "../db.server";

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function formatDateForNote(notePrefix) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = String(now.getFullYear()).slice(-2);
  return `${notePrefix} (${month}/${day}/${year})`;
}

function buildReserveUntilIso(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function hasEmployeePurchaseTag(tags = []) {
  return tags.some(
    (tag) => String(tag).trim().toLowerCase() === "employee purchase",
  );
}

function hasEmployeePurchaseNote(note = "", notePrefix = "") {
  return String(note).trim().toLowerCase().startsWith(
    String(notePrefix).trim().toLowerCase(),
  );
}

async function writeAuditLog({
  shop,
  draftOrderId,
  actionStatus,
  message,
  employeeMarkupPercent,
  consignmentCostPercent,
  invoiceSent = false,
  pricingApplied = false,
}) {
  try {
    await db.employeePurchaseAuditLog.create({
      data: {
        shop: shop || "unknown",
        draftOrderId,
        actionStatus,
        message,
        employeeMarkupPercent,
        consignmentCostPercent,
        invoiceSent,
        pricingApplied,
      },
    });
  } catch (auditError) {
    console.error("Failed to write audit log:", auditError);
  }
}

export const loader = async ({ request }) => {
  const { admin, cors, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const draftOrderId = url.searchParams.get("draftOrderId");
  const shop = session?.shop || "unknown";

  if (!draftOrderId) {
    return cors(
      Response.json({ ok: false, error: "Missing draftOrderId" }, { status: 400 }),
    );
  }

  const settings =
    (await db.employeePurchaseSettings.findUnique({ where: { id: 1 } })) ||
    (await db.employeePurchaseSettings.create({
      data: {
        id: 1,
        employeeMarkupPercent: 15,
        consignmentCostPercent: 50,
        reservationDays: 30,
        notePrefix: "Employee Purchase",
        invoiceSubject: "Employee Purchase Invoice",
      },
    }));

  try {
    const noteText = formatDateForNote(settings.notePrefix);
    const reserveInventoryUntil = buildReserveUntilIso(settings.reservationDays);

    const draftResponse = await admin.graphql(
      `#graphql
        query DraftOrderLines($id: ID!) {
          draftOrder(id: $id) {
            id
            name
            note
            tags
            lineItems(first: 50) {
              nodes {
                id
                uuid
                title
                quantity
                variant {
                  id
                  product {
                    tags
                  }
                  inventoryItem {
                    unitCost {
                      amount
                      currencyCode
                    }
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: { id: draftOrderId },
      },
    );

    const draftJson = await draftResponse.json();
    const draftOrder = draftJson.data?.draftOrder;

    if (!draftOrder) {
      await writeAuditLog({
        shop,
        draftOrderId,
        actionStatus: "error",
        message: "Draft order not found.",
        employeeMarkupPercent: settings.employeeMarkupPercent,
        consignmentCostPercent: settings.consignmentCostPercent,
      });

      return cors(
        Response.json({ ok: false, error: "Draft order not found." }, { status: 404 }),
      );
    }

    const alreadyTagged = hasEmployeePurchaseTag(draftOrder.tags);
    const alreadyNoted = hasEmployeePurchaseNote(draftOrder.note, settings.notePrefix);

    if (alreadyTagged || alreadyNoted) {
      const message =
        "Employee pricing was already applied to this draft order. No changes were made.";

      await writeAuditLog({
        shop,
        draftOrderId,
        actionStatus: "skipped",
        message,
        employeeMarkupPercent: settings.employeeMarkupPercent,
        consignmentCostPercent: settings.consignmentCostPercent,
        pricingApplied: false,
      });

      return cors(
        Response.json({
          ok: true,
          skipped: true,
          message,
          noteText: draftOrder.note || null,
          pricingPreview: [],
          settings: {
            employeeMarkupPercent: settings.employeeMarkupPercent,
            consignmentCostPercent: settings.consignmentCostPercent,
            reservationDays: settings.reservationDays,
            invoiceSubject: settings.invoiceSubject,
          },
        }),
      );
    }

    const updatedLineItems = [];
    const pricingPreview = [];

    for (const item of draftOrder.lineItems.nodes) {
      const variantId = item.variant?.id;
      const retail = Number(item.originalUnitPriceSet?.shopMoney?.amount ?? 0);
      const currencyCode =
        item.originalUnitPriceSet?.shopMoney?.currencyCode ?? "USD";
      const quantity = item.quantity;

      if (!variantId) {
        const message = `Line item "${item.title}" is missing a variant ID.`;

        await writeAuditLog({
          shop,
          draftOrderId,
          actionStatus: "error",
          message,
          employeeMarkupPercent: settings.employeeMarkupPercent,
          consignmentCostPercent: settings.consignmentCostPercent,
        });

        return cors(Response.json({ ok: false, error: message }, { status: 400 }));
      }

      const rawUnitCost = item.variant?.inventoryItem?.unitCost?.amount;
      const hasShopifyCost =
        rawUnitCost !== null &&
        rawUnitCost !== undefined &&
        rawUnitCost !== "";

      const productTags = item.variant?.product?.tags ?? [];
      const isConsignment = productTags.some(
        (tag) => String(tag).trim().toLowerCase() === "consignment",
      );

      let baseCost;
      let pricingSource;

      if (hasShopifyCost) {
        baseCost = Number(rawUnitCost);
        pricingSource = "Shopify cost";
      } else if (isConsignment) {
        baseCost = roundMoney(retail * (settings.consignmentCostPercent / 100));
        pricingSource = "Consignment rule";
      } else {
        const message = `Line item "${item.title}" is missing Cost per item and is not tagged consignment.`;

        await writeAuditLog({
          shop,
          draftOrderId,
          actionStatus: "error",
          message,
          employeeMarkupPercent: settings.employeeMarkupPercent,
          consignmentCostPercent: settings.consignmentCostPercent,
        });

        return cors(Response.json({ ok: false, error: message }, { status: 400 }));
      }

      const employeeUnitPrice = roundMoney(
        baseCost * (1 + settings.employeeMarkupPercent / 100),
      );
      const discountAmount = roundMoney(retail - employeeUnitPrice);

      if (discountAmount < 0) {
        const message = `Calculated discount for "${item.title}" is negative.`;

        await writeAuditLog({
          shop,
          draftOrderId,
          actionStatus: "error",
          message,
          employeeMarkupPercent: settings.employeeMarkupPercent,
          consignmentCostPercent: settings.consignmentCostPercent,
        });

        return cors(Response.json({ ok: false, error: message }, { status: 400 }));
      }

      updatedLineItems.push({
        uuid: item.uuid,
        variantId,
        quantity,
        appliedDiscount:
          discountAmount > 0
            ? {
                title: "Employee Discount",
                description: "Employee Discount",
                valueType: "FIXED_AMOUNT",
                value: discountAmount,
                amount: discountAmount,
              }
            : undefined,
      });

      pricingPreview.push({
        title: item.title,
        pricingSource,
        retail,
        costUsed: baseCost,
        employeeUnitPrice,
        discountAmount,
        currencyCode,
      });
    }

    const tagResponse = await admin.graphql(
      `#graphql
        mutation AddEmployeeTag($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              message
            }
          }
        }
      `,
      {
        variables: {
          id: draftOrderId,
          tags: ["Employee Purchase"],
        },
      },
    );

    const tagJson = await tagResponse.json();
    const tagErrors = tagJson.data?.tagsAdd?.userErrors ?? [];

    if (tagErrors.length) {
      const message = tagErrors.map((e) => e.message).join(", ");

      await writeAuditLog({
        shop,
        draftOrderId,
        actionStatus: "error",
        message,
        employeeMarkupPercent: settings.employeeMarkupPercent,
        consignmentCostPercent: settings.consignmentCostPercent,
      });

      return cors(Response.json({ ok: false, error: message }, { status: 400 }));
    }

    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateDraftOrder($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder {
              id
              name
              reserveInventoryUntil
              note
              tags
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          id: draftOrderId,
          input: {
            note: noteText,
            reserveInventoryUntil,
            lineItems: updatedLineItems,
          },
        },
      },
    );

    const updateJson = await updateResponse.json();
    const userErrors = updateJson.data?.draftOrderUpdate?.userErrors ?? [];

    if (userErrors.length) {
      const message = userErrors.map((e) => e.message).join(", ");

      await writeAuditLog({
        shop,
        draftOrderId,
        actionStatus: "error",
        message,
        employeeMarkupPercent: settings.employeeMarkupPercent,
        consignmentCostPercent: settings.consignmentCostPercent,
      });

      return cors(Response.json({ ok: false, error: message }, { status: 400 }));
    }

    const successMessage = "Employee pricing applied successfully.";

    await writeAuditLog({
      shop,
      draftOrderId,
      actionStatus: "applied",
      message: successMessage,
      employeeMarkupPercent: settings.employeeMarkupPercent,
      consignmentCostPercent: settings.consignmentCostPercent,
      pricingApplied: true,
      invoiceSent: false,
    });

    return cors(
      Response.json({
        ok: true,
        skipped: false,
        message: successMessage,
        noteText,
        reserveInventoryUntil,
        pricingPreview,
        settings: {
          employeeMarkupPercent: settings.employeeMarkupPercent,
          consignmentCostPercent: settings.consignmentCostPercent,
          reservationDays: settings.reservationDays,
          invoiceSubject: settings.invoiceSubject,
        },
      }),
    );
  } catch (error) {
    const message = error?.message || "Unknown backend error";

    await writeAuditLog({
      shop,
      draftOrderId,
      actionStatus: "error",
      message,
      employeeMarkupPercent: settings.employeeMarkupPercent,
      consignmentCostPercent: settings.consignmentCostPercent,
    });

    return cors(
      Response.json({ ok: false, error: message }, { status: 500 }),
    );
  }
};