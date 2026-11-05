#!/usr/bin/env bash
set -euo pipefail
# .env.sandbox must define: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PROVIDER_EMAIL (a sandbox business email)
source .env.sandbox
API="https://api-m.sandbox.paypal.com"

echo "1) OAuth token"
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d grant_type=client_credentials "$API/v1/oauth2/token" | jq -r .access_token)
[ "$TOKEN" != "null" ] || { echo "Token failed: check keys"; exit 1; }

echo "2) Create a \$10 donation order to the Riverside fund"
ORDER=$(curl -s -X POST "$API/v2/checkout/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"intent":"CAPTURE","purchase_units":[{"custom_id":"fund:riverside","description":"Tunza donation","amount":{"currency_code":"USD","value":"10.00"}}]}')
ORDER_ID=$(echo "$ORDER" | jq -r .id)
echo "   Order: $ORDER_ID"
echo "   Approve as the sandbox buyer: $(echo "$ORDER" | jq -r '.links[] | select(.rel=="approve") | .href')"
read -rp "   Press Enter after approving in the browser..."

echo "3) Capture the donation"
curl -s -X POST "$API/v2/checkout/orders/$ORDER_ID/capture" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" | jq '{status, capture: .purchase_units[0].payments.captures[0].id}'

echo "4) Agent pays a provider \$14 for a verified claim (Payouts)"
curl -s -X POST "$API/v1/payments/payouts" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"sender_batch_header\":{\"sender_batch_id\":\"claim-T4821-$(date +%s)\",\"email_subject\":\"Tunza payment for verified care\"},
       \"items\":[{\"recipient_type\":\"EMAIL\",\"receiver\":\"$PROVIDER_EMAIL\",\"amount\":{\"value\":\"14.00\",\"currency\":\"USD\"},\"note\":\"Claim T-4821: dressing + insulin, verified\",\"sender_item_id\":\"T-4821\"}]}" \
  | jq '{batch: .batch_header.payout_batch_id, status: .batch_header.batch_status}'

echo "5) Negative test: a declined donation (for the demo)"
curl -s -X POST "$API/v2/checkout/orders/$ORDER_ID/capture" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H 'PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}' | jq '.details[0].issue // .name'
