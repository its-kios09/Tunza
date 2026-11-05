#!/usr/bin/env bash
set -euo pipefail
source .env.sandbox
API="https://api-m.sandbox.paypal.com"
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$API/v1/oauth2/token" | jq -r .access_token)
curl -s -X POST "$API/v2/checkout/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: donation-$(date +%s)" \
  -d '{
    "intent":"CAPTURE",
    "purchase_units":[{"custom_id":"fund:riverside","description":"Tunza donation","amount":{"currency_code":"USD","value":"10.00"}}],
    "payment_source":{"card":{"number":"4111111111111111","expiry":"2030-12","security_code":"123","name":"Test Donor"}}
  }' | jq '{status, capture: .purchase_units[0].payments.captures[0].id, error: .details}'
