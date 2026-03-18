import { Form, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";

export const loader = async () => {
  let settings = await db.employeePurchaseSettings.findUnique({
    where: { id: 1 },
  });

  if (!settings) {
    settings = await db.employeePurchaseSettings.create({
      data: {
        id: 1,
        employeeMarkupPercent: 15,
        consignmentCostPercent: 50,
        reservationDays: 30,
        notePrefix: "Employee Purchase",
        invoiceSubject: "Employee Purchase Invoice",
      },
    });
  }

  return { settings };
};

export const action = async ({ request }) => {
  const formData = await request.formData();

  const employeeMarkupPercent = Number(formData.get("employeeMarkupPercent"));
  const consignmentCostPercent = Number(formData.get("consignmentCostPercent"));
  const reservationDays = Number(formData.get("reservationDays"));
  const notePrefix = String(formData.get("notePrefix") || "");
  const invoiceSubject = String(formData.get("invoiceSubject") || "");

  await db.employeePurchaseSettings.upsert({
    where: { id: 1 },
    update: {
      employeeMarkupPercent,
      consignmentCostPercent,
      reservationDays,
      notePrefix,
      invoiceSubject,
    },
    create: {
      id: 1,
      employeeMarkupPercent,
      consignmentCostPercent,
      reservationDays,
      notePrefix,
      invoiceSubject,
    },
  });

  return { ok: true };
};

function fieldStyle() {
  return {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: "8px",
    fontSize: "14px",
    background: "white",
    boxSizing: "border-box",
  };
}

function labelStyle() {
  return {
    display: "block",
    marginBottom: "6px",
    fontWeight: 600,
    fontSize: "14px",
  };
}

function helpStyle() {
  return {
    marginTop: "4px",
    color: "#6d7175",
    fontSize: "13px",
  };
}

export default function SettingsPage() {
  const { settings } = useLoaderData();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  return (
    <div
      style={{
        padding: "32px",
        maxWidth: "760px",
        margin: "0 auto",
      }}
    >
      <div
        style={{
          background: "white",
          border: "1px solid #e1e3e5",
          borderRadius: "12px",
          padding: "24px",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <h1 style={{ fontSize: "28px", margin: "0 0 8px 0" }}>Settings</h1>
        <p style={{ margin: "0 0 24px 0", color: "#6d7175" }}>
          Update the default rules used by the Employee Purchase tool.
        </p>

        <Form method="post">
          <div style={{ display: "grid", gap: "20px" }}>
            <div>
              <label style={labelStyle()}>Employee markup %</label>
              <input
                name="employeeMarkupPercent"
                type="number"
                step="0.01"
                defaultValue={settings.employeeMarkupPercent}
                style={fieldStyle()}
              />
              <div style={helpStyle()}>
                Markup added on top of item cost for employee purchases.
              </div>
            </div>

            <div>
              <label style={labelStyle()}>Consignment cost % of retail</label>
              <input
                name="consignmentCostPercent"
                type="number"
                step="0.01"
                defaultValue={settings.consignmentCostPercent}
                style={fieldStyle()}
              />
              <div style={helpStyle()}>
                Used when an item is tagged consignment and has no Shopify cost.
              </div>
            </div>

            <div>
              <label style={labelStyle()}>Inventory reservation days</label>
              <input
                name="reservationDays"
                type="number"
                defaultValue={settings.reservationDays}
                style={fieldStyle()}
              />
              <div style={helpStyle()}>
                Number of days inventory stays reserved after applying the tool.
              </div>
            </div>

            <div>
              <label style={labelStyle()}>Note prefix</label>
              <input
                name="notePrefix"
                type="text"
                defaultValue={settings.notePrefix}
                style={fieldStyle()}
              />
              <div style={helpStyle()}>
                Example: Employee Purchase
              </div>
            </div>

            <div>
              <label style={labelStyle()}>Invoice subject</label>
              <input
                name="invoiceSubject"
                type="text"
                defaultValue={settings.invoiceSubject}
                style={fieldStyle()}
              />
              <div style={helpStyle()}>
                Subject used by the Send Employee Invoice button.
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isSaving}
                style={{
                  padding: "10px 16px",
                  background: "#111827",
                  color: "white",
                  border: "none",
                  borderRadius: "10px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {isSaving ? "Saving..." : "Save settings"}
              </button>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}