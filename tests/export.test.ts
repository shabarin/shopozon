import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExport,
  buildJsonExport,
  buildObservationsCsv,
  buildProductsCsv,
  csvEscape,
  exportFilename,
  exportMime,
} from '../src/export/index.ts';
import type {
  ExportBundle,
  ObservationRecord,
  ProductRecord,
  SessionRecord,
} from '../src/shared/types.ts';
import { FIELD_NAMES, type FieldName, type FieldState } from '../src/shared/types.ts';

function states(): Record<FieldName, FieldState> {
  const result = {} as Record<FieldName, FieldState>;
  for (const field of FIELD_NAMES) result[field] = 'absent';
  result.url = 'extracted';
  result.title = 'extracted';
  result.price = 'extracted';
  return result;
}

const QUALITY = {
  status: 'success' as const,
  extracted_fields: ['url', 'title', 'price'],
  missing_fields: ['seller'],
  failed_fields: [],
  errors: ['price:present_but_not_parsed'],
  fallback_fields: [],
  extraction_version: 'test-1',
};

const PRICES = {
  main: { type: 'main' as const, amount: 1234.5, currency: 'RUB', raw_text: '1 234,50 ₽', conditions: null },
  original: null,
  ozon_card: {
    type: 'ozon_card' as const,
    amount: 1199,
    currency: 'RUB',
    raw_text: '1 199 ₽',
    conditions: 'Ozon Карта',
  },
  subscription: null,
  other: [],
};

const PRODUCT: ProductRecord = {
  key: 'p:abc',
  dedupe_key: 'id:123456',
  product_id: '123456',
  url: 'https://www.ozon.ru/product/krem-123456/',
  title: 'Крем, "увлажняющий"\n100 мл',
  price: 1234.5,
  currency: 'RUB',
  original_price: 2000,
  discount: 38,
  discount_text: '-38%',
  volume: 100,
  volume_unit: 'ml',
  quantity: 1,
  seller: 'ООО Ромашка',
  rating: 4.8,
  review_count: 1234,
  availability: 'in_stock',
  availability_text: 'В наличии',
  price_type: 'ozon_card',
  price_conditions: 'Ozon Карта',
  prices: PRICES,
  first_seen_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T00:00:00.000Z',
  collected_at: '2026-01-02T00:00:00.000Z',
  observation_count: 2,
  session_ids: ['sess-1', 'sess-2'],
  source_url: 'https://www.ozon.ru/search/?text=крем',
  source_urls: ['https://www.ozon.ru/search/?text=крем'],
  search_query: 'крем',
  extraction: QUALITY,
  field_states: states(),
};

const OBSERVATION: ObservationRecord = {
  observation_id: 'obs-1',
  session_id: 'sess-1',
  product_key: 'p:abc',
  product_id: '123456',
  url: 'https://www.ozon.ru/product/krem-123456/',
  title: 'Крем, "увлажняющий"\n100 мл',
  price: 1234.5,
  currency: 'RUB',
  original_price: 2000,
  discount: 38,
  discount_text: '-38%',
  volume: 100,
  volume_unit: 'ml',
  quantity: 1,
  seller: 'ООО Ромашка',
  rating: 4.8,
  review_count: 1234,
  availability: 'in_stock',
  availability_text: 'В наличии',
  price_type: 'ozon_card',
  price_conditions: 'Ozon Карта',
  prices: PRICES,
  collected_at: '2026-01-01T00:00:00.000Z',
  source_url: 'https://www.ozon.ru/search/?text=крем',
  search_query: 'крем',
  extraction: QUALITY,
  field_states: states(),
};

const SESSION: SessionRecord = {
  session_id: 'sess-1',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T01:00:00.000Z',
  initial_url: 'https://www.ozon.ru/search/?text=крем',
  search_query: 'крем',
  cards_discovered: 3,
  unique_products: 1,
  errors: 0,
  partial: 0,
  success: 3,
  observation_count: 1,
  status: 'stopped',
  extraction_versions: ['test-1'],
  product_keys: ['p:abc'],
  observation_chunks: 1,
  note: null,
};

const BUNDLE: ExportBundle = {
  schema_version: 1,
  exported_at: '2026-01-02T00:00:00.000Z',
  scope: 'all',
  session: null,
  sessions: [SESSION],
  products: [PRODUCT],
  observations: [OBSERVATION],
  stats: { products: 1, observations: 1, sessions: 1, total_products_in_store: 1 },
};

