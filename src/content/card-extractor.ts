import type {
  CardExtraction,
  ExtractionQuality,
  FieldName,
  FieldState,
  JsonLdProduct,
  PriceSet,
  PriceType,
  PriceVariant,
} from '../shared/types.ts';
import { FIELD_NAMES } from '../shared/types.ts';
import { normalizeText } from '../shared/util.ts';
import {
  findPriceMatches,
  moneyConditions,
  parsePriceConditions,
  type PriceConditions,
} from '../parser/price.ts';
import { parseDiscountText } from '../parser/discount.ts';
import { parseRatingFromText, parseRatingValue, parseReviewCountText } from '../parser/rating.ts';
import { parseAvailability } from '../parser/availability.ts';
import { parseQuantityVolume } from '../parser/volume.ts';
import { parseProductLink, extractSearchQuery, type ProductLinkInfo } from '../parser/url.ts';
import {
  CARD_ROOT_SELECTORS,
  EXTRACTION_VERSION,
  PRODUCT_LINK_SELECTOR,
  RATING_SELECTORS,
  REVIEW_SELECTORS,
  SELLER_SELECTORS,
  TITLE_SELECTORS,
} from './selectors.ts';
import { findJsonLdProduct, type JsonLdIndex } from './jsonld.ts';

export interface ExtractionContext {
  sourceUrl: string;
  searchQuery: string | null;
  collectedAt?: string;
  jsonLd?: JsonLdProduct | null;
  jsonLdIndex?: JsonLdIndex | null;
  version?: string;
  isUpdate?: boolean;
}

interface TitleResult {
  value: string | null;
  state: FieldState;
  element: Element | null;
  link: HTMLAnchorElement | null;
  linkInfo: ProductLinkInfo | null;
}

interface PriceCandidate {
  element: HTMLElement;
  amount: number;
  currency: string | null;
  raw_text: string;
  struck: boolean;
  conditions: PriceConditions;
  score: number;
  order: number;
}

interface PriceExtraction {
  prices: PriceSet;
  priceType: PriceType;
  priceConditions: string | null;
  priceState: FieldState;
  originalState: FieldState;
  notes: string[];
}

function isElement(value: unknown): value is Element {
  return Boolean(value) && typeof value === 'object' && (value as Element).nodeType === 1;
}

function textOf(element: Element | null | undefined): string {
  return normalizeText(element?.textContent ?? '');
}

function classOf(element: Element): string {
  return (element.getAttribute('class') ?? '').toLowerCase();
}

function hasClassHint(element: Element, hints: readonly string[]): boolean {
  const className = classOf(element);
  return hints.some((hint) => className.includes(hint.toLowerCase()));
}

function closestCardRoot(link: Element): HTMLElement | null {
  for (const selector of CARD_ROOT_SELECTORS) {
    let candidate: Element | null = null;
    try {
      candidate = link.closest(selector);
    } catch {
      candidate = null;
    }
    if (!candidate || candidate === link) continue;
    const links = candidate.querySelectorAll(PRODUCT_LINK_SELECTOR).length;
    const text = textOf(candidate);
    if (links >= 1 && links <= 8 && text.length < 6000) return candidate as HTMLElement;
  }
  return null;
}

function fallbackCardRoot(link: Element): HTMLElement | null {
  let node: Element | null = link.parentElement;
  let best: HTMLElement | null = null;
  for (let depth = 0; node && depth < 12; depth += 1) {
    if (node === link.ownerDocument.body || node === link.ownerDocument.documentElement) break;
    const tag = node.tagName;
    if (tag === 'DIV' || tag === 'ARTICLE' || tag === 'LI' || tag === 'SECTION') {
      const links = node.querySelectorAll(PRODUCT_LINK_SELECTOR).length;
      const text = textOf(node);
      const hasMoney = /[₽₸]|руб\.?|р\./u.test(text);
      if (links >= 1 && links <= 4 && text.length >= 8 && text.length < 5000 && (hasMoney || node.querySelector('img'))) {
        best = node as HTMLElement;
      }
      if (links > 4) break;
    }
    node = node.parentElement;
  }
  return best ?? (link.closest('div, article, li, section') as HTMLElement | null);
}

/** Locate the smallest stable card container around a product link. */
export function findCardRoot(link: Element): HTMLElement | null {
  return closestCardRoot(link) ?? fallbackCardRoot(link);
}

