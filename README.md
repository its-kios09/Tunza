# Tunza: proof-of-care giving

**Tunza pays for care only when the care is proven.**

People want to fund healthcare for the homeless, children in care and refugees, but they rarely trust where the money goes. Tunza is a small health information exchange for the people national systems miss. Outreach workers record visits on an offline-first Android app built on the Android FHIR SDK. Pharmacies and clinics bill a community care fund. The Tunza agent checks every claim against the visit records and fund rules, then pays the provider through **PayPal Payouts**. Donors get receipts showing the care their money bought, without any patient's identity.

> *Tunza* means "to care for" in Swahili.

Built for the [PayPal AI Hackathon](https://paypalai.devpost.com/), 2026.

---

## How it works

```
 Donor ──PayPal checkout──► Community care fund
                                   │
 Outreach worker (offline) ──visit──► Shared health record (FHIR)
                                   │
 Pharmacy / clinic ──claim──► Tunza agent ──checks──► records + fund rules
                                   │
                    paid ◄─────────┼─────────► refused / held for a human
                     │
          PayPal Payout to the provider ──► anonymous receipt to donors
```

1. **A donor gives** to a fund (street medicine, a children's home, a camp clinic) through PayPal.
2. **An outreach worker records care** on the field app, with or without signal: triage, vitals, wound care, medicines dispensed, referral and follow-up. The visit syncs as FHIR resources when the phone reconnects.
3. **The provider bills the fund** for what it supplied.
4. **The agent checks the claim against the visit record:**
   - Was the care actually recorded? A dressing needs a `Procedure`; a medicine needs a `MedicationDispense`.
   - Does the quantity match? Billing 4 dressings when the visit shows 1 gets the claim refused.
   - Has this record already been paid for?
   - Is the item covered, at the fee-schedule price, within the client's weekly cap?
5. **Verified claims are paid automatically** with a PayPal Payout. Mismatches are refused with a plain explanation. Verified claims over the cap wait for a human lead.
6. **Donors see verified receipts** that never show patient identities.

## Actors

| Actor | Role |
|---|---|
| Client | The person receiving care. Registered with a care card, no national ID needed. |
| Outreach health worker | Registers clients and records visits on the field app |
| Outreach lead | Onboards facilities, reviews refused or held claims, approves agent suggestions |
| Provider (pharmacy / clinic) | Supplies care, bills the fund, receives PayPal payouts |
| Donor | Funds care through PayPal, reads receipts |
| Tunza agent | Checks claims against records and rules, pays or refuses, records the decision |

## Architecture

Tunza is built like a national health information exchange (auth, registries, shared record, claims), but for one community.

```
 Field app ─┐  Pharmacy/Clinic ─┐  Donor web ─┐  Lead dashboard ─┐
            ▼                   ▼             ▼                  ▼
      ┌────────────────────── Tunza Gateway ───────────────────────┐
      │ Auth          OAuth2 client credentials, scopes per actor   │
      │ Registries    Facilities (with PayPal payee) · Clients      │
      │ Shared record FHIR sync endpoint for the Android FHIR SDK   │
      │ Claims        Claim → agent → ClaimResponse + PayPal Payout │
      │ Terminology   Tunza fee schedule                            │
      └───────────────┬───────────────────────────┬────────────────┘
                      ▼                           ▼
              HAPI FHIR R4 (private)        PayPal REST APIs
```

- **HAPI FHIR is never exposed.** Every read and write goes through the gateway, which enforces scopes, keeps each team inside its own data and stamps every record with its source.
- **Everything is stored as FHIR R4:** `Patient`, `Coverage`, `AllergyIntolerance`, `Encounter`, `Observation`, `Procedure`, `MedicationDispense`, `ServiceRequest`, `Appointment`, `Provenance`, `Claim`, `ClaimResponse`.
- **Each claim is paid at most once.** The PayPal payout batch ID is `claim-<id>`, so PayPal rejects a second payout for the same claim.

### How PayPal is used

| Flow | PayPal API |
|---|---|
| Donations into the fund | Orders v2 (create + capture), PayPal wallet and card |
| Paying providers for verified care | Payouts (`/v1/payments/payouts`) |
| Demo of failed payments | Negative testing (`PayPal-Mock-Response`) |

### How AI is used

The money decision itself has no AI in it: the checks are fixed rules and can't be talked into paying. AI sits around that decision:

- explaining refusals and holds in plain language for providers and leads *(in progress)*
- turning fund rules written in plain words into rules the agent enforces *(in progress)*
- flagging unusual billing patterns per provider *(in progress)*
- writing anonymous donor receipts *(in progress)*

## Repository layout

```
Tunza/
├── gateway/            # Tunza Gateway + agent (TypeScript, Fastify)
│   ├── src/auth/       #   OAuth2 token endpoint, scopes, guard
│   ├── src/registry/   #   facility + client registries
│   ├── src/record/     #   FHIR sync endpoint (Android FHIR SDK)
│   ├── src/claims/     #   claims API, fund rules
│   ├── src/agent/      #   claim checks and payout logic
│   ├── src/paypal/     #   PayPal REST client
│   ├── src/terminology/#   fee schedule
│   └── scripts/        #   client provisioning + end-to-end tests
├── android/            # Field app: Kotlin + Android FHIR SDK (in progress)
├── donor-web/          # Donor page + receipts: PayPal JS SDK (in progress)
├── scripts/            # PayPal sandbox smoke tests
└── docker-compose.yml  # HAPI FHIR R4
```

## Running it locally

### Prerequisites

- Docker
- Node.js 22+ (20 works with an engine warning)
- `curl`, `jq`, `openssl`
- A free [PayPal Developer](https://developer.paypal.com/) account

### 1. PayPal sandbox

In the PayPal Developer Dashboard (Sandbox mode):

1. **Testing Tools › Sandbox Accounts:** create
   - a **Business** account, country **United States**: the fund
   - a second **Business** account, country **United States**: a pharmacy
   - a **Personal** account: a donor
2. **Apps & Credentials › Create App:** type **Merchant**, linked to the **fund** account. Under Features, enable **Payouts** and **Advanced Credit and Debit Card Payments**.
3. Copy the app's Client ID and Secret.

### 2. Environment

```bash
cp .env.sandbox.example .env.sandbox
```

Fill in `.env.sandbox`:

| Variable | Value |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | from the Merchant app |
| `PAYPAL_API` | `https://api-m.sandbox.paypal.com` |
| `FUND_EMAIL` | fund sandbox business email |
| `PROVIDER_EMAIL` | pharmacy sandbox business email |
| `DONOR_EMAIL` | donor sandbox personal email |
| `FHIR_BASE` | `http://localhost:8090/fhir` |
| `GATEWAY_PORT` | `7071` |
| `GATEWAY_PUBLIC_URL` | `http://<your-lan-ip>:7071` (so a phone can reach it) |
| `GATEWAY_JWT_SECRET` | output of `openssl rand -base64 48` |

`.env.sandbox` is gitignored. Never commit it.

Check the PayPal setup:

```bash
./scripts/card-donation.sh     # card donation captured to the fund
./scripts/paypal-smoke.sh      # token, order, payout, simulated decline
```

### 3. FHIR server

```bash
docker compose up -d fhir
until curl -sf http://localhost:8090/fhir/metadata >/dev/null; do sleep 5; done
```

### 4. Gateway

```bash
cd gateway
npm install
npm run typecheck

# register the actors (each secret is printed once and saved to data/client-secrets.local.env)
npm run client:create -- --id=riverside-field-app --actor=field-app --org=Organization/riverside-outreach --name="Riverside Outreach field app"
npm run client:create -- --id=eastside-pharmacy   --actor=provider  --org=Organization/eastside-pharmacy  --name="Eastside Community Pharmacy"
npm run client:create -- --id=riverside-lead      --actor=lead      --org=Organization/riverside-outreach --name="Riverside outreach lead"
npm run client:create -- --id=donor-web           --actor=donor-web --name="Tunza donor web"
npm run client:create -- --id=tunza-agent         --actor=agent     --name="Tunza agent"

npm run dev
```

### 5. End-to-end tests

With the gateway running, in another terminal:

```bash
cd gateway
./scripts/test-registries.sh   # lead onboards facilities; field app registers clients (duplicate check)
./scripts/test-record.sh       # field app syncs a signed visit; team isolation and write rules
./scripts/test-claims.sh       # honest, padded, unrecorded, over-cap and overpriced claims, with PayPal payouts
```

`test-claims.sh` plays the demo scenarios:

| Scenario | Expected |
|---|---|
| Billed exactly what the visit recorded | **paid** with a PayPal payout |
| Same claim sent twice | **refused**: already paid |
| Billed 4 dressings, visit shows 1 | **refused**, with the verified $6 offered to the lead |
| Antibiotics with no visit on record | **refused** |
| Verified, but over the weekly cap | **held** for the lead |
| Item not in the fee schedule | **refused** |
| Billed above the fee-schedule price | **paid** at the schedule price |

Log in at <https://sandbox.paypal.com> as the pharmacy account to see the payouts arrive.

## API overview

All endpoints except `/health` and `/oauth/token` need `Authorization: Bearer <token>`.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/oauth/token` | client credentials | Get an access token |
| `GET` | `/health` | none | Gateway and FHIR status |
| `GET` | `/whoami` | any | Inspect the current token |
| `POST` | `/registry/facilities` | `registry/facility.write` | Onboard a pharmacy, clinic, team or fund |
| `GET` | `/registry/facilities` | `registry/facility.read` | List facilities (payee emails hidden from other facilities) |
| `POST` | `/registry/clients` | `registry/client.write` | Register a client, issue a care card, enrol in a fund |
| `GET` | `/registry/clients/:careCard` | `registry/client.read` | Look up a client |
| `POST` | `/record/fhir` | `record/write` | Upload a FHIR transaction Bundle (Android FHIR SDK sync) |
| `GET` | `/record/fhir/:type` | `record/read` | FHIR search, limited to the caller's team |
| `GET` | `/terminology/fee-schedule` | any | Billable items and prices |
| `POST` | `/claims` | `claims/submit` | Submit a claim; returns the agent's decision |
| `GET` | `/claims` | `claims/read` / `claims/read.own` | List claims and decisions |
| `GET` | `/claims/:id` | `claims/read` / `claims/read.own` | One claim with its decision |
| `POST` | `/claims/:id/adjudicate` | `claims/decide` | Re-run the agent (never re-pays a paid claim) |

## Privacy and safety

- Clients are registered by initials, estimated age and area only. No legal name or national ID.
- Donor receipts describe care, never the person.
- Providers see the decision and its reasons, not the clinical records behind it.
- Each team can read and write only its own clients' records.
- All demo data is synthetic.
[MIT](LICENSE)
