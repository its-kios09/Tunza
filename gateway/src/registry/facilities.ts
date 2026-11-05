import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fhir, type Resource } from '../fhir/client';
import { requireScope, type Principal } from '../auth/guard';

export const PAYEE_SYSTEM = 'https://tunza.health/paypal-payee';
const KIND_SYSTEM = 'https://tunza.health/facility-kind';
const ORG_TYPE = 'http://terminology.hl7.org/CodeSystem/organization-type';
const KINDS = ['outreach-team', 'pharmacy', 'clinic', 'fund'] as const;

const FacilityInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/, 'lowercase letters, digits and dashes').optional(),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(KINDS),
  paypalEmail: z.string().email().optional(),
});
type FacilityInput = z.infer<typeof FacilityInput>;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

function toOrganization(id: string, f: FacilityInput): Resource {
  return {
    resourceType: 'Organization',
    id,
    active: true,
    name: f.name,
    type: [{
      coding: [
        { system: ORG_TYPE, code: f.kind === 'fund' ? 'pay' : 'prov' },
        { system: KIND_SYSTEM, code: f.kind },
      ],
    }],
    identifier: f.paypalEmail ? [{ system: PAYEE_SYSTEM, value: f.paypalEmail }] : [],
  };
}

export function facilityKind(o: Resource): string | undefined {
  return o.type?.flatMap((t: any) => t.coding ?? []).find((c: any) => c.system === KIND_SYSTEM)?.code;
}

export function payeeEmail(o: Resource): string | undefined {
  return o.identifier?.find((i: any) => i.system === PAYEE_SYSTEM)?.value;
}

const canSeePayee = (p: Principal, orgId: string) =>
  p.actor === 'lead' || p.actor === 'agent' || p.org === `Organization/${orgId}`;

function view(o: Resource, p: Principal) {
  const payee = payeeEmail(o);
  return {
    id: o.id,
    name: o.name,
    kind: facilityKind(o),
    active: o.active,
    ...(canSeePayee(p, o.id!) ? { paypalEmail: payee ?? null } : { payoutReady: Boolean(payee) }),
  };
}

export async function facilityRoutes(app: FastifyInstance) {
  app.post('/registry/facilities', { preHandler: requireScope('registry/facility.write') }, async (req, reply) => {
    const input = FacilityInput.parse(req.body);
    const id = input.id ?? slug(input.name);
    if (await fhir.read('Organization', id)) {
      return reply.code(409).send({ error: 'facility_exists', id });
    }
    const saved = await fhir.put(toOrganization(id, input));
    return reply.code(201).send(view(saved, req.principal!));
  });

  app.get('/registry/facilities', { preHandler: requireScope('registry/facility.read') }, async (req) => {
    const { kind } = z.object({ kind: z.enum(KINDS).optional() }).parse(req.query);
    const orgs = await fhir.search('Organization', {
      type: kind ? `${KIND_SYSTEM}|${kind}` : undefined,
      _count: '200',
    });
    return orgs.map((o) => view(o, req.principal!));
  });

  app.get('/registry/facilities/:id', { preHandler: requireScope('registry/facility.read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = await fhir.read('Organization', id);
    return org ? view(org, req.principal!) : reply.code(404).send({ error: 'not_found' });
  });
}
