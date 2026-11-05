import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fhir, type Resource } from '../fhir/client';
import { requireScope, type Principal } from '../auth/guard';
import { facilityKind } from './facilities';

export const CARD_SYSTEM = 'https://tunza.health/care-card';

const ClientInput = z.object({
  initials: z.string().trim().min(1).max(10),
  sex: z.enum(['male', 'female', 'other', 'unknown']),
  ageYears: z.number().int().min(0).max(120),
  area: z.string().trim().max(120).optional(),
  fundId: z.string().min(1),
  allergies: z.array(z.object({ substance: z.string().min(1), reaction: z.string().optional() })).default([]),
  force: z.boolean().default(false),
});

const normInitials = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');

function summary(p: Resource, coverage?: Resource, allergies: Resource[] = []) {
  return {
    careCard: p.identifier?.find((i: any) => i.system === CARD_SYSTEM)?.value,
    initials: p.name?.[0]?.text,
    sex: p.gender,
    birthYear: p.birthDate,
    area: p.address?.[0]?.text ?? null,
    organization: p.managingOrganization?.reference,
    fund: coverage?.payor?.[0]?.reference ?? null,
    allergies: allergies.map((a) => ({
      substance: a.code?.text,
      reaction: a.reaction?.[0]?.manifestation?.[0]?.text ?? null,
    })),
  };
}

async function newCareCard(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const card = `T-${1000 + Math.floor(Math.random() * 9000)}`;
    if (!(await fhir.read('Patient', card.toLowerCase()))) return card;
  }
  throw new Error('Could not allocate a care card number');
}

const mayView = (p: Principal, patient: Resource) =>
  p.actor === 'lead' || patient.managingOrganization?.reference === p.org;

export async function clientRoutes(app: FastifyInstance) {
  // Register a client: Patient + Coverage (fund) + AllergyIntolerance, in one transaction.
  app.post('/registry/clients', { preHandler: requireScope('registry/client.write') }, async (req, reply) => {
    const p = req.principal!;
    if (!p.org) return reply.code(403).send({ error: 'client_has_no_organization' });
    const input = ClientInput.parse(req.body);

    const fund = await fhir.read('Organization', input.fundId);
    if (!fund || facilityKind(fund) !== 'fund') {
      return reply.code(400).send({ error: 'unknown_fund', fundId: input.fundId });
    }

    const birthYear = new Date().getFullYear() - input.ageYears;
    const candidates = (
      await fhir.search('Patient', {
        gender: input.sex,
        birthdate: [`ge${birthYear - 2}`, `le${birthYear + 2}`],
        organization: p.org,
        _count: '100',
      })
    ).filter((x) => normInitials(x.name?.[0]?.text ?? '') === normInitials(input.initials));

    if (candidates.length && !input.force) {
      return reply.code(409).send({
        error: 'possible_duplicate',
        message: 'A client with the same initials, sex and similar age is already registered by your team. Scan their care card, or resend with force=true.',
        candidates: candidates.map((c) => summary(c)),
      });
    }

    const careCard = await newCareCard();
    const id = careCard.toLowerCase();

    const patient: Resource = {
      resourceType: 'Patient',
      id,
      active: true,
      identifier: [{ system: CARD_SYSTEM, value: careCard }],
      name: [{ text: input.initials }],
      gender: input.sex,
      birthDate: String(birthYear),
      ...(input.area ? { address: [{ text: input.area }] } : {}),
      managingOrganization: { reference: p.org },
    };
    const coverage: Resource = {
      resourceType: 'Coverage',
      id: `cov-${id}`,
      status: 'active',
      beneficiary: { reference: `Patient/${id}` },
      payor: [{ reference: `Organization/${input.fundId}` }],
    };
    const allergies: Resource[] = input.allergies.map((a, i) => ({
      resourceType: 'AllergyIntolerance',
      id: `allergy-${id}-${i + 1}`,
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
      },
      code: { text: a.substance },
      patient: { reference: `Patient/${id}` },
      ...(a.reaction ? { reaction: [{ manifestation: [{ text: a.reaction }] }] } : {}),
    }));

    await fhir.transaction([patient, coverage, ...allergies]);
    return reply.code(201).send(summary(patient, coverage, allergies));
  });

  // Look up a client by care card (e.g. after scanning the QR).
  app.get('/registry/clients/:careCard', { preHandler: requireScope('registry/client.read') }, async (req, reply) => {
    const { careCard } = req.params as { careCard: string };
    const id = careCard.toLowerCase();
    const patient = await fhir.read('Patient', id);
    if (!patient) return reply.code(404).send({ error: 'not_found' });
    if (!mayView(req.principal!, patient)) return reply.code(403).send({ error: 'not_your_client' });

    const [coverage] = await fhir.search('Coverage', { beneficiary: `Patient/${id}`, status: 'active' });
    const allergies = await fhir.search('AllergyIntolerance', { patient: `Patient/${id}` });
    return summary(patient, coverage, allergies);
  });

  // The team's client list.
  app.get('/registry/clients', { preHandler: requireScope('registry/client.read') }, async (req) => {
    const p = req.principal!;
    const patients = await fhir.search('Patient', { organization: p.org, _count: '200' });
    return patients.map((x) => summary(x));
  });
}
