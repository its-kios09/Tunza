import { randomUUID } from 'node:crypto';
import { fhir, type Resource } from '../fhir/client';
import { FEE_SCHEDULE, FEE_SYSTEM, type Fee } from '../terminology/fee-schedule';
import { rulesForFund } from '../claims/rules';
import { payeeEmail } from '../registry/facilities';
import { sendPayout } from '../paypal/client';

export const EVIDENCE_EXT = 'https://tunza.health/claim-evidence';
export const DECISION_EXT = 'https://tunza.health/agent-decision';
const SOURCE_SYSTEM = 'https://tunza.health/source-client';
const ADJ = 'http://terminology.hl7.org/CodeSystem/adjudication';
const DAY = 86_400_000;

export type Decision = 'paid' | 'refused' | 'held';

export interface ItemResult {
  sequence: number;
  code: string;
  label: string;
  billedQty: number;
  unitPrice: number;
  scheduledPrice: number | null;
  evidencedQty: number;
  approvedQty: number;
  approvedAmount: number;
  reasons: string[];
  evidence: string[];
}

export interface Adjudication {
  claimId: string;
  claimResponseId: string;
  decision: Decision;
  reasons: string[];
  billedTotal: number;
  approvedTotal: number;
  suggestedPartial: number | null;
  weeklySpentBefore: number;
  weeklyCap: number;
  items: ItemResult[];
  payout: { batchId: string; status: string; receiver: string } | null;
}

