import { CardanError } from "./errors.js";
import { partsToText } from "./normalize.js";
import { validateOutput, type SchemaInput } from "./schema.js";
import type { ContentPart, WebCitation, WebSearchOptions } from "./types.js";

// Provider-agnostic helpers shared by the adapters. Pure utilities only — no
// per-provider wire logic lives here.

/**
 * Synthetic tool-call id prefix for providers that omit ids (Gemini 2.x). The
 * prefix is a cross-provider contract: ids carrying it are stripped before
 * replaying to a provider, so it must be defined in exactly one place.
 */
export const SYNTHETIC_CALL_ID_PREFIX = "cardan_call_";

/** Synthesizes a tool-call id so call/result pairing works when a provider omits one. */
export function syntheticCallId(): string {
  return `${SYNTHETIC_CALL_ID_PREFIX}${crypto.randomUUID()}`;
}

/** True for ids cardan synthesized; such ids are stripped when replaying. */
export function isSyntheticCallId(id: string): boolean {
  return id.startsWith(SYNTHETIC_CALL_ID_PREFIX);
}

/** Parses aggregated tool-call argument JSON; empty string maps to `{}`. */
export function parseToolArgs(json: string, provider: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new CardanError("unknown", "tool call arguments are not valid JSON", {
      provider,
      cause,
      raw: json,
    });
  }
}

/** Parses a structured-output response and validates it against the caller schema.
 *
 * Strict json_schema constrains each emitted text part to valid JSON individually,
 * but a reasoning model may emit several message parts (intermediate drafts then a
 * final answer). Concatenating them yields multiple objects back-to-back, which is
 * not parseable as one. So we try the joined text first (the common single-part
 * case), then fall back to the last individually-parseable part — the final answer. */
export function parseStructuredOutput(
  content: ContentPart[],
  schema: SchemaInput,
  provider: string,
): unknown {
  const parts = content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text);
  const candidates = [partsToText(content), ...parts.slice().reverse()];
  let cause: unknown;
  for (const text of candidates) {
    if (!text.trim()) continue;
    try {
      return validateOutput(schema, JSON.parse(text));
    } catch (err) {
      cause ??= err;
    }
  }
  throw new CardanError("unknown", "structured output is not valid JSON", {
    provider,
    cause,
    raw: partsToText(content),
  });
}

/** Normalizes the `webSearch` option to its object form, or undefined when off. */
export function normalizeWebSearch(
  webSearch: boolean | WebSearchOptions | undefined,
): WebSearchOptions | undefined {
  if (!webSearch) return undefined;
  return webSearch === true ? {} : webSearch;
}

/**
 * Collects citations into `target`, de-duplicating by URL. The first sighting
 * of a URL wins its slot; later sightings only fill in a missing title or
 * snippet, so the richest available metadata survives without duplicates.
 */
export function addCitations(
  target: WebCitation[],
  citations: Iterable<WebCitation>,
): void {
  for (const citation of citations) {
    if (!citation.url) continue;
    const existing = target.find((c) => c.url === citation.url);
    if (existing) {
      if (!existing.title && citation.title) existing.title = citation.title;
      if (!existing.snippet && citation.snippet) existing.snippet = citation.snippet;
    } else {
      target.push({ ...citation });
    }
  }
}

/** Base64-encodes bytes, chunked to avoid call-stack limits on large inputs. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decodes a base64 string into bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
