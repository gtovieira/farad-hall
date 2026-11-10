import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApi, operationIdOf, SchemaNames } from '../src/index.js';

describe('buildOpenApi', () => {
  const names = new SchemaNames();
  const Address = names.add('Address', z.object({ city: z.string(), uf: z.string().length(2).default('BA') }));
  const Site = names.add('Site', z.object({ id: z.uuid(), address: Address, kind: z.enum(['a', 'b']) }));
  const Strict = names.add('Strict', z.strictObject({ a: z.number().int() }));
  const doc = buildOpenApi({
    info: { title: 't', version: '1.0.0' },
    defaultSecurity: ['session'],
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 's' } },
    names,
    operations: [
      {
        method: 'POST',
        path: '/api/sites',
        summary: 'create',
        tags: ['sites'],
        body: z.object({ name: z.string(), address: Address }),
        responses: { 201: { description: 'ok', schema: Site } },
      },
      {
        method: 'GET',
        path: '/api/sites/:id',
        summary: 'one',
        tags: ['sites'],
        security: [],
        params: z.object({ id: z.uuid().describe('the site') }),
        query: z.object({ limit: z.coerce.number().int().optional() }),
        responses: { 200: { description: 'ok', schema: Strict } },
      },
    ],
  }) as any;

  it('names operations and paths', () => {
    expect(operationIdOf('GET', '/api/sites/:id')).toBe('getSitesById');
    expect(doc.paths['/api/sites/{id}'].get.operationId).toBe('getSitesById');
    expect(doc.paths['/api/sites/{id}'].get.security).toEqual([]);
    expect(doc.paths['/api/sites'].post.security).toEqual([{ session: [] }]);
  });

  it('gives a request with a defaulted field its own Input model', () => {
    const s = doc.components.schemas;
    expect(s.Address.required).toEqual(['city', 'uf']);
    expect(s.AddressInput.required).toEqual(['city']);
    expect(s.PostSitesRequest).toBeDefined();
    expect(doc.paths['/api/sites'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/PostSitesRequestInput');
    expect(s.PostSitesRequestInput.properties.address.$ref).toBe('#/components/schemas/AddressInput');
    expect(s.Site.properties.address.$ref).toBe('#/components/schemas/Address');
    expect(s.SiteInput).toBeUndefined();
  });

  it('lets answers carry more fields unless strict', () => {
    expect(doc.components.schemas.Site.additionalProperties).toBeUndefined();
    expect(doc.components.schemas.Strict.additionalProperties).toBe(false);
  });

  it('writes path and query parameters', () => {
    const params = doc.paths['/api/sites/{id}'].get.parameters;
    expect(params[0]).toMatchObject({ name: 'id', in: 'path', required: true, description: 'the site', schema: { type: 'string', format: 'uuid' } });
    expect(params[1]).toMatchObject({ name: 'limit', in: 'query', required: false });
  });

  it('refuses two schemas with one name', () => {
    expect(() => names.add('Site', z.string())).toThrow();
  });
});