const money = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toFixed(2)}`;
const feeCode = (cc: any): string | undefined =>
  cc?.coding?.find((c: any) => c.system === FEE_SYSTEM)?.code;

function evidenceRefsOf(cr: Resource): string[] {
  return (cr.extension ?? [])
    .filter((e: any) => e.url === EVIDENCE_EXT)
    .map((e: any) => e.valueReference?.reference)
    .filter(Boolean);
}

// Visit records that prove an item was given.
async function findEvidence(patientRef: string, code: string, fee: Fee, encounterRef: string | undefined, since: Date) {
  let found: Resource[];
  if (fee.evidence === 'Procedure') {
    found = await fhir.search('Procedure', { patient: patientRef, code: `${FEE_SYSTEM}|${code}`, encounter: encounterRef, _count: '200' });
  } else if (fee.evidence === 'MedicationDispense') {
    found = await fhir.search('MedicationDispense', { patient: patientRef, code: `${FEE_SYSTEM}|${code}`, context: encounterRef, _count: '200' });
  } else {
    found = await fhir.search('ServiceRequest', { patient: patientRef, encounter: encounterRef, _count: '200' });
  }
  return found
    .filter((r) => !['entered-in-error', 'cancelled', 'revoked'].includes(r.status))
    .map((r) => ({
      ref: `${r.resourceType}/${r.id}`,
      qty: fee.evidence === 'MedicationDispense' ? Number(r.quantity?.value ?? 1) : 1,
      when: r.performedDateTime ?? r.whenHandedOver ?? r.occurrenceDateTime ?? r.authoredOn ?? r.meta?.lastUpdated,
    }))
    .filter((e) => !e.when || new Date(e.when) >= since);
}

export async function adjudicate(claim: Resource): Promise<Adjudication> {
  const claimId = claim.id;
  if (!claimId) throw new Error('Cannot adjudicate a claim without an id');

  const patientRef: string = claim.patient.reference;
  const created = new Date(claim.created);
  const reasons: string[] = [];

  const coverageRef: string | undefined = claim.insurance?.[0]?.coverage?.reference;
  const coverage = coverageRef ? await fhir.read('Coverage', coverageRef.split('/')[1]) : null;
  const fundRef: string | undefined = coverage?.status === 'active' ? coverage.payor?.[0]?.reference : undefined;
  const rules = rulesForFund(fundRef);

  const provider = await fhir.read('Organization', claim.provider.reference.split('/')[1]);
  const payee = provider ? payeeEmail(provider) : undefined;
  const encounterRef: string | undefined = claim.item?.[0]?.encounter?.[0]?.reference;
  const since = new Date(created.getTime() - rules.evidenceWindowDays * DAY);

  // Earlier paid or held claims for this client: their evidence is used up, their payments count to the cap.
  const prior = (await fhir.search('ClaimResponse', { patient: patientRef, _count: '200' }))
    .filter((r) => r.outcome === 'complete' || r.outcome === 'queued');
  const used = new Set(prior.flatMap(evidenceRefsOf));
  const weekAgo = created.getTime() - 7 * DAY;
  const weeklySpentBefore = money(
    prior
      .filter((r) => r.outcome === 'complete' && new Date(r.created).getTime() >= weekAgo)
      .reduce((s, r) => s + Number(r.payment?.amount?.value ?? 0), 0),
  );

  const items: ItemResult[] = [];
  for (const it of claim.item ?? []) {
    const code = feeCode(it.productOrService) ?? 'unknown';
    const fee = FEE_SCHEDULE[code];
    const r: ItemResult = {
      sequence: it.sequence,
      code,
      label: fee?.label ?? code,
      billedQty: Number(it.quantity?.value ?? 1),
      unitPrice: Number(it.unitPrice?.value ?? 0),
      scheduledPrice: fee?.price ?? null,
      evidencedQty: 0,
      approvedQty: 0,
      approvedAmount: 0,
      reasons: [],
      evidence: [],
    };
    items.push(r);

    if (!fee) { r.reasons.push(`"${code}" is not in the Tunza fee schedule.`); continue; }
    if (!rules.allowedCategories.includes(fee.category)) {
      r.reasons.push(`${fee.label} (${fee.category}) is not covered by this fund.`);
      continue;
    }

    const price = Math.min(r.unitPrice, fee.price);
    if (r.unitPrice > fee.price) {
      r.reasons.push(`Billed ${usd(r.unitPrice)} each; the fee schedule price is ${usd(fee.price)}.`);
    }

    const evidence = await findEvidence(patientRef, code, fee, encounterRef, since);
    const fresh = evidence.filter((e) => !used.has(e.ref));
    const alreadyBilled = evidence.length - fresh.length;

    let remaining = r.billedQty;
    for (const e of fresh) {
      if (remaining <= 0) break;
      r.evidence.push(e.ref);
      used.add(e.ref);
      r.evidencedQty += e.qty;
      remaining -= e.qty;
    }
    r.approvedQty = Math.min(r.billedQty, r.evidencedQty);
    r.approvedAmount = money(r.approvedQty * price);

    const what = fee.label.toLowerCase();
    if (r.evidencedQty === 0) {
      r.reasons.push(
        alreadyBilled
          ? `The ${what} on record was already paid for in an earlier claim.`
          : `No visit record shows a ${what} for this client${encounterRef ? ' in that visit' : ` in the last ${rules.evidenceWindowDays} days`}.`,
      );
    } else if (r.evidencedQty < r.billedQty) {
      r.reasons.push(`Billed ${r.billedQty} × ${what}, but the visit record shows ${r.evidencedQty}.`);
    }
  }

  const billedTotal = money(items.reduce((s, i) => s + i.billedQty * i.unitPrice, 0));
  const approvedTotal = money(items.reduce((s, i) => s + i.approvedAmount, 0));
  const fullyBacked = items.length > 0 && items.every((i) => i.approvedQty > 0 && i.approvedQty === i.billedQty);

  let decision: Decision;
  if (!fundRef) {
    decision = 'refused';
    reasons.push('The client has no active fund coverage.');
  } else if (!fullyBacked) {
    decision = 'refused';
    reasons.push(
      approvedTotal > 0
        ? `The claim does not match the visit record. Only ${usd(approvedTotal)} is backed by it; the outreach lead can choose to pay that part.`
        : 'Nothing in this claim is backed by the visit record.',
    );
  } else if (weeklySpentBefore + approvedTotal > rules.weeklyCapPerPatient) {
    decision = 'held';
    reasons.push(
      `The care is verified, but ${usd(approvedTotal)} would bring this client to ${usd(weeklySpentBefore + approvedTotal)} this week, over the ${usd(rules.weeklyCapPerPatient)} cap. Waiting for the outreach lead.`,
    );
  } else if (!payee) {
    decision = 'held';
    reasons.push('The care is verified, but the provider has no PayPal payee set up yet.');
  } else {
    decision = 'paid';
  }

  let payout: Adjudication['payout'] = null;
  if (decision === 'paid' && payee) {
    try {
      const res = await sendPayout({
        senderBatchId: `claim-${claimId}`,
        receiver: payee,
        amount: approvedTotal,
        note: `Tunza claim ${claimId.slice(0, 8)}: verified care`,
        itemId: claimId,
      });
      payout = { ...res, receiver: payee };
      reasons.push(`Verified against the visit record. Paid ${usd(approvedTotal)} to ${provider?.name ?? 'the provider'} via PayPal.`);
    } catch (e: any) {
      decision = 'held';
      reasons.push(`The care is verified, but the PayPal payout failed (${e.message}). Will retry.`);
    }
  }

  const claimResponseId = randomUUID();
  const outcome = decision === 'paid' ? 'complete' : decision === 'held' ? 'queued' : 'error';
  const notes = [...reasons, ...items.flatMap((i) => i.reasons)];

  await fhir.put({
    resourceType: 'ClaimResponse',
    id: claimResponseId,
    meta: { tag: [{ system: SOURCE_SYSTEM, code: 'tunza-agent' }] },
    extension: [
      { url: DECISION_EXT, valueCode: decision },
      ...items.flatMap((i) => i.evidence).map((ref) => ({ url: EVIDENCE_EXT, valueReference: { reference: ref } })),
    ],
    status: 'active',
    type: claim.type,
    use: 'claim',
    patient: { reference: patientRef },
    created: new Date().toISOString(),
    insurer: { reference: fundRef ?? claim.insurer?.reference },
    requestor: claim.provider,
    request: { reference: `Claim/${claimId}` },
    outcome,
    disposition: reasons.join(' '),
    item: items.map((i) => ({
      itemSequence: i.sequence,
      adjudication: [
        { category: { coding: [{ system: ADJ, code: 'submitted' }] }, amount: { value: money(i.billedQty * i.unitPrice), currency: 'USD' } },
        { category: { coding: [{ system: ADJ, code: 'eligible' }] }, amount: { value: i.approvedAmount, currency: 'USD' }, value: i.approvedQty },
      ],
    })),
    processNote: notes.map((text, n) => ({ number: n + 1, type: 'display', text })),
    ...(payout
      ? {
          payment: {
            type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-paymenttype', code: 'complete' }] },
            date: new Date().toISOString().slice(0, 10),
            amount: { value: approvedTotal, currency: 'USD' },
            identifier: { system: 'https://www.paypal.com/payouts', value: payout.batchId },
          },
        }
      : {}),
  });

  return {
    claimId,
    claimResponseId,
    decision,
    reasons,
    billedTotal,
    approvedTotal,
    suggestedPartial: decision === 'refused' && approvedTotal > 0 ? approvedTotal : null,
    weeklySpentBefore,
    weeklyCap: rules.weeklyCapPerPatient,
    items,
    payout,
  };
}
