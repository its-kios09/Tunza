// Who can do what. Each registered client is one actor type.
export type Actor = 'field-app' | 'provider' | 'lead' | 'donor-web' | 'agent';

export const ACTOR_SCOPES: Record<Actor, string[]> = {
  'field-app': ['registry/facility.read', 'registry/client.read', 'registry/client.write', 'record/read', 'record/write', 'consent/write'],
  provider:    ['registry/facility.read', 'claims/submit', 'claims/read.own'],
  lead:        ['registry/facility.read', 'registry/facility.write', 'registry/client.read', 'record/read', 'claims/read', 'claims/decide'],
  'donor-web': ['receipts/read'],
  agent:       ['record/read', 'claims/read', 'claims/decide', 'payouts/send'],
};

export const ACTORS = Object.keys(ACTOR_SCOPES) as Actor[];