function rows(csv: string): string[] {
  return csv.replace(/^\uFEFF/u, '').split('\r\n');
}

function parseRow(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

test('CSV escaping and encoding rules are stable', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(1234.5), '1234.5');
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(' padded '), '" padded "');
});

test('products CSV has BOM, CRLF, English headers and escaped values', () => {
  const csv = buildProductsCsv([PRODUCT]);
  assert.ok(csv.startsWith('\uFEFF'), 'must start with UTF-8 BOM');
  assert.ok(csv.endsWith('\r\n'));
  const lines = rows(csv);
  assert.equal(lines.length, 3); // header + one multi-line field + trailing empty
  assert.match(lines[0] ?? '', /^product_id,url,title,price,currency/);

  const line = lines[1] ?? '';
  const values = parseRow(line);
  const header = parseRow(lines[0]!);
  const record = Object.fromEntries(header.map((key, index) => [key, values[index]]));
  assert.equal(record.product_id, '123456');
  assert.equal(record.title, 'Крем, "увлажняющий"\n100 мл');
  assert.equal(record.price, '1234.5');
  assert.equal(record.original_price, '2000');
  assert.equal(record.discount, '38');
  assert.equal(record.discount_text, '-38%');
  assert.equal(record.volume_unit, 'ml');
  assert.equal(record.availability, 'in_stock');
  assert.equal(record.price_type, 'ozon_card');
  assert.equal(record.ozon_card_price, '1199');
  assert.equal(record.observation_count, '2');
  assert.equal(record.session_ids, 'sess-1;sess-2');
  assert.equal(record.extracted_fields, 'url;title;price');
  assert.equal(record.missing_fields, 'seller');
  assert.equal(record.extraction_errors, 'price:present_but_not_parsed');
});

test('observations CSV keeps per-detection snapshots', () => {
  const csv = buildObservationsCsv([OBSERVATION]);
  const lines = rows(csv);
  assert.match(lines[0] ?? '', /^observation_id,session_id,product_key/);
  const header = parseRow(lines[0]!);
  const values = parseRow(lines[1] ?? '');
  const record = Object.fromEntries(header.map((key, index) => [key, values[index]]));
  assert.equal(record.observation_id, 'obs-1');
  assert.equal(record.session_id, 'sess-1');
  assert.equal(record.collected_at, '2026-01-01T00:00:00.000Z');
  assert.equal(record.discount_text, '-38%');
  assert.equal(record.subscription_price, '');
  assert.equal(record.ozon_card_price, '1199');
});

test('JSON export is a valid, parseable bundle', () => {
  const json = buildJsonExport(BUNDLE);
  const parsed = JSON.parse(json) as ExportBundle;
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.products.length, 1);
  assert.equal(parsed.products[0]?.prices.ozon_card?.amount, 1199);
  assert.equal(parsed.observations[0]?.observation_id, 'obs-1');
  assert.ok(json.includes('\n  "products"'), 'JSON should be pretty-printed');
});

test('filenames and MIME types are browser-download friendly', () => {
  const date = new Date(2026, 0, 5);
  assert.equal(exportFilename('products-csv', date, 'all'), 'ozon-products-2026-01-05.csv');
  assert.equal(exportFilename('observations-csv', date, 'session'), 'ozon-session-observations-2026-01-05.csv');
  assert.equal(exportFilename('json', date, 'all'), 'ozon-data-2026-01-05.json');
  assert.equal(exportMime('products-csv'), 'text/csv;charset=utf-8');
  assert.equal(exportMime('json'), 'application/json;charset=utf-8');
});

test('buildExport dispatches to the requested format', () => {
  const csv = buildExport(BUNDLE, 'products-csv', 'all', new Date(2026, 0, 5));
  assert.equal(csv.ok, true);
  assert.equal(csv.filename, 'ozon-products-2026-01-05.csv');
  assert.ok(csv.content?.startsWith('\uFEFF'));

  const json = buildExport(BUNDLE, 'json', 'session', new Date(2026, 0, 5));
  assert.equal(json.filename, 'ozon-session-data-2026-01-05.json');
  assert.equal(JSON.parse(json.content ?? '{}').schema_version, 1);
});
