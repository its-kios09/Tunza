import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { cfg } from '../config';
import type { Actor } from './scopes';

export interface Principal {
  clientId: string;
  actor: Actor;
  org?: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// Use as a preHandler: { preHandler: requireScope('claims/submit') }
export function requireScope(...needed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing_token' });
    }
    try {
      const { payload } = await jwtVerify(h.slice(7), cfg.jwtSecret, { issuer: cfg.issuer });
      const scopes = String(payload.scope ?? '').split(' ').filter(Boolean);
      const missing = needed.filter((s) => !scopes.includes(s));
      if (missing.length) {
        return reply.code(403).send({ error: 'insufficient_scope', missing });
      }
      req.principal = {
        clientId: String(payload.sub),
        actor: payload.actor as Actor,
        org: payload.org as string | undefined,
        scopes,
      };
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  };
}
