// zod 4 schemas to an OpenAPI 3.1 document. Used twice: by @hall/protocol for the device contract
// (protocol/v1/openapi.json) and by hall-api for the whole API (docs/api/openapi.json).
//
// Every request body and every answer becomes a named schema (components/schemas), so a client
// generator makes a model of each. Requests and answers differ where a field has a default: a
// request may leave it out, an answer always has it. Each schema is converted twice, as an answer
// ("output") and as a request ("input"); where the two differ, the request's is `<Name>Input`.
import { z } from 'zod';

export type Json = Record<string, unknown>;

const REF = '#/components/schemas/';

/** Schemas with a name of their own in the contract. */
export class SchemaNames {
  readonly byName = new Map<string, z.ZodType>();
  readonly bySchema = new Map<z.ZodType, string>();

  /** Names `schema` (once per name) and returns it, for `const Site = names.add('Site', z.object(...))`. */
  add<T extends z.ZodType>(name: string, schema: T): T {
    const had = this.byName.get(name);
    if (had && had !== schema) throw new Error(`openapi: two schemas are named ${name}`);
    const other = this.bySchema.get(schema);
    if (other && other !== name) throw new Error(`openapi: ${name} is already named ${other}`);
    this.byName.set(name, schema);
    this.bySchema.set(schema, name);
    return schema;
  }

  /** Every name of `other` into this one. */
  merge(other: SchemaNames): this {
    for (const [name, schema] of other.byName) this.add(name, schema);
    return this;
  }
}

export interface ResponseDoc {
  description: string;
  /** A JSON body. */
  schema?: z.ZodType;
  /** A body that is not JSON (e.g. text/html), described in words. */
  content?: { type: string; description: string };
}

export interface OperationDoc {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Fastify style (`/api/sites/:id`); written `/api/sites/{id}`. */
  path: string;
  operationId?: string;
  summary: string;
  description?: string;
  tags: string[];
  /** Security requirement names; `[]` for a public route; absent: the document's default. */
  security?: string[];
  params?: z.ZodObject;
  query?: z.ZodObject;
  /** Request headers the operation reads (name → description), e.g. the device signature headers. */
  headers?: Record<string, { description: string; required: boolean; schema?: z.ZodType }>;
  body?: z.ZodType;
  responses: Record<number, ResponseDoc>;
  /** Extra `x-` fields on the operation. */
  extensions?: Record<string, unknown>;
}

export interface DocumentDoc {
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description: string }[];
  securitySchemes?: Record<string, Json>;
  /** The security requirement of an operation that does not say. */
  defaultSecurity?: string[];
  operations: OperationDoc[];
  names: SchemaNames;
  /** Extra `x-` fields at the root. */
  extensions?: Record<string, unknown>;
}

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');

/** GET /api/sites/:id → getSitesById; POST /api/device/heartbeat → postDeviceHeartbeat. */
export function operationIdOf(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  const words = parts.map((p) => (p.startsWith(':') ? `By${pascal(p.slice(1))}` : pascal(p)));
  return method.toLowerCase() + (words.join('') || 'Root');
}

export const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

type Io = 'input' | 'output';

/** zod's JSON Schema, tidied for a contract: answers may gain fields, no noise. */
function tidy(io: Io) {
  return (ctx: { zodSchema: z.core.$ZodType; jsonSchema: Json }) => {
    const def = (ctx.zodSchema as unknown as { _zod: { def: { type: string; catchall?: { _zod: { def: { type: string } } } } } })._zod.def;
    const json = ctx.jsonSchema;
    // A plain z.object strips unknown keys: in an answer that means "may carry more", not "must not".
    if (def.type === 'object' && json['additionalProperties'] === false && def.catchall?._zod.def.type !== 'never') {
      delete json['additionalProperties'];
    }
    // z.number().int() writes the safe-integer range: implied, left out.
    if (json['type'] === 'integer' && json['minimum'] === Number.MIN_SAFE_INTEGER) delete json['minimum'];
    if (json['type'] === 'integer' && json['maximum'] === Number.MAX_SAFE_INTEGER) delete json['maximum'];
    // An ISO time: format date-time says it; zod's long pattern is noise.
    if (json['format'] === 'date-time' && typeof json['pattern'] === 'string') delete json['pattern'];
    // A whole-number constant or enum is an integer.
    if (json['type'] === 'number' && (Number.isInteger(json['const']) || (Array.isArray(json['enum']) && (json['enum'] as unknown[]).every(Number.isInteger)))) {
      json['type'] = 'integer';
    }
    void io;
  };
}

function convertAll(reg: z.core.$ZodRegistry<{ id: string }>, io: Io, suffix: string): Record<string, Json> {
  const out = z.toJSONSchema(reg, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    uri: (id) => `${REF}${id}${suffix}`,
    override: tidy(io),
  }) as { schemas: Record<string, Json> };
  for (const s of Object.values(out.schemas)) {
    delete s['$schema'];
    delete s['$id'];
  }
  return out.schemas;
}

/** A JSON Schema of one schema, without refs (path and query parameters). */
export function jsonSchemaOf(schema: z.ZodType, io: Io = 'input'): Json {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any', override: tidy(io) }) as Json;
  delete json['$schema'];
  return json;
}

/** Replaces every `$ref` string by `map(ref)`. */
function mapRefs(value: unknown, map: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, map));
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === '$ref' && typeof v === 'string' ? map(v) : mapRefs(v, map);
    return out;
  }
  return value;
}

function collectRefs(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') into.add(v.slice(REF.length).replace(/Input$/, ''));
      else collectRefs(v, into);
    }
  }
  return into;
}

