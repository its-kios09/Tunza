import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ path: path.resolve(process.cwd(), '../.env.sandbox') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (check ../.env.sandbox)`);
  return v;
}

export const cfg = {
  port: Number(process.env.GATEWAY_PORT ?? 7070),
  issuer: 'tunza-gateway',
  jwtSecret: new TextEncoder().encode(required('GATEWAY_JWT_SECRET')),
  tokenTtlSeconds: 3600,
  fhirBase: required('FHIR_BASE'),
  clientsFile: path.resolve(process.cwd(), 'data/clients.json'),
  secretsFile: path.resolve(process.cwd(), 'data/client-secrets.local.env'),
};