function findChosenLink(root: HTMLElement, baseUrl: string): { link: HTMLAnchorElement | null; info: ProductLinkInfo | null } {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>(PRODUCT_LINK_SELECTOR));
  let best: { link: HTMLAnchorElement; info: ProductLinkInfo; score: number } | null = null;
  for (const link of links) {
    const info = parseProductLink(link.getAttribute('href'), baseUrl);
    if (!info) continue;
    const text = textOf(link);
    const aria = normalizeText(link.getAttribute('aria-label') ?? '');
    let score = text.length + (aria.length > 0 ? 10 : 0);
    if (text.length > 500) score -= 400;
    if (/^(купить|в корзину|добавить)/iu.test(text)) score -= 200;
    if (score > (best?.score ?? -1)) best = { link, info, score };
  }
  return best ? { link: best.link, info: best.info } : { link: null, info: null };
}

function isGenericTitle(text: string): boolean {
  const lower = text.toLowerCase();
  if (text.length < 3) return true;
  if (/^(купить|в корзину|добавить в корзину|перейти|все товары|показать|смотреть)/iu.test(text)) return true;
  if (/^(?:\d+[.,]\d+|\d+)\s*(?:отзыв|оцен)/iu.test(text)) return true;
  if (/[₽₸]|руб\.?|р\./u.test(text)) return true;
  if (/(?:продавец|рейтинг продавца|все продавцы)/iu.test(text)) return true;
  if (lower === 'ozon' || lower === 'ozon карта') return true;
  if (/^\d+$/u.test(text.replace(/\s/g, ''))) return true;
  return false;
}

function extractTitle(root: HTMLElement, chosenLink: HTMLAnchorElement | null): TitleResult {
  const hints = new Set<Element>();
  if (chosenLink) hints.add(chosenLink);
  for (const selector of TITLE_SELECTORS) {
    try {
      for (const element of root.querySelectorAll(selector)) hints.add(element);
    } catch {
      // Ignore a selector that is unsupported by the current engine.
    }
  }
  for (const link of root.querySelectorAll(PRODUCT_LINK_SELECTOR)) {
    hints.add(link);
  }

  let best: { element: Element; text: string; score: number } | null = null;
  for (const element of hints) {
    const text = textOf(element);
    if (!text || text.length > 1000 || isGenericTitle(text)) continue;
    let score = Math.min(text.length, 300);
    if (element.tagName === 'A') score += 25;
    if (chosenLink && (element === chosenLink || chosenLink.contains(element))) score += 60;
    if (hasClassHint(element, ['tsbody500medium', 'tsbodycontrol500medium', 'title'])) score += 90;
    if (element.children.length === 0) score += 10;
    // An anchor that wraps one or more spans is a container: prefer the inner
    // text span so badges (\"Хит\", \"−35%\") are not glued to the title.
    if (element.tagName === 'A' && element.children.length > 0) score -= 40;
    if (element.querySelector('img')) score -= 120;
    if (/отзыв|продавец/iu.test(text)) score -= 50;
    if (text.length > 500) score -= 150;
    if (!best || score > best.score) best = { element, text, score };
  }

  if (best) {
    return {
      value: best.text,
      state: 'extracted',
      element: best.element,
      link: chosenLink,
      linkInfo: null,
    };
  }

  // Image alt text is a last-resort title source, still taken from the card.
  if (chosenLink) {
    const image = chosenLink.querySelector('img[alt]');
    const alt = normalizeText(image?.getAttribute('alt') ?? '');
    if (alt && !isGenericTitle(alt)) {
      return { value: alt, state: 'extracted', element: image, link: chosenLink, linkInfo: null };
    }
  }
  const hasPotential = Boolean(chosenLink && textOf(chosenLink));
  return {
    value: null,
    state: hasPotential ? 'failed' : 'absent',
    element: null,
    link: chosenLink,
    linkInfo: null,
  };
}

