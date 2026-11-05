#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ../.env.sandbox; source data/client-secrets.local.env; set +a
GW=http://localhost:$GATEWAY_PORT
PT=${1:-t-8544}
uuid() { cat /proc/sys/kernel/random/uuid; }

tok() { curl -s -u "$1:$2" -d grant_type=client_credentials "$GW/oauth/token" | jq -r .access_token; }
FIELD=$(tok "$RIVERSIDE_FIELD_APP_ID" "$RIVERSIDE_FIELD_APP_SECRET")
PHARM=$(tok "$EASTSIDE_PHARMACY_ID" "$EASTSIDE_PHARMACY_SECRET")
up() { curl -s -X POST "$GW/record/fhir" -H "Authorization: Bearer $1" -H 'Content-Type: application/fhir+json' -d "$2"; }

E=$(uuid); BP=$(uuid); GL=$(uuid); TP=$(uuid); PR=$(uuid); MD=$(uuid); SR=$(uuid); AP=$(uuid); PV=$(uuid)
NOW=$(date -Iseconds)

# The bundle the field app sends after "Sign & save" (what the Android FHIR SDK uploads)
VISIT=$(cat <<JSON
{ "resourceType": "Bundle", "type": "transaction", "entry": [
  { "request": {"method":"PUT","url":"Encounter/$E"}, "resource": {
      "resourceType":"Encounter","id":"$E","status":"finished",
      "class":{"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"FLD","display":"field"},
      "type":[{"text":"Street outreach visit"}],
      "subject":{"reference":"Patient/$PT"},
      "participant":[{"individual":{"display":"A. Kim"}}],
      "period":{"start":"$NOW","end":"$NOW"},
      "reasonCode":[{"text":"Leg more painful at night, feels hot"}],
      "serviceProvider":{"reference":"Organization/someone-else"} } },
  { "request": {"method":"PUT","url":"Observation/$BP"}, "resource": {
      "resourceType":"Observation","id":"$BP","status":"final",
      "category":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"vital-signs"}]}],
      "code":{"coding":[{"system":"http://loinc.org","code":"85354-9","display":"Blood pressure panel"}]},
      "subject":{"reference":"Patient/$PT"},"encounter":{"reference":"Encounter/$E"},"effectiveDateTime":"$NOW",
      "component":[
        {"code":{"coding":[{"system":"http://loinc.org","code":"8480-6"}]},"valueQuantity":{"value":138,"unit":"mmHg"}},
        {"code":{"coding":[{"system":"http://loinc.org","code":"8462-4"}]},"valueQuantity":{"value":88,"unit":"mmHg"}} ] } },
  { "request": {"method":"PUT","url":"Observation/$GL"}, "resource": {
      "resourceType":"Observation","id":"$GL","status":"final",
      "code":{"coding":[{"system":"http://loinc.org","code":"2339-0","display":"Glucose"}]},
      "subject":{"reference":"Patient/$PT"},"encounter":{"reference":"Encounter/$E"},"effectiveDateTime":"$NOW",
      "valueQuantity":{"value":182,"unit":"mg/dL"},
      "interpretation":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation","code":"H"}]}] } },
  { "request": {"method":"PUT","url":"Observation/$TP"}, "resource": {
      "resourceType":"Observation","id":"$TP","status":"final",
      "code":{"coding":[{"system":"http://loinc.org","code":"8310-5","display":"Body temperature"}]},
      "subject":{"reference":"Patient/$PT"},"encounter":{"reference":"Encounter/$E"},"effectiveDateTime":"$NOW",
      "valueQuantity":{"value":37.9,"unit":"Cel"} } },
  { "request": {"method":"PUT","url":"Procedure/$PR"}, "resource": {
      "resourceType":"Procedure","id":"$PR","status":"completed",
      "code":{"coding":[{"system":"https://tunza.health/fee-schedule","code":"wound-dressing"}],"text":"Wound cleaned and dressed"},
      "subject":{"reference":"Patient/$PT"},"encounter":{"reference":"Encounter/$E"},"performedDateTime":"$NOW" } },
  { "request": {"method":"PUT","url":"MedicationDispense/$MD"}, "resource": {
      "resourceType":"MedicationDispense","id":"$MD","status":"completed",
      "medicationCodeableConcept":{"coding":[{"system":"https://tunza.health/fee-schedule","code":"insulin-glargine-pen"}],"text":"Insulin glargine pen 100 U/mL"},
      "subject":{"reference":"Patient/$PT"},"context":{"reference":"Encounter/$E"},
      "quantity":{"value":1,"unit":"pen"},"whenHandedOver":"$NOW",
      "dosageInstruction":[{"text":"18 units SC nightly"}] } },
  { "request": {"method":"PUT","url":"ServiceRequest/$SR"}, "resource": {
      "resourceType":"ServiceRequest","id":"$SR","status":"active","intent":"order","priority":"urgent",
      "code":{"text":"Clinic review: possible wound infection"},
      "subject":{"reference":"Patient/$PT"},"encounter":{"reference":"Encounter/$E"},
      "performer":[{"reference":"Organization/riverside-health-centre"}],
      "reasonCode":[{"text":"Possible wound infection, penicillin allergic"}],
      "occurrenceDateTime":"$NOW" } },
  { "request": {"method":"PUT","url":"Appointment/$AP"}, "resource": {
      "resourceType":"Appointment","id":"$AP","status":"booked",
      "description":"Outreach follow-up: dressing + wound check",
      "start":"2026-11-08T09:00:00+03:00","end":"2026-11-08T09:30:00+03:00",
      "participant":[{"actor":{"reference":"Patient/$PT"},"status":"accepted"}] } },
  { "request": {"method":"PUT","url":"Provenance/$PV"}, "resource": {
      "resourceType":"Provenance","id":"$PV","recorded":"$NOW",
      "target":[{"reference":"Encounter/$E"},{"reference":"Procedure/$PR"},{"reference":"MedicationDispense/$MD"}],
      "agent":[{"who":{"display":"A. Kim, community health worker"}}],
      "signature":[{"type":[{"system":"urn:iso-astm:E1762-95:2013","code":"1.2.840.10065.1.12.1.1"}],"when":"$NOW","who":{"display":"A. Kim"}}] } }
]}
JSON
)

