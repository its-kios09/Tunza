import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fhir, type Resource } from '../fhir/client';
import { requireScope, type Principal } from '../auth/guard';
import { FEE_SCHEDULE, FEE_SYSTEM } from '../terminology/fee-schedule';
import { facilityKind } from '../registry/facilities';
import { adjudicate, DECISION_EXT, type Adjudication } from '../agent/adjudicate';

const ClaimInput = z.object({
  careCard: z.string().min(3),
  encounterId: z.string().optional(),
  items: z.array(z.object({
    code: z.string().min(1),
    quantity: z.number().int().positive().max(100),
    unitPrice: z.number().positive().max(10_000),
  })).min(1).max(20),
});

const money = (n: number) => Math.round(n * 100) / 100;
const cardOf = (patientRef?: string) => patientRef?.split('/')[1]?.toUpperCase();

// Providers see the outcome and reasons, not the clinical evidence behind them.
function providerView(a: Adjudication) {
  return {
    claimId: a.claimId,
    decision: a.decision,
    billedTotal: a.billedTotal,
    approvedTotal: a.approvedTotal,
    suggestedPartial: a.suggestedPartial,
    reasons: a.reasons,
    items: a.items.map(({ code, label, billedQty, approvedQty, approvedAmount, reasons }) =>
      ({ code, label, billedQty, approvedQty, approvedAmount, reasons })),
    payout: a.payout ? { batchId: a.payout.batchId, status: a.payout.status } : null,
  };
}

function summarize(claim: Resource, responses: Resource[]) {
  const latest = responses
    .filter((r) => r.request?.reference === `Claim/${claim.id}`)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  return {
    claimId: claim.id,
    created: claim.created,
    careCard: cardOf(claim.patient?.reference),
    provider: claim.provider?.reference,
    billedTotal: claim.total?.value ?? null,
    decision: latest?.extension?.find((e: any) => e.url === DECISION_EXT)?.valueCode ?? 'pending',
    approvedTotal: latest?.payment?.amount?.value ?? 0,
    payoutBatch: latest?.payment?.identifier?.value ?? null,
    disposition: latest?.disposition ?? null,
    notes: (latest?.processNote ?? []).map((n: any) => n.text),
  };
}

const canReadAll = (p: Principal) => p.scopes.includes('claims/read');
const canReadOwn = (p: Principal) => p.scopes.includes('claims/read.own');

export async function claimRoutes(app: FastifyInstance) {
  app.get('/terminology/fee-schedule', { preHandler: requireScope() }, async () =>
    Object.entries(FEE_SCHEDULE).map(([code, f]) => ({ system: FEE_SYSTEM, code, ...f })));

  // Provider submits a claim; the agent decides straight away.
  app.post('/claims', { preHandler: requireScope('claims/submit') }, async (req, reply) => {
    const p = req.principal!;
    if (p.actor !== 'provider' || !p.org) return reply.code(403).send({ error: 'providers_only' });
    const input = ClaimInput.parse(req.body);

    const providerOrg = await fhir.read('Organization', p.org.split('/')[1]);
    if (!providerOrg) return reply.code(403).send({ error: 'provider_not_registered' });

    const pid = input.careCard.toLowerCase();
    const patient = await fhir.read('Patient', pid);
    if (!patient) return reply.code(404).send({ error: 'unknown_client', careCard: input.careCard });

    const [coverage] = await fhir.search('Coverage', { beneficiary: `Patient/${pid}`, status: 'active' });
    if (!coverage) return reply.code(400).send({ error: 'not_covered', careCard: input.careCard });

    if (input.encounterId) {
      const enc = await fhir.read('Encounter', input.encounterId);
      if (!enc || enc.subject?.reference !== `Patient/${pid}`) {
        return reply.code(400).send({ error: 'unknown_visit', encounterId: input.encounterId });
      }
    }

    const claim: Resource = {
      resourceType: 'Claim',
      id: randomUUID(),
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: facilityKind(providerOrg) === 'clinic' ? 'professional' : 'pharmacy' }] },
      use: 'claim',
      patient: { reference: `Patient/${pid}` },
      created: new Date().toISOString(),
      provider: { reference: p.org },
      insurer: coverage.payor[0],
      priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
      insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
      item: input.items.map((it, i) => ({
        sequence: i + 1,
        productOrService: { coding: [{ system: FEE_SYSTEM, code: it.code }] },
        quantity: { value: it.quantity },
        unitPrice: { value: it.unitPrice, currency: 'USD' },
        net: { value: money(it.quantity * it.unitPrice), currency: 'USD' },
        ...(input.encounterId ? { encounter: [{ reference: `Encounter/${input.encounterId}` }] } : {}),
      })),
      total: { value: money(input.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0)), currency: 'USD' },
    };
    await fhir.put(claim);

    const result = await adjudicate(claim);
    req.log.info({ claim: claim.id, decision: result.decision, approved: result.approvedTotal }, 'claim adjudicated');
    return reply.code(201).send(providerView(result));
  });

  // Claims list: providers see their own; lead and agent see all.
  app.get('/claims', { preHandler: requireScope() }, async (req, reply) => {
    const p = req.principal!;
    if (!canReadAll(p) && !canReadOwn(p)) return reply.code(403).send({ error: 'insufficient_scope' });
    const params = new URLSearchParams({ _revinclude: 'ClaimResponse:request', _sort: '-created', _count: '100' });
    if (!canReadAll(p)) params.set('provider', p.org ?? 'none');
    const bundle = await fhir.raw('GET', `Claim?${params}`);
    const resources: Resource[] = (bundle.entry ?? []).map((e: any) => e.resource);
    const claims = resources.filter((r) => r.resourceType === 'Claim');
    const responses = resources.filter((r) => r.resourceType === 'ClaimResponse');
    return claims.map((c) => summarize(c, responses));
  });

  app.get('/claims/:id', { preHandler: requireScope() }, async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const claim = await fhir.read('Claim', id);
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    const own = claim.provider?.reference === p.org;
    if (!(canReadAll(p) || (canReadOwn(p) && own))) return reply.code(403).send({ error: 'insufficient_scope' });
    const responses = await fhir.search('ClaimResponse', { request: `Claim/${id}` });
    return summarize(claim, responses);
  });

  // Re-run the agent, e.g. after a late visit sync. Never re-pays a paid claim.
  app.post('/claims/:id/adjudicate', { preHandler: requireScope('claims/decide') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const claim = await fhir.read('Claim', id);
    if (!claim) return reply.code(404).send({ error: 'not_found' });
    const responses = await fhir.search('ClaimResponse', { request: `Claim/${id}` });
    if (responses.some((r) => r.outcome === 'complete')) return reply.code(409).send({ error: 'already_paid' });
    return adjudicate(claim);
  });
}
