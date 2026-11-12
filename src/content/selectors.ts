import { PARSER_VERSION } from '../shared/constants.ts';

/**
 * All Ozon-specific selectors live here. See docs/SELECTORS.md for the update
 * procedure. Extraction always has a generic fallback in addition to these
 * hints, so a class rename must not break the whole extension.
 */
export const EXTRACTION_VERSION = `${PARSER_VERSION}-dom.1`;

export const PRODUCT_LINK_SELECTOR = 'a[href*="/product/"]';

export const CARD_ROOT_SELECTORS = [
  '[data-widget="searchResultsV2"] .tile-root',
  '[data-widget="searchResultsV2"] [data-index]',
  '[data-widget="catalogResultsV2"] .tile-root',
  '[data-widget="searchResults"] .tile-root',
  '.tile-root',
  '[class*="tile-root"]',
  '[data-widget="tile"]',
  '[class*="tile"]',
];

export const TITLE_SELECTORS = [
  'a[href*="/product/"] span[class*="tsBody500Medium"]',
  'a[href*="/product/"] span[class*="tsBodyControl500Medium"]',
  'a[href*="/product/"] span',
  'a[href*="/product/"]',
  '[class*="tsBody500Medium"]',
  '[class*="tsBodyControl500Medium"]',
  '[data-widget="searchResultsV2"] [class*="title"]',
  '[class*="title"]',
];

export const SELLER_SELECTORS = [
  'a[href*="/seller/"]',
  'a[href*="/seller/"] span',
  '[class*="seller"]',
  '[data-widget*="seller"]',
];

export const RATING_SELECTORS = [
  '[class*="rating"]',
  '[data-widget*="rating"]',
  '[aria-label*="рейтинг" i]',
  '[title*="рейтинг" i]',
];

export const REVIEW_SELECTORS = [
  'a[href*="reviews"]',
  '[class*="review"]',
  '[data-widget*="review"]',
  '[aria-label*="отзыв" i]',
];

export const DISCOUNT_SELECTORS = [
  '[class*="discount"]',
  '[class*="sale"]',
  '[class*="badge"]',
  '[data-widget*="discount"]',
];

export const AVAILABILITY_SELECTORS = [
  '[class*="stock"]',
  '[class*="availability"]',
  '[data-widget*="stock"]',
];