echo "== A. Field app uploads a signed visit (expect 9 x 201 Created)"
up "$FIELD" "$VISIT" | jq -r '.entry[]?.response.status // .' | sort | uniq -c

echo "== B. Encounter came back stamped (serviceProvider forced to the team, source tag)"
curl -s "$GW/record/fhir/Encounter?_id=$E" -H "Authorization: Bearer $FIELD" \
  | jq -c '.entry[0].resource | {id, serviceProvider, tag: .meta.tag}'

echo "== C. Download J.M.'s record (what the SDK pulls)"
for T in Encounter Observation Procedure MedicationDispense ServiceRequest Appointment; do
  printf "  %-20s %s\n" "$T" "$(curl -s "$GW/record/fhir/$T?patient=Patient/$PT&_summary=count" -H "Authorization: Bearer $FIELD" | jq -r .total)"
done

echo "== D. Paging links point at the gateway, not HAPI"
curl -s "$GW/record/fhir/Observation?patient=Patient/$PT&_count=1" -H "Authorization: Bearer $FIELD" | jq -r '.link[].url'

echo "== E. Field app tries to slip in a Claim (must be refused)"
up "$FIELD" "{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"entry\":[{\"request\":{\"method\":\"PUT\",\"url\":\"Claim/$(uuid)\"},\"resource\":{\"resourceType\":\"Claim\",\"id\":\"x1\"}}]}" | jq -c '.issue[0]'

echo "== F. Record for someone not on the team (must be 403)"
up "$FIELD" "{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"entry\":[{\"request\":{\"method\":\"PUT\",\"url\":\"Encounter/x2\"},\"resource\":{\"resourceType\":\"Encounter\",\"id\":\"x2\",\"status\":\"finished\",\"class\":{\"code\":\"FLD\"},\"subject\":{\"reference\":\"Patient/t-0000\"}}}]}" | jq -c '.issue[0]'

echo "== G. Delete through sync (must be refused)"
up "$FIELD" '{"resourceType":"Bundle","type":"transaction","entry":[{"request":{"method":"DELETE","url":"Encounter/'"$E"'"},"resource":{"resourceType":"Encounter","id":"'"$E"'"}}]}' | jq -c '.issue[0]'

echo "== H. Pharmacy tries to write clinical records (must be 403)"
up "$PHARM" "$VISIT" | jq -c

echo "== I. Pharmacy tries to read clinical records (must be 403)"
curl -s "$GW/record/fhir/Encounter?patient=Patient/$PT" -H "Authorization: Bearer $PHARM" | jq -c
