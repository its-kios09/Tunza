// Usage: npm run client:create -- --id=eastside-pharmacy --actor=provider --org=Organization/eastside-pharmacy --name="Eastside Community Pharmacy"
import { createClient } from '../src/auth/clients';
import { ACTORS, type Actor } from '../src/auth/scopes';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
) as Record<string, string>;

if (!args.id || !args.actor || !ACTORS.includes(args.actor as Actor)) {
  console.error(`Usage: --id=<client-id> --actor=<${ACTORS.join('|')}> [--org=Organization/x] [--name="..."]`);
  process.exit(1);
}

const secret = await createClient({
  clientId: args.id,
  actor: args.actor as Actor,
  org: args.org || undefined,
  name: args.name || args.id,
});
console.log(`Created ${args.id} (${args.actor})`);
console.log(`Secret (shown once, also saved to data/client-secrets.local.env): ${secret}`);
