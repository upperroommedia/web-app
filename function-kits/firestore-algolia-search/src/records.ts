/* Copyright 2021 Algolia. Adapted from firestore-algolia-search 1.3.0.
 * Licensed under the Apache License, Version 2.0; see ../LICENSE.
 */
import { DocumentReference, DocumentSnapshot, GeoPoint, Timestamp } from 'firebase-admin/firestore';

export interface RecordConfig { fields: string; altObjectId: string; transformFunction: string; location: string; projectId: string }
export const fields = (value: string): string[] => value.split(/[ ,]+/).filter(Boolean);
export function objectId(snapshot: DocumentSnapshot, alternate: string): string {
  const value = alternate === '(path)' ? snapshot.ref.path : alternate ? snapshot.get(alternate) : snapshot.id;
  if (typeof value !== 'string' || !value) throw new Error(`Invalid Algolia objectID for ${snapshot.ref.path}`);
  return value;
}
export function processValue(field: string, value: unknown): [string, unknown] {
  if (value instanceof Timestamp) return [field, value.toMillis()];
  if (value instanceof DocumentReference) return [field, value.path];
  if (value instanceof GeoPoint) return ['_geoloc', {lat: value.latitude, lng: value.longitude}];
  if (Array.isArray(value)) return [field, value.map(item => processValue('', item)[1])];
  if (value && typeof value === 'object') return [field, processData(value as Record<string, unknown>)];
  return [field, value];
}
export function processData(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [field, input] of Object.entries(data)) {
    const [key, value] = processValue(field, input);
    if (value !== undefined && value !== null) output[key] = value;
  }
  return output;
}
export async function extract(snapshot: DocumentSnapshot, config: RecordConfig): Promise<Record<string, unknown> & {objectID: string}> {
  const selected = fields(config.fields);
  const data = selected.length ? Object.fromEntries(selected.map(field => [field, snapshot.get(field)])) : snapshot.data() ?? {};
  let payload = {...processData(data), objectID: objectId(snapshot, config.altObjectId), path: snapshot.ref.path};
  if (config.transformFunction) {
    const response = await fetch(`https://${config.location}-${config.projectId}.cloudfunctions.net/${config.transformFunction}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: payload}), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Algolia transform failed with HTTP ${response.status}`);
    const body = await response.json() as {result?: unknown};
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new Error('Algolia transform returned no record');
    payload = {...body.result, objectID: payload.objectID, path: payload.path};
  }
  if (Buffer.byteLength(JSON.stringify(payload)) >= 102400) throw new Error(`Algolia record is too large: ${snapshot.ref.path}`);
  return payload;
}
