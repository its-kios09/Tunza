#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ../.env.sandbox; source data/client-secrets.local.env; set +a
GW=http://localhost:$GATEWAY_PORT

tok()  { curl -s -u "$1:$2" -d grant_type=client_credentials "$GW/oauth/token" | jq -r .access_token; }
post() { curl -s -X POST "$GW$2" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$3"; }
get()  { curl -s "$GW$2" -H "Authorization: Bearer $1"; }

LEAD=$(tok "$RIVERSIDE_LEAD_ID" "$RIVERSIDE_LEAD_SECRET")
FIELD=$(tok "$RIVERSIDE_FIELD_APP_ID" "$RIVERSIDE_FIELD_APP_SECRET")
PHARM=$(tok "$EASTSIDE_PHARMACY_ID" "$EASTSIDE_PHARMACY_SECRET")

echo "== 1. Lead onboards facilities (409 on re-run is fine)"
post "$LEAD" /registry/facilities '{"id":"riverside-outreach","name":"Riverside Outreach Team","kind":"outreach-team"}' | jq -c
post "$LEAD" /registry/facilities "{\"id\":\"riverside-fund\",\"name\":\"Riverside Street Care Fund\",\"kind\":\"fund\",\"paypalEmail\":\"$FUND_EMAIL\"}" | jq -c
post "$LEAD" /registry/facilities "{\"id\":\"eastside-pharmacy\",\"name\":\"Eastside Community Pharmacy\",\"kind\":\"pharmacy\",\"paypalEmail\":\"$PROVIDER_EMAIL\"}" | jq -c
post "$LEAD" /registry/facilities '{"id":"riverside-health-centre","name":"Riverside Health Centre","kind":"clinic"}' | jq -c

echo "== 2. Pharmacy views the registry (sees only its own payee email)"
get "$PHARM" /registry/facilities | jq -c '.[]'

echo "== 3. Field app lists pharmacies"
get "$FIELD" '/registry/facilities?kind=pharmacy' | jq -c '.[]'

echo "== 4. Pharmacy tries to onboard a facility (must be 403)"
post "$PHARM" /registry/facilities '{"name":"Fake Pharmacy","kind":"pharmacy"}' | jq -c

echo "== 5. Field app registers J.M."
JM='{"initials":"J.M.","sex":"male","ageYears":54,"area":"Riverside Bridge, east side","fundId":"riverside-fund","allergies":[{"substance":"Penicillin","reaction":"Rash"}]}'
RES=$(post "$FIELD" /registry/clients "$JM"); echo "$RES" | jq -c
CARD=$(echo "$RES" | jq -r '.careCard // .candidates[0].careCard')

echo "== 6. Same person again (must be 409 possible_duplicate)"
post "$FIELD" /registry/clients "$JM" | jq -c '{error, candidates: [.candidates[]?.careCard]}'

echo "== 7. Look up by care card $CARD"
get "$FIELD" "/registry/clients/$CARD" | jq

echo "== 8. Bad input (must be 400 with reasons)"
post "$FIELD" /registry/clients '{"initials":"","sex":"x","ageYears":-1,"fundId":"riverside-fund"}' | jq -c

echo "== 9. Unknown fund (must be 400)"
post "$FIELD" /registry/clients '{"initials":"Q.Z.","sex":"female","ageYears":30,"fundId":"no-such-fund"}' | jq -c
