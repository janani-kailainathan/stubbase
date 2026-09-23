/**
 * Data models: what a resource's records look like, kept beside the data in
 * the tenant's models/ folder so the AI Co-Pilot can learn a table's shape
 * without being sent its records.
 *
 * A model holds two kinds of fact, kept apart because they live differently:
 *   - observed: the record count, and per top-level field how many records
 *     carry it and with which types. Always derived from the records, so it is
 *     rebuilt whole from the table on every write rather than patched — a field
 *     no record has any more simply drops out, whatever path changed the data.
 *   - declared: whether a field is required. It says what the user intends,
 *     which the data cannot, so it survives every rebuild — including a field
 *     declared required that no record has yet.
 *
 * Pure functions only: the core owns the files and when they are written.
 */

export type FieldType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface FieldModel {
  /** Records holding each type in this field. Top level only: nested values count as object or array. */
  types: Partial<Record<FieldType, number>>;
  /** Records that carry the field at all. */
  count: number;
  /** Declared by the user. Recorded, not enforced. */
  required: boolean;
}

export interface DataModel {
  /** The resource the model describes — for a draft, the resource it stages. */
  resource: string;
  records: number;
  fields: Record<string, FieldModel>;
  /** Fields beyond MAX_MODEL_FIELDS that were left out, so a model stays small however wide a table gets. */
  omittedFields?: number;
  /** The data file this was built from, so a model gone stale behind the core's back is noticed and rebuilt. */
  source: { bytes: number; modifiedAt: number };
}

/** The observed half of a model, before the declared half is merged in. */
export type ObservedModel = Omit<DataModel, "source">;

export const MAX_MODEL_FIELDS = 200;

/**
 * Sets a field on a fields object as an own property. Field names are user
 * data, and a plain `fields[key] = …` with the key `__proto__` would set the
 * object's prototype instead of making a field.
 */
function put(fields: Record<string, FieldModel>, key: string, value: FieldModel) {
  Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
}
/** Field names are data too; one longer than this is left out rather than stored. */
const MAX_FIELD_NAME = 128;

export function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/**
 * Counts what the records hold. One pass, top level only. A Map rather than an
 * object while counting, because field names are user data and `__proto__` as
 * a plain object key would set the prototype instead of making a field.
 */
export function observe(resource: string, records: unknown[]): ObservedModel {
  const fields = new Map<string, { types: Map<FieldType, number>; count: number }>();
  let omitted = 0;
  const omittedNames = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    for (const [key, value] of Object.entries(record)) {
      if (key.length > MAX_FIELD_NAME) continue;
      let field = fields.get(key);
      if (!field) {
        if (fields.size >= MAX_MODEL_FIELDS) {
          if (!omittedNames.has(key)) {
            omittedNames.add(key);
            omitted++;
          }
          continue;
        }
        field = { types: new Map(), count: 0 };
        fields.set(key, field);
      }
      field.count++;
      const type = typeOf(value);
      field.types.set(type, (field.types.get(type) ?? 0) + 1);
    }
  }
  return {
    resource,
    records: records.length,
    fields: Object.fromEntries(
      [...fields].map(([key, f]) => [
        key,
        { types: Object.fromEntries(f.types) as FieldModel["types"], count: f.count, required: false },
      ]),
    ),
    ...(omitted > 0 ? { omittedFields: omitted } : {}),
  };
}

/**
 * The observed model with the previous model's declarations carried over. A
 * field declared required stays in the model even when no record has it —
 * that is exactly what "required" will need to report once it is enforced.
 */
export function withDeclared(
  observed: ObservedModel,
  previous: DataModel | null,
  source: DataModel["source"],
): DataModel {
  const fields: Record<string, FieldModel> = { ...observed.fields };
  for (const [key, field] of Object.entries(previous?.fields ?? {})) {
    if (!field.required) continue;
    put(fields, key, Object.hasOwn(fields, key) ? { ...fields[key], required: true } : { types: {}, count: 0, required: true });
  }
  return { ...observed, fields, source };
}

/**
 * Sets or clears `required` on the named fields. Clearing it on a field no
 * record holds removes the field: it was only in the model because it was
 * declared.
 */
export function setRequired(model: DataModel, changes: Map<string, boolean>): DataModel {
  const fields: Record<string, FieldModel> = { ...model.fields };
  for (const [key, required] of changes) {
    const current = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (current) {
      if (!required && current.count === 0) delete fields[key];
      else put(fields, key, { ...current, required });
    } else if (required) {
      put(fields, key, { types: {}, count: 0, required: true });
    }
  }
  return { ...model, fields };
}

/** A model file read back from disk, or null when it is missing, unreadable or not a model. */
export function parseModel(raw: unknown): DataModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Partial<DataModel>;
  if (typeof m.resource !== "string" || typeof m.records !== "number") return null;
  if (!m.fields || typeof m.fields !== "object" || Array.isArray(m.fields)) return null;
  if (!m.source || typeof m.source.bytes !== "number" || typeof m.source.modifiedAt !== "number") return null;
  for (const field of Object.values(m.fields))
    if (!field || typeof field !== "object" || typeof (field as FieldModel).count !== "number") return null;
  return m as DataModel;
}
