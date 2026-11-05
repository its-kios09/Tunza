# Waypoint

**AI-assisted care templates for women's health, built on Open Health Stack.**

Waypoint turns a screening result into a booked, affordable, guideline-aligned next step. A clinician records a woman's risk factors and test results; Waypoint stratifies risk, generates the care pathway from the national guideline, checks whether the facility can actually deliver it, estimates what it will cost, and gives the patient a plain-language plan. The first care template covers cervical cancer screening and triage in Kenya.

Waypoint is FHIR-native and offline-first. Every decision — risk assessment, clinician override, pathway, booking, cost estimate, message — is stored as a FHIR resource, synced when there is connectivity, and auditable.

---

## Who it is for

| Role | What Waypoint does for them |
|---|---|
| Nurse, clinical officer, doctor | Under three minutes from opening a patient to a printed plan; an AI output they can agree with or override; stock and cost visible before promising anything |
| Patient | A plan in plain English or Kiswahili: what was found, what happens next, when, where, what it costs, what to bring; SMS reminders; a portal for symptoms and results |
| Facility | Every clinician on the same guideline; procedures not booked when supplies are out; demand forecasts for kits and equipment; adherence and loss-to-follow-up metrics |

---

## How it works

```
Questionnaire ──► Observations ──► Risk model ──► PlanDefinition (CQL) ──► CarePlan
   (SDC form)      (StructureMap)   RiskAssessment    national guideline      ServiceRequests
                                                                              Appointments
                                                          │
                              ┌────────────────────────────┴───────────────────────┐
                              ▼                                                    ▼
                    Inventory (InventoryItem)                          Cost (ChargeItemDefinition)
                    "can this facility do it?"                         "what will it cost, who pays?"
                              │                                                    │
                              └──────────────► Patient summary · SMS · Portal ◄────┘
                                                        │
                                              Data Pipes ──► Facility dashboard
```

Three kinds of logic, kept deliberately separate:

1. **Clinical rules** are deterministic CQL in the PlanDefinition. The model refines risk *within* the guideline; it never overrides triage for HPV-positive women or women living with HIV.
2. **Prediction** is an interpretable tabular model (logistic regression, then LightGBM) behind a single `Prediction` interface. Output is a FHIR `RiskAssessment` with probability, tier, feature contributions, and model version.
3. **Language** is generated from structured outputs only — the patient summary is written by an LLM from the `CarePlan`, never from free text, and never on the decision path.

---

## Repository layout

```
waypoint/
├── app/         Clinician app — Kotlin, Android FHIR SDK (engine, data-capture, workflow, knowledge), Jetpack Compose
├── platform/    HAPI FHIR R4, FHIR Info Gateway, prediction / inventory / cost services, FHIR Data Pipes, docker-compose
├── templates/   Care templates as FHIR artifacts: Questionnaire, StructureMap, PlanDefinition, CQL Library,
│                ActivityDefinitions, ChargeItemDefinitions, patient-summary templates (en, sw)
├── models/      Data schema, synthetic cohort generator, training pipelines, evaluation, model registry, serving
├── patient/     Summary PDF generation, SMS/USSD reminders, patient portal (web, behind the gateway)
├── facility/    Facility dashboard over Data Pipes Parquet views
└── docs/        Architecture, clinical governance, data governance, guideline notes, ADRs
```

`templates/` is the product's core: a care template is a versioned, clinically signed bundle of FHIR resources that any OHS-based app can run.

---

## Quick start (development, synthetic data)

Requirements: Docker, JDK 17, Android Studio (Ladybug or later), Python 3.11+.

```bash
# 1. Platform — HAPI, gateway, services, seeded with 5,000 synthetic women
cd platform
docker compose up -d
./scripts/seed.sh            # loads templates/ and models/data/ into HAPI

# 2. Models — regenerate synthetic data, train the baseline, start the prediction service
cd ../models
pip install -r requirements.txt
python synth.py --n 5000 --seed 42 --out ./data
python train.py --target no_show --model logreg
python serve.py              # http://localhost:8000/predict/{risk,no_show,demand}

# 3. App — point at the local platform and run on a device or emulator
cd ../app
cp local.properties.example local.properties   # set FHIR_BASE_URL and GATEWAY_URL
./gradlew installDebug
```

Demo logins for the gateway (facility and patient scopes) are in `platform/gateway/README.md`.

---

## Data

Waypoint ships with a **synthetic cohort** (`models/synth.py`) calibrated to published Kenyan priors: HPV prevalence by age, HPV-16/18 share, HIV prevalence by county, CIN2+ conditional on genotype and HIV, and attendance as a function of distance, cost and phone ownership. It reproduces the real cascade — HPV testing concentrated in higher-level facilities, referrals out when colposcopy is unavailable, loss to follow-up, stock-outs — and it exists so that the whole pipeline runs end to end before any real record is collected.

Synthetic performance is not clinical evidence. The production models are trained only on consented, de-identified Kenyan screening records with histology outcomes, collected under the governance in `docs/data-governance.md`. The analytics schema (`women`, `screenings`, `triage_events`, `histology`, `treatments`, `attendance`, `facility_stock`, `costs`, `model_runs`) is identical for synthetic and real data, so models swap without code changes.

Additional sources and their licences are listed in `docs/data-sources.md` (DHS 2022 microdata for uptake modelling; KHIS aggregates and the 2022 25-county capacity survey for facilities, services and demand).

---

## Clinical and data governance

- Every care template version is reviewed and signed by a named clinician before release. Guideline changes ship as a new template version, not a code change.
- Model versions are validated (discrimination, calibration, subgroup performance by HIV status and county) and recorded in the registry before they can be selected by the app.
- Health data is sensitive personal data under Kenya's Data Protection Act 2019. Waypoint operates as a registered data controller; consent language is embedded in the intake Questionnaire; de-identification runs at export with keyed pseudonyms; all access passes through the FHIR Info Gateway and is logged.
- Clinician overrides are first-class: the app records agreement or disagreement with the model on every `RiskAssessment`, and the override rate is a monitored quality signal.

Details: `docs/clinical-governance.md`, `docs/data-governance.md`.

---

## Roadmap

1. Cervical screening template, clinically signed; platform on synthetic data
2. Clinician app with guideline-only pathway, stock, cost and patient summary — no ML in the decision path
3. Pilot at one facility; real data collection begins
4. No-show model in production (lowest clinical risk, immediate facility value)
5. Risk model after validation on real outcomes
6. Facility dashboard and patient portal as the pilot demands
7. Second template

---

## Tech stack

| Layer | Technology |
|---|---|
| Clinician app | Kotlin, Android FHIR SDK, Jetpack Compose |
| FHIR server | HAPI FHIR R4 on PostgreSQL |
| Access control | FHIR Info Gateway |
| Clinical logic | FHIR PlanDefinition + CQL, executed by the Android FHIR SDK workflow library |
| Prediction | scikit-learn / LightGBM, ONNX (server) and TFLite (device), FastAPI |
| Analytics | FHIR Data Pipes → Parquet |
| Patient messaging | Africa's Talking (SMS/USSD), WhatsApp Business API |
| Patient summary language | LLM API, server-side, from structured outputs only |
| Web | React, TypeScript |

---

## Contributing

Clinical contributors work in `templates/` and `docs/` and do not need to write Kotlin. See `CONTRIBUTING.md` for the template review process and the definition of done for a model version.

## Licence

To be decided before the first external release. Care templates and the synthetic generator are intended to be open; the trained models and facility analytics are proprietary.
