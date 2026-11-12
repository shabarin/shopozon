import { normalizeText, parseDigits } from '../shared/util.ts';

export function parseRatingValue(text: string | null | undefined, allowInteger = true): number | null {
  const source = normalizeText(text);
  if (!source || source.length > 30) return null;
  const decimal = /(?:^|\D)([0-5](?:[.,]\d))(?:\D|$)/u.exec(source);
  if (decimal?.[1]) {
    const value = Number.parseFloat(decimal[1].replace(',', '.'));
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  }
  if (!allowInteger) return null;
  const integer = /^\s*([0-5])\s*$/u.exec(source);
  if (integer?.[1]) {
    const value = Number.parseInt(integer[1], 10);
    return value >= 0 && value <= 5 ? value : null;
  }
  return null;
}

/** Finds a decimal rating adjacent to review/rating wording. */
export function parseRatingFromText(text: string | null | undefined): number | null {
  const source = normalizeText(text);
  if (!source) return null;
  const afterWording =
    /([0-5](?:[.,]\d))[\s·•|,;:–—-]*(?:\d[\d\s]{0,10})?(?:отзыв[а-яё]*|оцен[а-яё]*)/iu.exec(source);
  const labelled = /(?:рейтинг|оценка|оценки)\s*:?\s*([0-5](?:[.,]\d))/iu.exec(source);
  const match = afterWording ?? labelled;
  if (match?.[1]) {
    const value = Number.parseFloat(match[1].replace(',', '.'));
    return value >= 0 && value <= 5 ? value : null;
  }
  return null;
}

export function parseReviewCountText(text: string | null | undefined): number | null {
  const source = normalizeText(text);
  if (!source) return null;
  if (/нет\s+отзывов/iu.test(source)) return 0;
  if (/нет\s+оценок/iu.test(source)) return 0;

  const match = /(?:^|[^\d.,])(\d[\d\s]{0,9})\s*(?:отзыв[а-яё]*|оцен[а-яё]*)/iu.exec(source);
  if (match?.[1]) return parseDigits(match[1]);
  if (/^\s*\d[\d\s]{0,9}\s*$/u.test(source)) return parseDigits(source);
  return null;
}
