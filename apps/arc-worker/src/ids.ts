import { isUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

export const orgPublicId = (uuid: string): string => `org_${uuidToHex(uuid)}`;
export const parseOrgPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "org");

export const boardPublicId = (uuid: string): string => `arb_${uuidToHex(uuid)}`;

export const checklistItemPublicId = (uuid: string): string => `ack_${uuidToHex(uuid)}`;
export const parseChecklistItemPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "ack");

export const requestPublicId = (uuid: string): string => `arq_${uuidToHex(uuid)}`;
export const parseRequestPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "arq");

export const documentPublicId = (uuid: string): string => `ard_${uuidToHex(uuid)}`;
export const parseDocumentPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "ard");

export const commentPublicId = (uuid: string): string => `acm_${uuidToHex(uuid)}`;
export const decisionPublicId = (uuid: string): string => `adc_${uuidToHex(uuid)}`;

/**
 * The actor id in the shape a UUID column takes: pass a UUID through, decode a
 * `usr_<hex>` public id, and write null rather than garbage for anything else.
 */
export function actorSubjectUuid(subjectId: string): string | null {
  if (isUuid(subjectId)) return subjectId;
  return uuidFromPublicId(subjectId);
}
