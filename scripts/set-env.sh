#!/usr/bin/env bash
set -euo pipefail
read -rp  "Tunza Fund Client ID: " CID
read -rsp "Tunza Fund Secret (hidden): " SECRET; echo
cat > .env.sandbox <<ENV
# Tunza Fund (US business: sb-kcady53656452) — receives donations, sends payouts
PAYPAL_CLIENT_ID=${CID}
PAYPAL_CLIENT_SECRET=${SECRET}
PAYPAL_API=https://api-m.sandbox.paypal.com
FUND_EMAIL=sb-kcady53656452@business.example.com
# Eastside Pharmacy (US business) — provider paid by the agent
PROVIDER_EMAIL=sb-4b5iy53656402@business.example.com
# Donor (KE personal) — PayPal wallet checkout
DONOR_EMAIL=sb-ci4dq53738843@personal.example.com
ENV
chmod 600 .env.sandbox
echo "Wrote .env.sandbox"
