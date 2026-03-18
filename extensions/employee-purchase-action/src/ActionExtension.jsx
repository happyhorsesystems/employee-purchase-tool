import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, data } = shopify;
  const draftOrderId = data?.selected?.[0]?.id || "";

  const [loadingApply, setLoadingApply] = useState(false);
  const [loadingSend, setLoadingSend] = useState(false);
  const [result, setResult] = useState(null);
  const [sendResult, setSendResult] = useState("");
  const [error, setError] = useState("");

  async function applyEmployeePurchase() {
    setLoadingApply(true);
    setError("");
    setResult(null);
    setSendResult("");

    try {
      const params = new URLSearchParams({ draftOrderId });
      const res = await fetch(`/api/employee-purchase?${params.toString()}`);
      const json = await res.json();

      if (!res.ok || !json.ok) {
        throw new Error(json.error || `Request failed: ${res.status}`);
      }

      setResult(json);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoadingApply(false);
    }
  }

  async function sendEmployeeInvoice() {
    setLoadingSend(true);
    setError("");
    setSendResult("");

    try {
      const params = new URLSearchParams({ draftOrderId });
      const res = await fetch(`/api/send-employee-invoice?${params.toString()}`);
      const json = await res.json();

      if (!res.ok || !json.ok) {
        throw new Error(json.error || `Request failed: ${res.status}`);
      }

      setSendResult("Employee invoice sent successfully.");
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoadingSend(false);
    }
  }

  return (
    <s-admin-action title="Employee Purchase">
      <s-stack direction="block" gap="base">
        <s-text type="strong">
          Apply employee pricing and draft order settings.
        </s-text>

        {!result && !error ? (
          <s-text tone="subdued">
            This will apply employee pricing, update the note, tag the draft, and reserve inventory.
          </s-text>
        ) : null}

        {loadingApply ? (
          <s-text>Applying employee purchase settings...</s-text>
        ) : null}

        {loadingSend ? <s-text>Sending employee invoice...</s-text> : null}

        {error ? <s-text tone="critical">{error}</s-text> : null}

        {sendResult ? <s-text>{sendResult}</s-text> : null}

        {result ? (
          <s-stack direction="block" gap="tight">
            <s-text type="strong">Employee purchase applied.</s-text>

            <s-text>Inventory reserved until: {result.reserveInventoryUntil}</s-text>

            <s-text tone="subdued">
              Reopen this draft to see updated line discounts in Shopify.
            </s-text>

            <s-text tone="subdued">
              If you add or remove items later, click Apply Employee Purchase again to recalculate pricing.
            </s-text>

            <s-text type="strong">Pricing summary</s-text>
            {result.pricingPreview?.map((item) => (
              <s-stack key={item.title} direction="block" gap="none">
                <s-text>{item.title}</s-text>
                <s-text>
                  {item.employeeUnitPrice} {item.currencyCode} employee price
                </s-text>
                <s-text tone="subdued">
                  {item.pricingSource} • discount {item.discountAmount} {item.currencyCode}
                </s-text>
              </s-stack>
            ))}
          </s-stack>
        ) : null}
      </s-stack>

      <s-button
        slot="primary-action"
        onClick={applyEmployeePurchase}
        disabled={!draftOrderId || loadingApply || loadingSend}
      >
        {result ? "Recalculate Employee Purchase" : "Apply Employee Purchase"}
      </s-button>

      <s-button
        slot="secondary-actions"
        onClick={sendEmployeeInvoice}
        disabled={!draftOrderId || loadingApply || loadingSend}
      >
        Send Employee Invoice
      </s-button>

      <s-button
        slot="secondary-actions"
        onClick={() => close()}
        disabled={loadingApply || loadingSend}
      >
        Close
      </s-button>
    </s-admin-action>
  );
}