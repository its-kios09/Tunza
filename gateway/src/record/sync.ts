import type { FastifyInstance, FastifyReply } from 'fastify';
import { cfg } from '../config';
import { fhir, FhirError, type Resource } from '../fhir/client';
import { requireScope } from '../auth/guard';

// FHIR-shaped endpoint the Android FHIR SDK syncs against.
const SOURCE_SYSTEM = 'https://tunza.health/source-client';

// Clinical record types a field app may write. Registry types and Claims go through their own APIs.
const WRITABLE = new Set([
  'Encounter', 'Observation', 'Condition', 'Procedure', 'MedicationDispense',
  'ServiceRequest', 'Appointment', 'Provenance', 'CarePlan', 'Consent',
]);

// Readable types, each with the search parameter that pins results to the caller's team.
const READABLE: Record<string, string> = {
  Patient: 'organization',
  Coverage: 'beneficiary.organization',
  AllergyIntolerance: 'patient.organization',
  Encounter: 'patient.organization',
  Observation: 'patient.organization',
  Condition: 'patient.organization',
  Procedure: 'patient.organization',
  MedicationDispense: 'patient.organization',
  ServiceRequest: 'patient.organization',
  Appointment: 'patient.organization',
  CarePlan: 'patient.organization',
  Consent: 'patient.organization',
  Provenance: 'patient.organization',
};

// Query params that could pull in data from outside the team.
const STRIPPED_PARAMS = ['_include', '_revinclude', '_has', '_include:iterate', '_revinclude:iterate'];

function outcome(reply: FastifyReply, status: number, code: string, diagnostics: string) {
  return reply.code(status).type('application/fhir+json').send({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code, diagnostics }],
  });
}

function patientRefOf(r: Resource): string | undefined {
  const candidates = [
    r.subject?.reference,
    r.patient?.reference,
    r.beneficiary?.reference,
    ...(r.participant ?? []).map((p: any) => p.actor?.reference),
  ];
  return candidates.find((x): x is string => typeof x === 'string' && x.startsWith('Patient/'));
}

// HAPI writes its own base URL into paging links; point them at the gateway instead.
const rewriteLinks = (body: unknown) =>
  JSON.parse(JSON.stringify(body).split(cfg.fhirBase).join(`${cfg.publicUrl}/record/fhir`));

export async function recordRoutes(app: FastifyInstance) {
  // Upload: transaction Bundle from the field app.
  app.post('/record/fhir', { preHandler: requireScope('record/write') }, async (req, reply) => {
    const p = req.principal!;
    if (!p.org) return outcome(reply, 403, 'forbidden', 'client has no organization');

    const bundle = req.body as Resource | undefined;
    if (bundle?.resourceType !== 'Bundle' || !['transaction', 'batch'].includes(bundle.type)) {
      return outcome(reply, 400, 'invalid', 'expected a transaction Bundle');
    }
    const entries: any[] = bundle.entry ?? [];
    if (!entries.length) return outcome(reply, 400, 'invalid', 'bundle has no entries');

    const inBundle = new Set(entries.map((e) => `${e.resource?.resourceType}/${e.resource?.id}`));
    const patientAllowed = new Map<string, boolean>();

    for (const [i, e] of entries.entries()) {
      const r = e.resource as Resource | undefined;
      const method = e.request?.method;
      if (!r?.id) return outcome(reply, 400, 'invalid', `entry ${i}: resource with an id is required`);
      if (method !== 'PUT') return outcome(reply, 400, 'not-supported', `entry ${i}: only PUT is accepted (got ${method})`);
      if (!WRITABLE.has(r.resourceType)) {
        return outcome(reply, 400, 'forbidden', `entry ${i}: ${r.resourceType} cannot be written through record sync`);
      }

      if (r.resourceType === 'Provenance') {
        const targets: string[] = (r.target ?? []).map((t: any) => t.reference);
        if (!targets.length || targets.some((t) => !inBundle.has(t))) {
          return outcome(reply, 400, 'invalid', `entry ${i}: Provenance must target resources in the same bundle`);
        }
      } else {
        const ref = patientRefOf(r);
        if (!ref) return outcome(reply, 400, 'invalid', `entry ${i}: ${r.resourceType} must reference a Patient`);
        if (!patientAllowed.has(ref)) {
          const patient = await fhir.read('Patient', ref.split('/')[1]);
          patientAllowed.set(ref, !!patient && patient.managingOrganization?.reference === p.org);
        }
        if (!patientAllowed.get(ref)) {
          return outcome(reply, 403, 'forbidden', `entry ${i}: ${ref} is not a client of your team`);
        }
      }

      // Stamp who sent it; the team that ran the visit is the sender's org, whatever the payload says.
      r.meta = {
        ...(r.meta ?? {}),
        tag: [...(r.meta?.tag ?? []).filter((t: any) => t.system !== SOURCE_SYSTEM), { system: SOURCE_SYSTEM, code: p.clientId }],
      };
      if (r.resourceType === 'Encounter') r.serviceProvider = { reference: p.org };
      e.request = { method: 'PUT', url: `${r.resourceType}/${r.id}` };
    }

    try {
      const result = await fhir.raw('POST', '', {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: entries.map((e) => ({ fullUrl: e.fullUrl, resource: e.resource, request: e.request })),
      });
      req.log.info({ client: p.clientId, entries: entries.length }, 'record sync upload');
      return reply.type('application/fhir+json').send(result);
    } catch (err) {
      if (err instanceof FhirError && err.status < 500) {
        return reply.code(err.status).type('application/fhir+json').send(err.outcome);
      }
      throw err;
    }
  });

  // Download: searches, always limited to the caller's team.
  app.get('/record/fhir/:type', { preHandler: requireScope('record/read') }, async (req, reply) => {
    const p = req.principal!;
    if (!p.org) return outcome(reply, 403, 'forbidden', 'client has no organization');
    const { type } = req.params as { type: string };
    const restrict = READABLE[type];
    if (!restrict) return outcome(reply, 400, 'not-supported', `${type} is not readable through record sync`);

    const qs = new URLSearchParams(req.url.split('?')[1] ?? '');
    for (const k of STRIPPED_PARAMS) qs.delete(k);
    qs.delete(restrict);
    qs.set(restrict, p.org);

    const result = await fhir.raw('GET', `${type}?${qs}`);
    return reply.type('application/fhir+json').send(rewriteLinks(result));
  });

  // Paging: the SDK follows rewritten "next" links here.
  app.get('/record/fhir', { preHandler: requireScope('record/read') }, async (req, reply) => {
    const qs = new URLSearchParams(req.url.split('?')[1] ?? '');
    if (!qs.get('_getpages')) return outcome(reply, 400, 'not-supported', 'only paging (_getpages) is supported here');
    const result = await fhir.raw('GET', `?${qs}`);
    return reply.type('application/fhir+json').send(rewriteLinks(result));
  });
}
