import { cfg } from '../config';

export type Resource = { resourceType: string; id?: string; [k: string]: any };

export class FhirError extends Error {
  constructor(public status: number, public outcome: unknown) {
    super(`FHIR server returned ${status}`);
  }
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const url = path ? `${cfg.fhirBase}/${path}` : cfg.fhirBase;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/fhir+json',
      // HAPI reuses identical search results for 60s by default; the gateway must always see fresh data
      'Cache-Control': 'no-cache',
      ...(body ? { 'Content-Type': 'application/fhir+json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new FhirError(res.status, json);
  return json as T;
}

// Thin FHIR client. HAPI is private: only the gateway talks to it.
export const fhir = {
  raw: call,

  async read<T extends Resource = Resource>(type: string, id: string): Promise<T | null> {
    try {
      return await call<T>('GET', `${type}/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof FhirError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  },

  async search<T extends Resource = Resource>(
    type: string,
    params: Record<string, string | string[] | undefined>,
  ): Promise<T[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
    }
    const bundle = await call<any>('GET', `${type}?${qs}`);
    return (bundle.entry ?? [])
      .map((e: any) => e.resource as T)
      .filter((r: T) => r.resourceType === type);
  },

  put<T extends Resource>(r: T): Promise<T> {
    return call<T>('PUT', `${r.resourceType}/${r.id}`, r);
  },

  async delete(type: string, id: string): Promise<void> {
    await call('DELETE', `${type}/${encodeURIComponent(id)}`);
  },

  // All-or-nothing write of resources with client-assigned ids.
  transaction(resources: Resource[]): Promise<any> {
    return call('POST', '', {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: resources.map((resource) => ({
        resource,
        request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
      })),
    });
  },
};
