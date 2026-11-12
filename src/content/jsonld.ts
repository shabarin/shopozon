import type { JsonLdProduct } from '../shared/types.ts';
import { normalizeText } from '../shared/util.ts';
import { parseProductLink } from '../parser/url.ts';

export interface JsonLdIndex {
  byId: Map<string, JsonLdProduct>;
  byUrl: Map<string, JsonLdProduct>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(/\s/g, '');
    if (!cleaned) return null;
    const comma = cleaned.lastIndexOf(',');
    const normalized = comma > cleaned.lastIndexOf('.') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
    const result = Number.parseFloat(normalized);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function mergeProduct(current: JsonLdProduct | undefined, next: JsonLdProduct): JsonLdProduct {
  if (!current) return next;
  return {
    url: current.url ?? next.url,
    product_id: current.product_id ?? next.product_id,
    name: current.name ?? next.name,
    price: current.price ?? next.price,
    currency: current.currency ?? next.currency,
    rating: current.rating ?? next.rating,
    review_count: current.review_count ?? next.review_count,
  };
}

/**
 * Read JSON-LD product metadata from the page once per scan. JSON-LD is only
 * used as a fallback for fields that are absent from the visible card.
 */
export function readJsonLd(doc: Document): JsonLdIndex {
  const index: JsonLdIndex = { byId: new Map(), byUrl: new Map() };
  const scripts = doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
  let count = 0;

  const addProduct = (raw: Record<string, unknown>, urlValue: string | null, idValue: string | null) => {
    if (count >= 500) return;
    const link = parseProductLink(urlValue, doc.baseURI);
    const productId =
      (typeof idValue === 'string' && /^\d{5,}$/u.test(idValue) ? idValue : null) ??
      link?.product_id ??
      null;
    const url = link?.url ?? null;
    if (!productId && !url) return;

    const offersValue = Array.isArray(raw.offers) ? raw.offers[0] : raw.offers;
    const offers = offersValue && typeof offersValue === 'object' ? (offersValue as Record<string, unknown>) : {};
    const aggregateValue = raw.aggregateRating;
    const aggregate =
      aggregateValue && typeof aggregateValue === 'object'
        ? (aggregateValue as Record<string, unknown>)
        : {};

    const product: JsonLdProduct = {
      url,
      product_id: productId,
      name: normalizeText(typeof raw.name === 'string' ? raw.name : '') || null,
      price: asNumber(offers.price ?? offers.lowPrice ?? raw.price),
      currency:
        typeof offers.priceCurrency === 'string'
          ? offers.priceCurrency
          : typeof raw.priceCurrency === 'string'
            ? raw.priceCurrency
            : null,
      rating: asNumber(aggregate.ratingValue),
      review_count: asNumber(aggregate.reviewCount ?? aggregate.ratingCount),
    };

    if (productId) index.byId.set(productId, mergeProduct(index.byId.get(productId), product));
    if (url) index.byUrl.set(url.replace(/\/+$/u, ''), mergeProduct(index.byUrl.get(url.replace(/\/+$/u, '')), product));
    count += 1;
  };

  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || count >= 500) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const typeValue = object['@type'];
    const types = Array.isArray(typeValue) ? typeValue : [typeValue];
    const isProduct = types.some((item) => typeof item === 'string' && item.toLowerCase() === 'product');
    const rawUrl =
      (typeof object.url === 'string' ? object.url : null) ??
      (typeof object['@id'] === 'string' ? object['@id'] : null);
    const hasProductUrl = Boolean(rawUrl && parseProductLink(rawUrl, doc.baseURI));
    if (isProduct || (hasProductUrl && typeof object.name === 'string')) {
      const idValue =
        (typeof object.sku === 'string' ? object.sku : null) ??
        (typeof object.productID === 'string' ? object.productID : null) ??
        (typeof object.productId === 'string' ? object.productId : null);
      addProduct(object, rawUrl, idValue);
    }
    for (const [key, child] of Object.entries(object)) {
      if (key === 'offers' || key === 'aggregateRating') continue;
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };

  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text || text.length > 2_000_000) continue;
    try {
      visit(JSON.parse(text), 0);
    } catch {
      // Malformed JSON-LD is common on real pages; silently ignore it.
    }
  }
  return index;
}

export function findJsonLdProduct(
  index: JsonLdIndex | null | undefined,
  productId: string | null,
  url: string | null,
): JsonLdProduct | null {
  if (!index) return null;
  if (productId) {
    const byId = index.byId.get(productId);
    if (byId) return byId;
  }
  if (url) {
    const normalized = url.replace(/\/+$/u, '');
    return index.byUrl.get(normalized) ?? null;
  }
  return null;
}
