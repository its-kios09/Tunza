import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ path: path.resolve(process.cwd(), '../.env.sandbox') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (check ../.env.sandbox)`);
  return v;
}

const port = Number(process.env.GATEWAY_PORT ?? 7071);

export const cfg = {
  port,
  publicUrl: (process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  issuer: 'tunza-gateway',
  jwtSecret: new TextEncoder().encode(required('GATEWAY_JWT_SECRET')),
  tokenTtlSeconds: 3600,
  fhirBase: required('FHIR_BASE').replace(/\/$/, ''),
  clientsFile: path.resolve(process.cwd(), 'data/clients.json'),
  secretsFile: path.resolve(process.cwd(), 'data/client-secrets.local.env'),
  paypal: {
    api: (process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
    clientId: required('PAYPAL_CLIENT_ID'),
    clientSecret: required('PAYPAL_CLIENT_SECRET'),
  },
};