function isStruck(element: Element, root: HTMLElement): boolean {
  let node: Element | null = element;
  const view = element.ownerDocument.defaultView;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const tag = node.tagName.toLowerCase();
    if (tag === 's' || tag === 'del' || tag === 'strike') return true;
    const style = (node.getAttribute('style') ?? '').toLowerCase();
    if (style.includes('line-through')) return true;
    const className = classOf(node);
    if (className.includes('line-through') || className.includes('strikethrough')) return true;
    if (className.includes('old-price') || className.includes('price-old')) return true;
    if (view) {
      try {
        const computed = view.getComputedStyle(node);
        if (
          computed.textDecorationLine?.includes('line-through') ||
          computed.textDecoration?.includes('line-through')
        ) {
          return true;
        }
      } catch {
        // jsdom or a detached node may not support computed styles.
      }
    }
    if (node === root) break;
    node = node.parentElement;
  }
  return false;
}

function conditionsFor(element: HTMLElement): PriceConditions {
  const ownText = textOf(element);
  const own = parsePriceConditions(ownText);
  if (own.labels.length > 0) return own;
  let combined = ownText;
  let node: Element | null = element.parentElement;
  for (let depth = 0; node && depth < 3 && combined.length < 140; depth += 1) {
    const parentText = textOf(node);
    // A container with several prices belongs to several price variants: do
    // not attribute its labels (e.g. \"по подписке\") to this single price.
    if (findPriceMatches(parentText).length !== 1) break;
    if (parentText.length <= 140) combined = `${combined} ${parentText}`;
    node = node.parentElement;
  }
  const inherited = parsePriceConditions(combined);
  if (inherited.ozon_card && inherited.no_card) {
    // Both card and non-card prices are present nearby; do not attribute either.
    return parsePriceConditions('');
  }
  return inherited;
}

function numericFontSize(element: Element): number {
  const view = element.ownerDocument.defaultView;
  if (!view) return 0;
  try {
    const computed = view.getComputedStyle(element);
    const size = Number.parseFloat(computed.fontSize);
    const weight = Number.parseInt(computed.fontWeight, 10);
    return (Number.isFinite(size) ? size : 0) + (Number.isFinite(weight) ? weight / 100 : 0) / 10;
  } catch {
    return 0;
  }
}

function collectPriceCandidates(root: HTMLElement): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  let order = 0;
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const element of elements) {
    if (element.closest('script,style,noscript,template,svg')) continue;
    const text = textOf(element);
    if (!text || text.length > 90) continue;
    const matches = findPriceMatches(text);
    if (matches.length !== 1) continue;
    const match = matches[0];
    if (!match) continue;
    const conditions = conditionsFor(element);
    const className = classOf(element);
    let score = numericFontSize(element) * 10 + Math.min(text.length, 30);
    if (
      className.includes('price') ||
      className.includes('headline') ||
      className.includes('tsheadline')
    ) {
      score += 35;
    }
    if (element.children.length === 0) score += 5;
    candidates.push({
      element,
      amount: match.amount,
      currency: match.currency,
      raw_text: (text.length <= 60 ? text : match.raw_text),
      struck: isStruck(element, root),
      conditions,
      score,
      order,
    });
    order += 1;
  }

  // Keep the most specific (deepest) element when parent and child show the same price.
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          candidate.element.contains(other.element) &&
          other.amount === candidate.amount &&
          other.struck === candidate.struck,
      ),
  );
}

function isDeliveryText(text: string): boolean {
  return /доставк|за\s+доставку|доставим/iu.test(text);
}

function toVariant(candidate: PriceCandidate, type: PriceVariant['type']): PriceVariant {
  return {
    type,
    amount: candidate.amount,
    currency: candidate.currency,
    raw_text: candidate.raw_text,
    conditions: moneyConditions(candidate.conditions),
  };
}

