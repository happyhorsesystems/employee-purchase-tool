import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { admin, cors } = await authenticate.admin(request);

  try {
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

    const invoiceResponse = await admin.graphql(
      `#graphql
        mutation SendEmployeeInvoice($id: ID!, $email: EmailInput!) {
          draftOrderInvoiceSend(id: $id, email: $email) {
            draftOrder {
              id
              name
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
          email: {
            subject: settings.invoiceSubject,
          },
        },
      }
    );

    const invoiceJson = await invoiceResponse.json();
    const userErrors = invoiceJson.data?.draftOrderInvoiceSend?.userErrors ?? [];

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
        message: "Employee invoice sent successfully.",
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