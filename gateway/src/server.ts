import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { ZodError } from 'zod';
import { cfg } from './config';
import { tokenRoutes } from './auth/token';
import { requireScope } from './auth/guard';
import { FhirError } from './fhir/client';
import { facilityRoutes } from './registry/facilities';
import { clientRoutes } from './registry/clients';
import { recordRoutes } from './record/sync';
import { claimRoutes } from './claims/routes';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 5 * 1024 * 1024 });

// The FHIR SDK sends application/fhir+json
app.addContentTypeParser('application/fhir+json', { parseAs: 'string' }, app.getDefaultJsonParser('ignore', 'ignore'));

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: 'invalid_request',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof FhirError) {
    req.log.error({ outcome: err.outcome }, 'FHIR error');
    return reply.code(502).send({ error: 'fhir_error', status: err.status });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'internal_error' });
});

await app.register(formbody);
await app.register(tokenRoutes);
await app.register(facilityRoutes);
await app.register(clientRoutes);
await app.register(recordRoutes);
await app.register(claimRoutes);

app.get('/health', async () => {
  let fhirStatus = 'down';
  try {
    const r = await fetch(`${cfg.fhirBase}/metadata`, { signal: AbortSignal.timeout(3000) });
    fhirStatus = r.ok ? 'up' : `http ${r.status}`;
  } catch {}
  return { gateway: 'up', fhir: fhirStatus, publicUrl: cfg.publicUrl };
});

app.get('/whoami', { preHandler: requireScope() }, async (req) => req.principal);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