function extractPrices(root: HTMLElement, titleElement: Element | null): PriceExtraction {
  const candidates = collectPriceCandidates(root);
  const notes: string[] = [];
  const usable = candidates.filter((candidate) => !isDeliveryText(candidate.raw_text));
  const struck = usable.filter((candidate) => candidate.struck);
  const active = usable.filter((candidate) => !candidate.struck && candidate.amount > 0);

  const mainCandidates = active.filter(
    (candidate) =>
      !candidate.conditions.monthly &&
      !candidate.conditions.per_unit &&
      !candidate.conditions.subscription,
  );
  const pool = mainCandidates.length > 0 ? mainCandidates : active.filter((c) => c.conditions.subscription);
  const main = pool.slice().sort((a, b) => b.score - a.score || a.order - b.order)[0] ?? null;

  const cardCandidates = active
    .filter((candidate) => candidate.conditions.ozon_card)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const subscriptionCandidates = active
    .filter((candidate) => candidate.conditions.subscription)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  let original = struck.slice().sort((a, b) => b.amount - a.amount || b.score - a.score)[0] ?? null;
  if (main && original && original.amount < main.amount) {
    notes.push('original_price:lower_than_current');
    original = null;
  }

  const prices: PriceSet = {
    main: main ? toVariant(main, 'main') : null,
    original: original ? toVariant(original, 'original') : null,
    ozon_card: cardCandidates[0] ? toVariant(cardCandidates[0], 'ozon_card') : null,
    subscription: subscriptionCandidates[0]
      ? toVariant(subscriptionCandidates[0], 'subscription')
      : null,
    other: [],
  };

  const selected = new Set<PriceCandidate>();
  if (main) selected.add(main);
  if (original) selected.add(original);
  if (cardCandidates[0]) selected.add(cardCandidates[0]);
  if (subscriptionCandidates[0]) selected.add(subscriptionCandidates[0]);
  const seenOther = new Set<string>();
  for (const candidate of usable) {
    if (selected.has(candidate)) continue;
    const conditionText = moneyConditions(candidate.conditions) ?? '';
    const key = `${candidate.amount}|${candidate.currency}|${conditionText}|${candidate.raw_text}`;
    if (seenOther.has(key)) continue;
    seenOther.add(key);
    prices.other.push(toVariant(candidate, 'other'));
  }

  let priceType: PriceType = 'unknown';
  if (prices.main) {
    if (prices.main.conditions?.includes('Ozon Карта')) priceType = 'ozon_card';
    else if (prices.main.conditions?.includes('подписка')) priceType = 'subscription';
    else priceType = 'regular';
  }
  const priceConditions = prices.main?.conditions ?? null;

  const cardText = textOf(root);
  const hasCurrency = /[₽₸$€]|руб\.?|р\./u.test(cardText);
  const hasStruckElement = Array.from(root.querySelectorAll('s,del,strike')).some((element) =>
    /\d/u.test(textOf(element)),
  );
  let priceState: FieldState = prices.main ? 'extracted' : 'absent';
  let originalState: FieldState = prices.original ? 'extracted' : 'absent';
  if (!prices.main && hasCurrency) {
    priceState = 'failed';
    notes.push('price:present_but_not_parsed');
    if (active.some((candidate) => candidate.conditions.monthly)) {
      notes.push('price:only_monthly_payment_found');
    }
  }
  if (!prices.original && hasStruckElement) {
    originalState = 'failed';
    notes.push('original_price:present_but_not_parsed');
  }

  return {
    prices,
    priceType,
    priceConditions,
    priceState,
    originalState,
    notes,
  };
}

function extractSeller(root: HTMLElement, titleElement: Element | null): { value: string | null; state: FieldState } {
  const generic = new Set([
    'продавец',
    'все продавцы',
    'перейти в магазин',
    'товары продавца',
    'рейтинг продавца',
    'ozon',
    'продавец ozon',
  ]);
  let foundHint = false;
  for (const selector of SELLER_SELECTORS) {
    let elements: Element[] = [];
    try {
      elements = Array.from(root.querySelectorAll(selector));
    } catch {
      elements = [];
    }
    for (const element of elements) {
      foundHint = true;
      if (titleElement && (element === titleElement || titleElement.contains(element))) continue;
      let text = textOf(element);
      const labeled = /продавец\s*:\s*(.+)/iu.exec(text);
      if (labeled?.[1]) text = normalizeText(labeled[1]);
      text = text.replace(/^продавец\s*:\s*/iu, '').trim();
      if (text.length < 2 || text.length > 150) continue;
      if (generic.has(text.toLowerCase())) continue;
      return { value: text, state: 'extracted' };
    }
  }
  return { value: null, state: foundHint ? 'failed' : 'absent' };
}

function extractRating(root: HTMLElement): { value: number | null; state: FieldState } {
  let foundHint = false;
  for (const selector of RATING_SELECTORS) {
    let elements: Element[] = [];
    try {
      elements = Array.from(root.querySelectorAll(selector));
    } catch {
      elements = [];
    }
    for (const element of elements) {
      const text = textOf(element);
      if (!text) continue;
      foundHint = true;
      const value = parseRatingValue(text, true);
      if (value !== null) return { value, state: 'extracted' };
    }
  }
  const cardText = textOf(root);
  const fallback = parseRatingFromText(cardText);
  if (fallback !== null) return { value: fallback, state: 'extracted' };
  return { value: null, state: foundHint || /рейтинг/iu.test(cardText) ? 'failed' : 'absent' };
}

