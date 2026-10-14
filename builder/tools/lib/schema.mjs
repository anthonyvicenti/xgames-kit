// A small JSON Schema checker for the subset the game spec and the mechanics' params use (draft 2020-12 keywords:
// type, required, properties, additionalProperties, enum, const, pattern, minLength, maxLength, minimum, maximum,
// items, minItems, maxItems, default). No dependencies. → a list of "path: problem" strings (empty when valid).
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

export function check(schema, value, path = '', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  const at = path || '(root)';
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) out.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) out.push(`${at}: must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(t => fits(value, t))) { out.push(`${at}: must be ${types.join(' or ')}`); return out; }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${at}: must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, out));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${path ? path + '.' : ''}${k}: required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (props[k]) check(props[k], v, p, out);
      else if (schema.additionalProperties === false) out.push(`${p}: not allowed here`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, v, p, out);
    }
  }
  return out;
}

/** Fill `default`s from a schema's properties into a copy of an object (one level deep, then nested objects). */
export function withDefaults(schema, value) {
  if (!schema || typeof schema !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (!(k in out) && s && 'default' in s) out[k] = JSON.parse(JSON.stringify(s.default));
    else if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = withDefaults(s, out[k]);
  }
  return out;
}
