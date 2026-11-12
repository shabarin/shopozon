import { normalizeText } from '../shared/util.ts';

export interface ProductLinkInfo {
  /** Clean direct product URL without query/hash or sub-pages. */
  url: string;
  /** Canonical URL used for deduplication when product_id is unavailable. */
  normalized_url: string;
  product_id: string | null;
}

const OZON_HOST = /(^|\.)ozon\.ru$/i;
const PRODUCT_PATH = /\/product\/([^/?#]+)/i;
const PRODUCT_SUBPAGES = /^\/(?:reviews|questions|similar|video|photos?|description)(?:\/|$)/i;

export function isOzonHost(hostname: string): boolean {
  return OZON_HOST.test(hostname.toLowerCase());
}

export function isOzonUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && isOzonHost(url.hostname);
  } catch {
    return false;
  }
}

export function parseProductId(slugOrPath: string): string | null {
  const pathMatch = PRODUCT_PATH.exec(slugOrPath);
  const slug = pathMatch ? (pathMatch[1] ?? '') : slugOrPath;
  if (!slug) return null;
  const clean = slug.split(/[?#]/)[0] ?? slug;
  const trailing = /(?:^|-)(\d{5,})$/u.exec(clean);
  if (trailing?.[1]) return trailing[1];
  if (/^\d{5,}$/u.test(clean)) return clean;
  return null;
}

/** Parse a card link into a canonical product URL and Ozon product id. */
export function parseProductLink(href: string | null | undefined, baseUrl?: string): ProductLinkInfo | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, baseUrl ?? 'https://www.ozon.ru/');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isOzonHost(url.hostname)) return null;

  const match = PRODUCT_PATH.exec(url.pathname);
  if (!match) return null;
  const slug = match[1];
  if (!slug) return null;

  // Do not treat review/question links as the product itself.
  const afterSlug = url.pathname.slice(url.pathname.indexOf(slug) + slug.length);
  if (PRODUCT_SUBPAGES.test(afterSlug)) return null;

  const productId = parseProductId(slug);
  const canonicalPath = `/product/${slug}/`;
  const origin = `https://${url.hostname.toLowerCase()}`;
  return {
    url: `${origin}${canonicalPath}`,
    normalized_url: `${origin}${canonicalPath}`.replace(/\/+$/u, ''),
    product_id: productId,
  };
}

export function normalizeProductUrl(value: string): string | null {
  const parsed = parseProductLink(value);
  return parsed ? parsed.normalized_url : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Ozon search query, if it can be determined from the URL without guessing. */
export function extractSearchQuery(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    for (const key of ['text', 'q', 'search_query', 'query']) {
      const raw = url.searchParams.get(key);
      if (raw) {
        const cleaned = normalizeText(raw);
        if (cleaned) return cleaned.slice(0, 300);
      }
    }
    const searchPath = /^\/search\/([^/]+)\/?$/iu.exec(url.pathname);
    if (searchPath?.[1]) {
      return normalizeText(safeDecode(searchPath[1])).slice(0, 300) || null;
    }
    return null;
  } catch {
    return null;
  }
}

const LISTING_PREFIXES = [
  '/search',
  '/category',
  '/catalog',
  '/highlight',
  '/brand',
  '/collection',
  '/seller',
  '/productList',
];

const EXCLUDED_PREFIXES = [
  '/product/',
  '/cart',
  '/order',
  '/checkout',
  '/login',
  '/my',
  '/help',
  '/reviews',
  '/compare',
];

/**
 * Collection is intentionally limited to listing pages. Home page feeds,
 * product pages and account/cart pages are out of MVP scope.
 */
export function isListingPage(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!isOzonHost(url.hostname)) return false;
    const path = url.pathname.toLowerCase();
    if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
    if (url.searchParams.has('text')) return true;
    return LISTING_PREFIXES.some((prefix) => path.startsWith(prefix));
  } catch {
    return false;
  }
}

export function isOzonListingUrl(value: string | null | undefined): boolean {
  return isOzonUrl(value) && isListingPage(value);
}
