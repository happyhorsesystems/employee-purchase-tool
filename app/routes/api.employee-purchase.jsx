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

export const loader = async ({ request }) => {
  const { admin, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  const draftOrderId = url.searchParams.get("draftOrderId");

  if (!draftOrderId) {
    return cors(
      Response.json({ ok: false, error: "Missing draftOrderId" }, { status: 400 })
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
      }
    );

    const draftJson = await draftResponse.json();
    const draftOrder = draftJson.data?.draftOrder;

    if (!draftOrder) {
      return cors(
        Response.json({ ok: false, error: "Draft order not found." }, { status: 404 })
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
        return cors(
          Response.json(
            { ok: false, error: `Line item "${item.title}" is missing a variant ID.` },
            { status: 400 }
          )
        );
      }

      const rawUnitCost = item.variant?.inventoryItem?.unitCost?.amount;
      const hasShopifyCost =
        rawUnitCost !== null &&
        rawUnitCost !== undefined &&
        rawUnitCost !== "";

      const productTags = item.variant?.product?.tags ?? [];
      const isConsignment = productTags.some(
        (tag) => String(tag).trim().toLowerCase() === "consignment"
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
        return cors(
          Response.json(
            {
              ok: false,
              error: `Line item "${item.title}" is missing Cost per item and is not tagged consignment.`,
            },
            { status: 400 }
          )
        );
      }

      const employeeUnitPrice = roundMoney(
        baseCost * (1 + settings.employeeMarkupPercent / 100)
      );
      const discountAmount = roundMoney(retail - employeeUnitPrice);

      if (discountAmount < 0) {
        return cors(
          Response.json(
            {
              ok: false,
              error: `Calculated discount for "${item.title}" is negative.`,
            },
            { status: 400 }
          )
        );
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

    await admin.graphql(
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
      }
    );

    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateDraftOrder($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder {
              id
              name
              reserveInventoryUntil
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
      }
    );

    const updateJson = await updateResponse.json();
    const userErrors = updateJson.data?.draftOrderUpdate?.userErrors ?? [];

    if (userErrors.length) {
      return cors(
        Response.json(
          {
            ok: false,
            error: userErrors.map((e) => e.message).join(", "),
          },
          { status: 400 }
        )
      );
    }

    return cors(
      Response.json({
        ok: true,
        noteText,
        reserveInventoryUntil,
        pricingPreview,
        settings: {
          employeeMarkupPercent: settings.employeeMarkupPercent,
          consignmentCostPercent: settings.consignmentCostPercent,
          reservationDays: settings.reservationDays,
          invoiceSubject: settings.invoiceSubject,
        },
      })
    );
  } catch (error) {
    return cors(
      Response.json(
        { ok: false, error: error?.message || "Unknown backend error" },
        { status: 500 }
      )
    );
  }
};