function extractReviewCount(root: HTMLElement): { value: number | null; state: FieldState } {
  let foundHint = false;
  for (const selector of REVIEW_SELECTORS) {
    let elements: Element[] = [];
    try {
      elements = Array.from(root.querySelectorAll(selector));
    } catch {
      elements = [];
    }
    for (const element of elements) {
      const text = textOf(element);
      if (!text) continue;
      foundHint = true;
      const value = parseReviewCountText(text);
      if (value !== null) return { value, state: 'extracted' };
    }
  }
  const cardText = textOf(root);
  const fallback = parseReviewCountText(cardText);
  if (fallback !== null) return { value: fallback, state: 'extracted' };
  return { value: null, state: foundHint || /отзыв/iu.test(cardText) ? 'failed' : 'absent' };
}

function extractDiscount(
  root: HTMLElement,
  titleElement: Element | null,
): { value: number | null; text: string | null; state: FieldState } {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  let hint = false;
  for (const element of elements) {
    if (element.closest('script,style,noscript,template')) continue;
    if (titleElement && (element === titleElement || titleElement.contains(element))) continue;
    const text = textOf(element);
    if (!text || text.length > 60) continue;
    const hintElement =
      hasClassHint(element, ['discount', 'sale', 'badge']) ||
      /[-−–]\s?\d{1,2}\s?%|скидк\w*\s*\d{1,2}\s?%/iu.test(text);
    if (hintElement) hint = true;
    const parsed = parseDiscountText(text);
    if (parsed) return { value: parsed.percent, text: parsed.raw_text, state: 'extracted' };
  }
  return { value: null, text: null, state: hint ? 'failed' : 'absent' };
}

function emptyFieldStates(): Record<FieldName, FieldState> {
  const states = {} as Record<FieldName, FieldState>;
  for (const field of FIELD_NAMES) states[field] = 'absent';
  return states;
}

function resolveJsonLd(context: ExtractionContext, info: ProductLinkInfo | null): JsonLdProduct | null {
  if (context.jsonLd) return context.jsonLd;
  if (context.jsonLdIndex) {
    return findJsonLdProduct(context.jsonLdIndex, info?.product_id ?? null, info?.url ?? null);
  }
  return null;
}

function buildQuality(
  states: Record<FieldName, FieldState>,
  errors: string[],
  fallbackFields: string[],
  version: string,
): ExtractionQuality {
  const extracted = FIELD_NAMES.filter((field) => states[field] === 'extracted');
  const missing = FIELD_NAMES.filter((field) => states[field] === 'absent');
  const failed = FIELD_NAMES.filter((field) => states[field] === 'failed');
  const hasUrl = states.url === 'extracted';
  const hasTitle = states.title === 'extracted';
  const hasPrice = states.price === 'extracted';
  const status = hasUrl && hasTitle && hasPrice ? 'success' : hasUrl && (hasTitle || hasPrice) ? 'partial' : 'failed';
  return {
    status,
    extracted_fields: extracted,
    missing_fields: missing,
    failed_fields: failed,
    errors: [...new Set(errors)],
    fallback_fields: [...new Set(fallbackFields)],
    extraction_version: version,
  };
}