function collectRawRefs(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectRawRefs(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') into.add(v.slice(REF.length));
      else collectRawRefs(v, into);
    }
  }
  return into;
}

/**
 * Converts every named schema as an answer and as a request. Returns the components and, per name,
 * the component a request uses (`Name` or `NameInput`).
 */
export function components(names: SchemaNames): { schemas: Record<string, Json>; inputName: (name: string) => string } {
  const reg = z.registry<{ id: string }>();
  for (const [name, schema] of names.byName) reg.add(schema, { id: name });
  const output = convertAll(reg, 'output', '');
  const input = convertAll(reg, 'input', 'Input');
  // Which inputs differ from their output: their own shape, or a schema they refer to (to a fixed point).
  const sameShape = (name: string) =>
    JSON.stringify(mapRefs(input[name], (r) => r.replace(/Input$/, ''))) === JSON.stringify(output[name]);
  const differs = new Set(Object.keys(output).filter((n) => !sameShape(n)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of Object.keys(output)) {
      if (differs.has(n)) continue;
      if ([...collectRefs(input[n], new Set())].some((r) => differs.has(r))) {
        differs.add(n);
        grew = true;
      }
    }
  }
  const inputName = (name: string) => (differs.has(name) ? `${name}Input` : name);
  const schemas: Record<string, Json> = {};
  for (const name of Object.keys(output).sort()) {
    schemas[name] = output[name]!;
    if (differs.has(name)) {
      schemas[`${name}Input`] = mapRefs(input[name], (r) => {
        const target = r.slice(REF.length).replace(/Input$/, '');
        return REF + inputName(target);
      }) as Json;
    }
  }
  return { schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))), inputName };
}

function parameters(where: 'path' | 'query', obj: z.ZodObject | undefined): Json[] {
  if (!obj) return [];
  return Object.entries(obj.shape).map(([name, field]) => {
    const f = field as z.ZodType;
    const json = jsonSchemaOf(f, 'input');
    const description = json['description'];
    delete json['description'];
    const p: Json = { name, in: where, required: where === 'path' ? true : !f.safeParse(undefined).success, schema: json };
    if (description) p['description'] = description;
    return p;
  });
}

/** The OpenAPI 3.1 document. */
export function buildOpenApi(doc: DocumentDoc): Json {
  const names = new SchemaNames().merge(doc.names);
  const ops = doc.operations.map((op) => ({ ...op, operationId: op.operationId ?? operationIdOf(op.method, op.path) }));
  // Anonymous bodies and answers get a name from their operation.
  const nameOf = (schema: z.ZodType, fallback: string): string => {
    const had = names.bySchema.get(schema);
    if (had) return had;
    names.add(fallback, schema);
    return fallback;
  };
  const bodies = new Map<string, string>();
  const answers = new Map<string, string>();
  for (const op of ops) {
    const base = pascal(op.operationId);
    if (op.body) bodies.set(op.operationId, nameOf(op.body, `${base}Request`));
    for (const [status, r] of Object.entries(op.responses)) {
      if (r.schema) answers.set(`${op.operationId} ${status}`, nameOf(r.schema, Number(status) < 300 ? `${base}Response` : `${base}${status}`));
    }
  }
  const { schemas, inputName } = components(names);

  const paths: Record<string, Json> = {};
  for (const op of ops) {
    const operation: Json = {
      operationId: op.operationId,
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      tags: op.tags,
    };
    const params = [
      ...parameters('path', op.params),
      ...parameters('query', op.query),
      ...Object.entries(op.headers ?? {}).map(([name, h]) => ({
        name,
        in: 'header',
        required: h.required,
        description: h.description,
        schema: h.schema ? jsonSchemaOf(h.schema) : { type: 'string' },
      })),
    ];
    if (params.length) operation['parameters'] = params;
    if (op.body) {
      operation['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: { $ref: REF + inputName(bodies.get(op.operationId)!) } } },
      };
    }
    const responses: Json = {};
    for (const [status, r] of Object.entries(op.responses).sort(([a], [b]) => Number(a) - Number(b))) {
      const content: Json = {};
      if (r.schema) content['application/json'] = { schema: { $ref: REF + answers.get(`${op.operationId} ${status}`)! } };
      if (r.content) content[r.content.type] = { schema: { type: 'string', description: r.content.description } };
      responses[status] = { description: r.description, ...(Object.keys(content).length ? { content } : {}) };
    }
    operation['responses'] = responses;
    const security = op.security ?? doc.defaultSecurity;
    if (security) operation['security'] = security.map((s) => ({ [s]: [] }));
    Object.assign(operation, op.extensions ?? {});
    const path = openApiPath(op.path);
    paths[path] = { ...(paths[path] ?? {}), [op.method.toLowerCase()]: operation };
  }
  const sortedPaths = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  // Keep only the request models a request uses (directly or through another request model).
  const used = new Set<string>();
  const visit = (value: unknown) => {
    for (const ref of collectRawRefs(value, new Set())) {
      if (used.has(ref)) continue;
      used.add(ref);
      visit(schemas[ref]);
    }
  };
  visit(paths);
  for (const name of Object.keys(schemas)) if (name.endsWith('Input') && names.byName.has(name.slice(0, -5)) && !used.has(name)) delete schemas[name];

  return {
    openapi: '3.1.0',
    info: doc.info,
    ...(doc.servers ? { servers: doc.servers } : {}),
    ...(doc.tags ? { tags: doc.tags } : {}),
    paths: sortedPaths,
    components: {
      schemas,
      ...(doc.securitySchemes ? { securitySchemes: doc.securitySchemes } : {}),
    },
    ...(doc.extensions ?? {}),
  };
}

/** The document as committed: two-space JSON and a final newline. */
export const stringify = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
