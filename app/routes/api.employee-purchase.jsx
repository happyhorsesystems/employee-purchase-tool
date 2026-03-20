import { authenticate } from "../shopify.server";
import db from "../db.server";

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function formatDateForNote(notePrefix) {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const year = parts.find((p) => p.type === "year")?.value ?? "";

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

function toMailingAddressInput(address) {
  if (!address) return null;

  const result = {};

  if (address.firstName) result.firstName = address.firstName;
  if (address.lastName) result.lastName = address.lastName;
  if (address.company) result.company = address.company;
  if (address.address1) result.address1 = address.address1;
  if (address.address2) result.address2 = address.address2;
  if (address.city) result.city = address.city;
  if (address.provinceCode) result.provinceCode = address.provinceCode;
  if (address.province) result.province = address.province;
  if (address.countryCodeV2) result.countryCode = address.countryCodeV2;
  if (address.country) result.country = address.country;
  if (address.zip) result.zip = address.zip;
  if (address.phone) result.phone = address.phone;

  return Object.keys(result).length ? result : null;
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

async function getFirstLocalPickupHandle({ admin, shippingAddress, lineItems }) {
  if (!shippingAddress) {
    return null;
  }

  const deliveryResponse = await admin.graphql(
    `#graphql
      query DraftOrderPickupOptions($input: DraftOrderAvailableDeliveryOptionsInput!) {
        draftOrderAvailableDeliveryOptions(input: $input) {
          availableLocalPickupOptions {
            handle
            title
            code
            locationId
            source
          }
        }
      }
    `,
    {
      variables: {
        input: {
          shippingAddress,
          lineItems,
        },
      },
    },
  );

  const deliveryJson = await deliveryResponse.json();
  const pickupOptions =
    deliveryJson.data?.draftOrderAvailableDeliveryOptions?.availableLocalPickupOptions ?? [];

  return pickupOptions[0] ?? null;
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
            note2
            tags
            shippingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
            billingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
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
    const alreadyNoted = hasEmployeePurchaseNote(draftOrder.note2, settings.notePrefix);
    const isRecalculation = alreadyTagged || alreadyNoted;

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

    const shippingAddressInput = toMailingAddressInput(draftOrder.shippingAddress);
    const billingAddressInput = toMailingAddressInput(draftOrder.billingAddress);

    let pickupOption = null;
    let pickupMessage = "";

    try {
      pickupOption = await getFirstLocalPickupHandle({
        admin,
        shippingAddress: shippingAddressInput,
        lineItems: updatedLineItems,
      });

      if (!pickupOption) {
        pickupMessage =
          " Pricing was applied, but pickup in store was not auto-selected.";
      }
    } catch (pickupError) {
      pickupMessage =
        " Pricing was applied, but pickup in store could not be auto-selected.";
    }

    const updateInput = {
      note: noteText,
      reserveInventoryUntil,
      lineItems: updatedLineItems,
    };

    if (shippingAddressInput) {
      updateInput.shippingAddress = shippingAddressInput;
    }

    if (billingAddressInput) {
      updateInput.billingAddress = billingAddressInput;
    }

    if (pickupOption?.handle) {
      updateInput.shippingLine = {
        shippingRateHandle: pickupOption.handle,
      };
    }

    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateDraftOrder($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder {
              id
              name
              reserveInventoryUntil
              note2
              tags
              shippingLine {
                title
                shippingRateHandle
              }
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
          input: updateInput,
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

    const successMessage = isRecalculation
      ? `Employee pricing recalculated successfully.${pickupMessage}`
      : `Employee pricing applied successfully.${pickupMessage}`;

    await writeAuditLog({
      shop,
      draftOrderId,
      actionStatus: isRecalculation ? "recalculated" : "applied",
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
        pickupApplied: Boolean(pickupOption?.handle),
        pickupTitle: pickupOption?.title || null,
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