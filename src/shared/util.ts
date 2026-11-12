/** Browser-independent helpers. */

export function normalizeText(value: string | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u2009\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
}

export function toIsoDateString(date: Date): string {
  return date.toISOString();
}

export function localDateStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

/** Stable 64-bit FNV-1a hash used to build short storage keys. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function uniqueAppend<T>(list: readonly T[], items: readonly T[], limit: number): T[] {
  const result = list.slice();
  for (const item of items) {
    if (!result.includes(item)) result.push(item);
  }
  return result.length > limit ? result.slice(result.length - limit) : result;
}

export function parseDigits(value: string | null | undefined): number | null {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<T>).then === 'function';
}

export function safeString(value: unknown, maxLength = 4000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}
