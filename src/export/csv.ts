import type {
  ObservationRecord,
  ProductRecord,
  ExportBundle,
  ExportFormat,
} from '../shared/types.ts';
import { localDateStamp } from '../shared/util.ts';

const BOM = '\uFEFF';
const EOL = '\r\n';

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text) || /^\s|\s$/u.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(values: readonly unknown[]): string {
  return values.map(csvEscape).join(',');
}

function list(values: readonly string[] | null | undefined): string {
  return Array.isArray(values) ? values.join(';') : '';
}

function otherPrices(prices: { other: readonly { type: string; amount: number; currency: string | null; conditions: string | null }[] }): string {
  if (!prices.other.length) return '';
  return JSON.stringify(
    prices.other.map((price) => ({
      type: price.type,
      amount: price.amount,
      currency: price.currency,
      conditions: price.conditions,
    })),
  );
}

const PRODUCT_HEADERS = [
  'product_id',
  'url',
  'title',
  'price',
  'currency',
  'original_price',
  'discount',
  'discount_text',
  'volume',
  'volume_unit',
  'quantity',
  'seller',
  'rating',
  'review_count',
  'availability',
  'availability_text',
  'price_type',
  'price_conditions',
  'ozon_card_price',
  'subscription_price',
  'other_prices',
  'first_seen_at',
  'last_seen_at',
  'collected_at',
  'source_url',
  'search_query',
  'observation_count',
  'session_ids',
  'extraction_status',
  'extracted_fields',
  'missing_fields',
  'failed_fields',
  'fallback_fields',
  'extraction_errors',
  'extraction_version',
] as const;

const OBSERVATION_HEADERS = [
  'observation_id',
  'session_id',
  'product_key',
  'product_id',
  'url',
  'title',
  'price',
  'currency',
  'original_price',
  'discount',
  'discount_text',
  'volume',
  'volume_unit',
  'quantity',
  'seller',
  'rating',
  'review_count',
  'availability',
  'availability_text',
  'price_type',
  'price_conditions',
  'ozon_card_price',
  'subscription_price',
  'other_prices',
  'collected_at',
  'source_url',
  'search_query',
  'extraction_status',
  'extracted_fields',
  'missing_fields',
  'failed_fields',
  'fallback_fields',
  'extraction_errors',
  'extraction_version',
] as const;

export function buildProductsCsv(products: readonly ProductRecord[]): string {
  const rows = [csvRow(PRODUCT_HEADERS)];
  for (const product of products) {
    rows.push(
      csvRow([
        product.product_id,
        product.url,
        product.title,
        product.price,
        product.currency,
        product.original_price,
        product.discount,
        product.discount_text,
        product.volume,
        product.volume_unit,
        product.quantity,
        product.seller,
        product.rating,
        product.review_count,
        product.availability,
        product.availability_text,
        product.price_type,
        product.price_conditions,
        product.prices.ozon_card?.amount ?? null,
        product.prices.subscription?.amount ?? null,
        otherPrices(product.prices),
        product.first_seen_at,
        product.last_seen_at,
        product.collected_at,
        product.source_url,
        product.search_query,
        product.observation_count,
        list(product.session_ids),
        product.extraction.status,
        list(product.extraction.extracted_fields),
        list(product.extraction.missing_fields),
        list(product.extraction.failed_fields),
        list(product.extraction.fallback_fields),
        list(product.extraction.errors),
        product.extraction.extraction_version,
      ]),
    );
  }
  return `${BOM}${rows.join(EOL)}${EOL}`;
}

export function buildObservationsCsv(observations: readonly ObservationRecord[]): string {
  const rows = [csvRow(OBSERVATION_HEADERS)];
  for (const observation of observations) {
    rows.push(
      csvRow([
        observation.observation_id,
        observation.session_id,
        observation.product_key,
        observation.product_id,
        observation.url,
        observation.title,
        observation.price,
        observation.currency,
        observation.original_price,
        observation.discount,
        observation.discount_text,
        observation.volume,
        observation.volume_unit,
        observation.quantity,
        observation.seller,
        observation.rating,
        observation.review_count,
        observation.availability,
        observation.availability_text,
        observation.price_type,
        observation.price_conditions,
        observation.prices.ozon_card?.amount ?? null,
        observation.prices.subscription?.amount ?? null,
        otherPrices(observation.prices),
        observation.collected_at,
        observation.source_url,
        observation.search_query,
        observation.extraction.status,
        list(observation.extraction.extracted_fields),
        list(observation.extraction.missing_fields),
        list(observation.extraction.failed_fields),
        list(observation.extraction.fallback_fields),
        list(observation.extraction.errors),
        observation.extraction.extraction_version,
      ]),
    );
  }
  return `${BOM}${rows.join(EOL)}${EOL}`;
}

export function buildJsonExport(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function exportFilename(format: ExportFormat, date = new Date(), scope = 'all'): string {
  const stamp = localDateStamp(date);
  const prefix = scope === 'session' ? 'ozon-session' : 'ozon';
  if (format === 'products-csv') return `${prefix}-products-${stamp}.csv`;
  if (format === 'observations-csv') return `${prefix}-observations-${stamp}.csv`;
  return `${prefix}-data-${stamp}.json`;
}

export function exportMime(format: ExportFormat): string {
  return format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
}
