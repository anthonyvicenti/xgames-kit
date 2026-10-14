// A small JSON Schema validator for the keywords economy.schema.json uses, so the kit needs no schema library:
// type, const, enum, pattern, minimum, maximum, exclusiveMinimum, minLength, maxLength, minItems, maxItems, items,
// required, properties, additionalProperties, propertyNames, anyOf and local $ref. Pure.
import { readFileSync } from 'node:fs';

export const SCHEMA = JSON.parse(readFileSync(new URL('./economy.schema.json', import.meta.url), 'utf8'));

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v));
const show = (v) => JSON.stringify(v)?.slice(0, 60);

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref is supported: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
}

/** Every way `value` breaks `schema`, as { path, message }. An empty list means it is valid. */
export function validate(value, schema = SCHEMA, root = schema, path = 'economy') {
  const errors = [];
  const add = (message) => errors.push({ path, message });
  if (schema.$ref) return validate(value, resolve(root, schema.$ref), root, path);
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => validate(value, s, root, path));
    if (!results.some((r) => r.length === 0)) {
      const wanted = schema.description ?? results.flat().map((e) => e.message).join('; or ');
      add(`${show(value)} is not allowed here (${wanted})`);
    }
    return errors;
  }
  if ('const' in schema && value !== schema.const) add(`must be ${show(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) add(`must be one of ${schema.enum.map(show).join(', ')}`);
  if (schema.type && !isType(value, schema.type)) {
    add(`must be ${schema.type === 'integer' ? 'a whole number' : `a ${schema.type}`}`);
    return errors;
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`${show(value)} is not in the expected form`);
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`must have at most ${schema.maxLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) add(`must be more than ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`can have at most ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) add(`needs "${key}"`);
    for (const [key, v] of Object.entries(value)) {
      const where = `${path}.${key}`;
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key)) errors.push({ path: where, message: 'is not a name this place takes' });
      if (schema.properties && key in schema.properties) errors.push(...validate(v, schema.properties[key], root, where));
      else if (schema.additionalProperties === false) errors.push({ path: where, message: 'is not a field this place takes' });
      else if (typeOf(schema.additionalProperties) === 'object') errors.push(...validate(v, schema.additionalProperties, root, where));
    }
  }
  return errors;
}
