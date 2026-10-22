import { parse as parseYaml } from 'yaml';
import type { ApiOperation, ApiParameter, ApiSpec } from '../schemas/documentationIndex.js';

type Json = Record<string, unknown>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** Parse an OpenAPI 3 or Swagger 2 document (JSON or YAML). Returns null when it is not one. */
export function parseOpenApi(text: string, specUrl: string): ApiSpec | null {
  let doc: unknown;
  const trimmed = text.replace(/^﻿/, '').trimStart();
  try {
    doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const root = doc as Json;
  const isV3 = typeof root['openapi'] === 'string';
  const isV2 = typeof root['swagger'] === 'string';
  if (!isV3 && !isV2) return null;
  const warnings: string[] = [];
  const info = (root['info'] as Json | undefined) ?? {};
  const components = ((isV3 ? root['components'] : root) as Json | undefined) ?? {};

  const resolve = (node: unknown, depth = 0): Json => {
    if (!node || typeof node !== 'object' || depth > 6) return (node as Json) ?? {};
    const obj = node as Json;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      let cur: unknown = root;
      for (const part of ref.slice(2).split('/')) cur = (cur as Json | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (!cur) {
        warnings.push(`unresolved $ref ${ref}`);
        return {};
      }
      return resolve(cur, depth + 1);
    }
    return obj;
  };

  const servers: string[] = [];
  if (isV3 && Array.isArray(root['servers'])) {
    for (const s of root['servers'] as Json[]) {
      const url = typeof s['url'] === 'string' ? s['url'] : undefined;
      if (!url) continue;
      let rendered = url;
      const vars = (s['variables'] as Record<string, Json> | undefined) ?? {};
      for (const [k, v] of Object.entries(vars)) rendered = rendered.replace(`{${k}}`, String(v['default'] ?? ''));
      try {
        servers.push(new URL(rendered, specUrl).toString().replace(/\/$/, ''));
      } catch {
        warnings.push(`unparseable server url ${url}`);
      }
    }
  } else if (isV2) {
    const host = typeof root['host'] === 'string' ? root['host'] : new URL(specUrl).host;
    const basePath = typeof root['basePath'] === 'string' ? root['basePath'] : '';
    const schemes = Array.isArray(root['schemes']) && root['schemes'].length ? (root['schemes'] as string[]) : [new URL(specUrl).protocol.replace(':', '')];
    for (const scheme of schemes) servers.push(`${scheme}://${host}${basePath}`.replace(/\/$/, ''));
  }
  if (servers.length === 0) servers.push(new URL(specUrl).origin);

  const schemesRaw = (isV3 ? (components['securitySchemes'] as Record<string, Json> | undefined) : (root['securityDefinitions'] as Record<string, Json> | undefined)) ?? {};
  const securitySchemes = Object.entries(schemesRaw).map(([name, s]) => ({ name, type: String(s['type'] ?? 'unknown'), ...(typeof s['in'] === 'string' ? { in: s['in'] as string } : {}) }));
  const globalSecurity = Array.isArray(root['security']) ? (root['security'] as Json[]) : [];

  const toParam = (p: Json): ApiParameter | null => {
    const r = resolve(p);
    const name = typeof r['name'] === 'string' ? r['name'] : undefined;
    const where = typeof r['in'] === 'string' ? r['in'] : undefined;
    if (!name || !where || !['query', 'path', 'header', 'cookie'].includes(where)) return null;
    const schema = resolve(r['schema'] ?? r);
    const type = typeof schema['type'] === 'string' ? schema['type'] : undefined;
    const en = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]).map(String) : undefined;
    return { name, in: where as ApiParameter['in'], required: r['required'] === true || where === 'path', ...(type ? { type } : {}), ...(en ? { enum: en } : {}), ...(typeof r['description'] === 'string' ? { description: (r['description'] as string).slice(0, 300) } : {}) };
  };

  const operations: ApiOperation[] = [];
  const paths = (root['paths'] as Record<string, Json> | undefined) ?? {};
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = resolve(item);
    const sharedParams = Array.isArray(pathItem['parameters']) ? (pathItem['parameters'] as Json[]) : [];
    for (const method of METHODS) {
      const op = pathItem[method] as Json | undefined;
      if (!op || typeof op !== 'object') continue;
      const params = [...sharedParams, ...(Array.isArray(op['parameters']) ? (op['parameters'] as Json[]) : [])].map(toParam).filter((x): x is ApiParameter => Boolean(x));
      const security = Array.isArray(op['security']) ? (op['security'] as Json[]) : globalSecurity;
      const schemeNames = Array.from(new Set(security.flatMap((s) => Object.keys(s))));
      const responses = (op['responses'] as Record<string, Json> | undefined) ?? {};
      const success = resolve(responses['200'] ?? responses['201'] ?? responses['default'] ?? {});
      const contentTypes: string[] = [];
      let responseKeys: string[] = [];
      let responseIsArray = false;
      if (isV3) {
        const content = (success['content'] as Record<string, Json> | undefined) ?? {};
        for (const [ct, media] of Object.entries(content)) {
          contentTypes.push(ct);
          const schema = resolve(media['schema']);
          if (schema['type'] === 'array') {
            responseIsArray = true;
            const items = resolve(schema['items']);
            responseKeys = Object.keys((items['properties'] as Json | undefined) ?? {});
          } else responseKeys = Object.keys((schema['properties'] as Json | undefined) ?? {});
        }
      } else {
        const produces = Array.isArray(op['produces']) ? (op['produces'] as string[]) : Array.isArray(root['produces']) ? (root['produces'] as string[]) : [];
        contentTypes.push(...produces);
        const schema = resolve(success['schema']);
        if (schema['type'] === 'array') {
          responseIsArray = true;
          responseKeys = Object.keys((resolve(schema['items'])['properties'] as Json | undefined) ?? {});
        } else responseKeys = Object.keys((schema['properties'] as Json | undefined) ?? {});
      }
      const hasRequestBody = Boolean(op['requestBody']) || (isV2 && params.some((p) => (p.in as string) === 'body')) || (Array.isArray(op['parameters']) && (op['parameters'] as Json[]).some((p) => p['in'] === 'body'));
      operations.push({
        operationId: typeof op['operationId'] === 'string' ? op['operationId'] : `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
        method,
        path,
        ...(typeof op['summary'] === 'string' ? { summary: (op['summary'] as string).slice(0, 200) } : {}),
        ...(typeof op['description'] === 'string' ? { description: (op['description'] as string).slice(0, 500) } : {}),
        tags: Array.isArray(op['tags']) ? (op['tags'] as unknown[]).map(String) : [],
        parameters: params,
        hasRequestBody,
        responseContentTypes: contentTypes,
        responseKeys: responseKeys.slice(0, 40),
        responseIsArray,
        authRequired: schemeNames.length > 0,
        securitySchemes: schemeNames,
        sideEffectClass: method === 'get' || method === 'head' || method === 'options' ? 'read' : 'write',
      });
    }
  }

  return {
    specUrl,
    format: isV3 ? 'openapi3' : 'swagger2',
    ...(typeof info['title'] === 'string' ? { title: info['title'] as string } : {}),
    ...(typeof info['version'] === 'string' ? { version: info['version'] as string } : {}),
    servers,
    securitySchemes,
    operations,
    parseWarnings: warnings.slice(0, 20),
  };
}

/** Match a concrete request path against a documented path template such as /api/products/{id}. */
export function matchesDocumentedPath(pathname: string, template: string): boolean {
  const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\}/g, '[^/]+')}/?$`);
  return re.test(pathname);
}