/** Extract one card entirely from DOM content visible on the page. */
export function extractCard(root: HTMLElement, context: ExtractionContext): CardExtraction {
  const baseUrl = context.sourceUrl || root.ownerDocument.baseURI;
  const chosen = findChosenLink(root, baseUrl);
  const title = extractTitle(root, chosen.link);
  const jsonLd = resolveJsonLd(context, chosen.info);
  const fallbackFields: string[] = [];
  const errors: string[] = [];

  let titleValue = title.value;
  let titleState = title.state;
  if (!titleValue && jsonLd?.name) {
    titleValue = jsonLd.name;
    titleState = 'extracted';
    fallbackFields.push('title');
  }

  let productId = chosen.info?.product_id ?? null;
  let productUrl = chosen.info?.url ?? null;
  if (!productId && productUrl && jsonLd?.product_id) {
    productId = jsonLd.product_id;
    fallbackFields.push('product_id');
  }

  const prices = extractPrices(root, title.element);
  errors.push(...prices.notes);
  let priceValue = prices.prices.main?.amount ?? null;
  let currency = prices.prices.main?.currency ?? null;
  let priceState = prices.priceState;
  let priceType = prices.priceType;
  let priceConditions = prices.priceConditions;
  const originalValue = prices.prices.original?.amount ?? null;
  if (priceValue === null && jsonLd?.price !== null && jsonLd?.price !== undefined) {
    const fallbackMain: PriceVariant = {
      type: 'main',
      amount: jsonLd.price,
      currency: jsonLd.currency,
      raw_text: 'JSON-LD',
      conditions: null,
    };
    prices.prices.main = fallbackMain;
    priceValue = jsonLd.price;
    currency = jsonLd.currency ?? currency;
    priceState = 'extracted';
    priceType = 'unknown';
    priceConditions = null;
    fallbackFields.push('price');
    if (!prices.prices.original) errors.push('price:from_jsonld_fallback');
  }

  if (!currency && jsonLd?.currency) currency = jsonLd.currency;
  const titleForParsing = titleValue;
  const volume = parseQuantityVolume(titleForParsing);

  const seller = extractSeller(root, title.element);
  const ratingResult = extractRating(root);
  let rating = ratingResult.value;
  let ratingState = ratingResult.state;
  if (rating === null && jsonLd?.rating !== null && jsonLd?.rating !== undefined) {
    rating = jsonLd.rating;
    ratingState = 'extracted';
    fallbackFields.push('rating');
  }

  const review = extractReviewCount(root);
  let reviewValue = review.value;
  let reviewState = review.state;
  if (reviewValue === null && jsonLd?.review_count !== null && jsonLd?.review_count !== undefined) {
    reviewValue = jsonLd.review_count;
    reviewState = 'extracted';
    fallbackFields.push('review_count');
  }

  const discount = extractDiscount(root, title.element);
  const availability = parseAvailability(textOf(root));

  const states = emptyFieldStates();
  states.product_id = productId ? 'extracted' : 'absent';
  states.url = productUrl ? 'extracted' : 'absent';
  states.title = titleState;
  states.price = priceState;
  states.currency = currency ? 'extracted' : 'absent';
  states.original_price = prices.originalState;
  states.discount = discount.state;
  states.volume = volume.volume_state;
  states.quantity = volume.quantity_state;
  states.seller = seller.state;
  states.rating = ratingState;
  states.review_count = reviewState;
  states.availability = availability.availability ? 'extracted' : 'absent';

  // Keep quality accounting honest: a null value is never "extracted".
  if (!titleValue) states.title = titleState === 'failed' ? 'failed' : 'absent';
  if (priceValue === null && priceState === 'extracted') states.price = 'absent';
  if (!currency) states.currency = 'absent';

  for (const note of volume.notes) {
    if (note.includes('ambiguous') || note.includes('multiple')) errors.push(note);
  }
  if (seller.state === 'failed') errors.push('seller:present_but_not_parsed');
  if (ratingState === 'failed') errors.push('rating:present_but_not_parsed');
  if (reviewState === 'failed') errors.push('review_count:present_but_not_parsed');
  if (discount.state === 'failed') errors.push('discount:present_but_not_parsed');
  if (titleState === 'failed') errors.push('title:present_but_not_parsed');
  if (priceState === 'failed') errors.push('price:present_but_not_parsed');

  const quality = buildQuality(
    states,
    errors,
    fallbackFields,
    context.version ?? EXTRACTION_VERSION,
  );

  return {
    product_id: productId,
    url: productUrl,
    title: titleValue,
    price: priceValue,
    currency,
    original_price: originalValue,
    discount: discount.value,
    discount_text: discount.text,
    volume: volume.volume,
    volume_unit: volume.volume_unit,
    quantity: volume.quantity,
    seller: seller.value,
    rating,
    review_count: reviewValue,
    availability: availability.availability,
    availability_text: availability.text,
    price_type: priceType,
    price_conditions: priceConditions,
    prices: prices.prices,
    collected_at: context.collectedAt ?? new Date().toISOString(),
    source_url: context.sourceUrl,
    search_query: context.searchQuery ?? extractSearchQuery(context.sourceUrl),
    field_states: states,
    extraction: quality,
    is_update: context.isUpdate === true,
  };
}
