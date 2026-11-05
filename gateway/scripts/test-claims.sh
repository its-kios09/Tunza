#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ../.env.sandbox; source data/client-secrets.local.env; set +a
GW=http://localhost:$GATEWAY_PORT
uuid() { cat /proc/sys/kernel/random/uuid; }
tok()  { curl -s -u "$1:$2" -d grant_type=client_credentials "$GW/oauth/token" | jq -r .access_token; }

FIELD=$(tok "$RIVERSIDE_FIELD_APP_ID" "$RIVERSIDE_FIELD_APP_SECRET")
PHARM=$(tok "$EASTSIDE_PHARMACY_ID" "$EASTSIDE_PHARMACY_SECRET")
LEAD=$(tok "$RIVERSIDE_LEAD_ID" "$RIVERSIDE_LEAD_SECRET")

# register INITIALS SEX AGE -> care card (re-uses the existing card on re-runs)
register() {
  curl -s -X POST "$GW/registry/clients" -H "Authorization: Bearer $FIELD" -H 'Content-Type: application/json' \
    -d "{\"initials\":\"$1\",\"sex\":\"$2\",\"ageYears\":$3,\"fundId\":\"riverside-fund\"}" \
    | jq -r '.careCard // .candidates[0].careCard'
}

# visit CARD DRESSINGS PENS -> encounter id (field app syncs a visit)
visit() {
  local pt e now entries id
  pt=$(echo "$1" | tr 'A-Z' 'a-z'); e=$(uuid); now=$(date -Iseconds)
  entries=$(jq -n --arg e "$e" --arg pt "$pt" --arg now "$now" '[{request:{method:"PUT",url:("Encounter/"+$e)},
    resource:{resourceType:"Encounter",id:$e,status:"finished",
      class:{system:"http://terminology.hl7.org/CodeSystem/v3-ActCode",code:"FLD"},
      subject:{reference:("Patient/"+$pt)},period:{start:$now,end:$now}}}]')
  for _ in $(seq 1 "$2"); do
    id=$(uuid)
    entries=$(echo "$entries" | jq --arg id "$id" --arg e "$e" --arg pt "$pt" --arg now "$now" '. + [{request:{method:"PUT",url:("Procedure/"+$id)},
      resource:{resourceType:"Procedure",id:$id,status:"completed",
        code:{coding:[{system:"https://tunza.health/fee-schedule",code:"wound-dressing"}]},
        subject:{reference:("Patient/"+$pt)},encounter:{reference:("Encounter/"+$e)},performedDateTime:$now}}]')
  done
  if [ "$3" -gt 0 ]; then
    id=$(uuid)
    entries=$(echo "$entries" | jq --arg id "$id" --arg e "$e" --arg pt "$pt" --arg now "$now" --argjson q "$3" '. + [{request:{method:"PUT",url:("MedicationDispense/"+$id)},
      resource:{resourceType:"MedicationDispense",id:$id,status:"completed",
        medicationCodeableConcept:{coding:[{system:"https://tunza.health/fee-schedule",code:"insulin-glargine-pen"}]},
        subject:{reference:("Patient/"+$pt)},context:{reference:("Encounter/"+$e)},quantity:{value:$q,unit:"pen"},whenHandedOver:$now}}]')
  fi
  jq -n --argjson entries "$entries" '{resourceType:"Bundle",type:"transaction",entry:$entries}' \
    | curl -s -o /dev/null -X POST "$GW/record/fhir" -H "Authorization: Bearer $FIELD" -H 'Content-Type: application/fhir+json' -d @-
  echo "$e"
}

# claim CARD ENCOUNTER(optional, "" for none) ITEMS_JSON  (pharmacy submits)
claim() {
  local enc=""; [ -n "$2" ] && enc=",\"encounterId\":\"$2\""
  curl -s -X POST "$GW/claims" -H "Authorization: Bearer $PHARM" -H 'Content-Type: application/json' \
    -d "{\"careCard\":\"$1\"$enc,\"items\":$3}"
}
show() { jq -c '{decision, billed: .billedTotal, approved: .approvedTotal, suggestedPartial, payout: .payout.batchId, reasons, items: [.items[]? | {code, billedQty, approvedQty, reasons}]}'; }

JM=T-8544
RO=$(register "R.O." female 61)
PW=$(register "P.W." male 46)
SN=$(register "S.N." female 45)
echo "Clients: J.M.=$JM R.O.=$RO P.W.=$PW S.N.=$SN"

echo; echo "== 1. Honest claim: J.M. had 1 dressing + 1 insulin pen, billed exactly that (expect PAID \$14 + PayPal batch)"
E1=$(visit $JM 1 1)
claim $JM "$E1" '[{"code":"wound-dressing","quantity":1,"unitPrice":6},{"code":"insulin-glargine-pen","quantity":1,"unitPrice":8}]' | show

echo; echo "== 2. Same claim sent again (expect REFUSED: already paid)"
claim $JM "$E1" '[{"code":"wound-dressing","quantity":1,"unitPrice":6},{"code":"insulin-glargine-pen","quantity":1,"unitPrice":8}]' | show

echo; echo "== 3. Padded claim: R.O. had 1 dressing, pharmacy bills 4 (expect REFUSED, suggested \$6)"
E3=$(visit "$RO" 1 0)
claim "$RO" "$E3" '[{"code":"wound-dressing","quantity":4,"unitPrice":6}]' | show

echo; echo "== 4. No visit at all: P.W. billed antibiotics (expect REFUSED: no record)"
claim "$PW" "" '[{"code":"antibiotic-course","quantity":1,"unitPrice":17}]' | show

echo; echo "== 5. Over the weekly cap: S.N. given 7 pens = \$56 > \$50 (expect HELD)"
E5=$(visit "$SN" 0 7)
claim "$SN" "$E5" '[{"code":"insulin-glargine-pen","quantity":7,"unitPrice":8}]' | show

echo; echo "== 6. Item not in the fee schedule (expect REFUSED)"
claim $JM "$E1" '[{"code":"vitamins","quantity":1,"unitPrice":5}]' | show

echo; echo "== 7. Overcharge: J.M. given 1 pen, billed at \$12 (expect PAID at \$8, price note)"
E7=$(visit $JM 0 1)
claim $JM "$E7" '[{"code":"insulin-glargine-pen","quantity":1,"unitPrice":12}]' | show

echo; echo "== 8. Lead's view of all claims"
curl -s "$GW/claims" -H "Authorization: Bearer $LEAD" | jq -r '.[] | [.careCard, .decision, ("$" + (.billedTotal|tostring)), ("paid $" + (.approvedTotal|tostring)), (.payoutBatch // "-")] | @tsv' | head -10

echo; echo "== 9. Pharmacy tries to decide a claim itself (expect 403)"
CID=$(curl -s "$GW/claims" -H "Authorization: Bearer $PHARM" | jq -r '.[0].claimId')
curl -s -X POST "$GW/claims/$CID/adjudicate" -H "Authorization: Bearer $PHARM" | jq -c
