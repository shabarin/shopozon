/**
 * Shared domain types.
 *
 * These types deliberately contain no browser API references: the same code is
 * used by the content script, the background worker and Node.js unit tests.
 */

export type ISODateString = string;
export type CurrencyCode = string;

export type FieldState = 'extracted' | 'absent' | 'failed';
export type ExtractionStatus = 'success' | 'partial' | 'failed';
export type Availability = 'in_stock' | 'out_of_stock' | null;
export type VolumeUnit = 'ml' | 'l' | 'g' | 'kg';
export type PriceType = 'regular' | 'ozon_card' | 'subscription' | 'unknown';

export const FIELD_NAMES = [
  'product_id',
  'url',
  'title',
  'price',
  'currency',
  'original_price',
  'discount',
  'volume',
  'quantity',
  'seller',
  'rating',
  'review_count',
  'availability',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export interface Money {
  amount: number;
  currency: CurrencyCode | null;
  raw_text: string;
  /** Human-readable condition, e.g. "с Ozon Картой" or "по подписке". */
  conditions: string | null;
}

export interface PriceVariant extends Money {
  type: 'main' | 'original' | 'ozon_card' | 'subscription' | 'other';
}

export interface PriceSet {
  main: PriceVariant | null;
  original: PriceVariant | null;
  ozon_card: PriceVariant | null;
  subscription: PriceVariant | null;
  /** Any extra displayed prices that do not fit the known variants. */
  other: PriceVariant[];
}

export interface ExtractionQuality {
  status: ExtractionStatus;
  /** Field names for which a value was extracted (including JSON-LD fallback). */
  extracted_fields: string[];
  /** Field names which are not present in the card at all. */
  missing_fields: string[];
  /** Field names which are present but could not be parsed reliably. */
  failed_fields: string[];
  /** Non-fatal extraction problems, suitable for diagnostics. */
  errors: string[];
  /** Fields obtained from page JSON-LD rather than the visible card. */
  fallback_fields: string[];
  extraction_version: string;
}

/** Result of parsing one visible product card. */
export interface CardExtraction {
  product_id: string | null;
  url: string | null;
  title: string | null;
  price: number | null;
  currency: CurrencyCode | null;
  original_price: number | null;
  discount: number | null;
  discount_text: string | null;
  volume: number | null;
  volume_unit: VolumeUnit | null;
  quantity: number | null;
  seller: string | null;
  rating: number | null;
  review_count: number | null;
  availability: Availability;
  availability_text: string | null;
  price_type: PriceType;
  price_conditions: string | null;
  prices: PriceSet;
  collected_at: ISODateString;
  source_url: string;
  search_query: string | null;
  field_states: Record<FieldName, FieldState>;
  extraction: ExtractionQuality;
  /** True when this is a re-extraction of an already counted DOM card. */
  is_update?: boolean;
}

export interface ObservationRecord {
  observation_id: string;
  session_id: string;
  product_key: string;
  product_id: string | null;
  url: string | null;
  title: string | null;
  price: number | null;
  currency: CurrencyCode | null;
  original_price: number | null;
  discount: number | null;
  discount_text: string | null;
  volume: number | null;
  volume_unit: VolumeUnit | null;
  quantity: number | null;
  seller: string | null;
  rating: number | null;
  review_count: number | null;
  availability: Availability;
  availability_text: string | null;
  price_type: PriceType;
  price_conditions: string | null;
  prices: PriceSet;
  collected_at: ISODateString;
  source_url: string;
  search_query: string | null;
  extraction: ExtractionQuality;
  field_states: Record<FieldName, FieldState>;
}

/** Current (merged) state of one unique product. */
export interface ProductRecord {
  key: string;
  /** "id:<product_id>" or "url:<normalized_url>" — used for collision checks. */
  dedupe_key: string;
  product_id: string | null;
  url: string | null;
  title: string | null;
  price: number | null;
  currency: CurrencyCode | null;
  original_price: number | null;
  discount: number | null;
  discount_text: string | null;
  volume: number | null;
  volume_unit: VolumeUnit | null;
  quantity: number | null;
  seller: string | null;
  rating: number | null;
  review_count: number | null;
  availability: Availability;
  availability_text: string | null;
  price_type: PriceType;
  price_conditions: string | null;
  prices: PriceSet;
  /** First time this product was seen. */
  first_seen_at: ISODateString;
  /** Time the product record was last written by the background script. */
  last_seen_at: ISODateString;
  /** Time of the latest card detection that produced this state. */
  collected_at: ISODateString;
  observation_count: number;
  session_ids: string[];
  source_url: string;
  source_urls: string[];
  search_query: string | null;
  extraction: ExtractionQuality;
  field_states: Record<FieldName, FieldState>;
}

export interface SessionSummary {
  session_id: string;
  started_at: ISODateString;
  finished_at: ISODateString | null;
  initial_url: string | null;
  search_query: string | null;
  cards_discovered: number;
  unique_products: number;
  errors: number;
  partial: number;
  success: number;
  observation_count: number;
  status: 'active' | 'stopped' | 'interrupted';
  extraction_versions: string[];
}

export interface SessionRecord extends SessionSummary {
  product_keys: string[];
  observation_chunks: number;
  note: string | null;
}

export interface CollectorState {
  schema_version: number;
  enabled: boolean;
  active_session_id: string | null;
  last_session_id: string | null;
  started_at: ISODateString | null;
  last_extraction_at: ISODateString | null;
  last_source_url: string | null;
  warning: string | null;
  warning_at: ISODateString | null;
  parser_version: string;
}

export interface DbMeta {
  schema_version: number;
  product_count: number;
  product_index_chunks: number;
  product_index_last_size: number;
}

export interface IngestResult {
  ok: boolean;
  code?: 'session_not_found' | 'quality_rejected' | 'storage_error' | 'invalid_payload';
  accepted: number;
  duplicates: number;
  cards_discovered: number;
  errors: number;
  unique_in_session: number;
  total_products: number;
  warning: string | null;
  message?: string;
}

export interface Stats {
  enabled: boolean;
  active_session: SessionSummary | null;
  last_session: SessionSummary | null;
  total_products: number;
  warning: string | null;
  warning_at: ISODateString | null;
  started_at: ISODateString | null;
  last_extraction_at: ISODateString | null;
  last_source_url: string | null;
  parser_version: string;
  sessions: SessionSummary[];
}

export type ExportScope = 'all' | 'session';
export type ExportFormat = 'products-csv' | 'observations-csv' | 'json';

export interface ExportRequest {
  scope: ExportScope;
  session_id?: string | null;
  format: ExportFormat;
}

export interface ExportResult {
  ok: boolean;
  filename?: string;
  content?: string;
  mime?: string;
  error?: string;
}

export interface ExportBundle {
  schema_version: number;
  exported_at: ISODateString;
  scope: ExportScope;
  session: SessionRecord | null;
  sessions: SessionSummary[];
  products: ProductRecord[];
  observations: ObservationRecord[];
  stats: {
    products: number;
    observations: number;
    sessions: number;
    total_products_in_store: number;
  };
}

export interface JsonLdProduct {
  url: string | null;
  product_id: string | null;
  name: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  review_count: number | null;
}
