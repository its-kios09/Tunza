import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { cfg } from '../config';
import type { Actor } from './scopes';

export interface ClientRecord {
  clientId: string;
  name: string;
  actor: Actor;
  org?: string;          // FHIR reference, e.g. Organization/eastside-pharmacy
  secretHash: string;    // sha256 of the secret; the secret itself is never stored
  active: boolean;
  createdAt: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function loadClients(): Promise<ClientRecord[]> {
  try {
    return JSON.parse(await readFile(cfg.clientsFile, 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function saveClients(clients: ClientRecord[]) {
  await mkdir(path.dirname(cfg.clientsFile), { recursive: true });
  await writeFile(cfg.clientsFile, JSON.stringify(clients, null, 2));
}

export async function createClient(input: { clientId: string; name: string; actor: Actor; org?: string }) {
  const clients = await loadClients();
  if (clients.some((c) => c.clientId === input.clientId)) {
    throw new Error(`Client "${input.clientId}" already exists`);
  }
  const secret = randomBytes(32).toString('base64url');
  clients.push({ ...input, secretHash: sha256(secret), active: true, createdAt: new Date().toISOString() });
  await saveClients(clients);
  // local-only copy so scripts and tests can use it (gitignored)
  const key = input.clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  await appendFile(cfg.secretsFile, `${key}_ID=${input.clientId}\n${key}_SECRET=${secret}\n`);
  return secret;
}

export async function verifyClient(clientId: string, secret: string): Promise<ClientRecord | null> {
  const client = (await loadClients()).find((c) => c.clientId === clientId && c.active);
  if (!client) return null;
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(client.secretHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? client : null;
}
