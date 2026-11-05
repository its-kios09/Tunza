import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { cfg } from '../config';
import { verifyClient } from './clients';
import { ACTOR_SCOPES } from './scopes';

// OAuth2 client_credentials. Accepts HTTP Basic auth or client_id/client_secret in the body.
export async function tokenRoutes(app: FastifyInstance) {
  app.post('/oauth/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    let clientId = body.client_id;
    let clientSecret = body.client_secret;

    const authz = req.headers.authorization;
    if (authz?.startsWith('Basic ')) {
      const decoded = Buffer.from(authz.slice(6), 'base64').toString();
      const i = decoded.indexOf(':');
      clientId = decoded.slice(0, i);
      clientSecret = decoded.slice(i + 1);
    }

    if (body.grant_type !== 'client_credentials') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (!clientId || !clientSecret) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    const client = await verifyClient(clientId, clientSecret);
    if (!client) return reply.code(401).send({ error: 'invalid_client' });

    const allowed = ACTOR_SCOPES[client.actor];
    const requested = body.scope ? body.scope.split(' ').filter(Boolean) : allowed;
    const denied = requested.filter((s) => !allowed.includes(s));
    if (denied.length) {
      return reply.code(400).send({ error: 'invalid_scope', denied });
    }
    const scope = requested.join(' ');

    const accessToken = await new SignJWT({ actor: client.actor, org: client.org, scope })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(client.clientId)
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime(`${cfg.tokenTtlSeconds}s`)
      .sign(cfg.jwtSecret);

    return { access_token: accessToken, token_type: 'Bearer', expires_in: cfg.tokenTtlSeconds, scope };
  });
}
