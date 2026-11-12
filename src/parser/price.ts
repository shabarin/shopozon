import { normalizeText } from '../shared/util.ts';

export interface ParsedPrice {
  amount: number;
  currency: string | null;
  raw_text: string;
}

export interface PriceConditions {
  ozon_card: boolean;
  no_card: boolean;
  subscription: boolean;
  monthly: boolean;
  per_unit: boolean;
  labels: string[];
}

const CURRENCY_TOKEN = '(?:₽|руб\\.?|р\\.?|₸|тг|Br|\\$|€)';
const PRICE_PATTERN = new RegExp(
  `(?:от\\s*)?(\\d[\\d\\s\\u00A0\\u2007\\u2009\\u202F.,]*)\\s*(${CURRENCY_TOKEN})`,
  'giu',
);

/** Convert a displayed Russian-format amount into a plain number. */
export function parsePriceNumber(raw: string): number | null {
  let value = raw.replace(/[^\d.,]/g, '').trim();
  if (!value) return null;
  if (value.endsWith('.') || value.endsWith(',')) value = value.slice(0, -1);

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56 -> 1234.56
      normalized = value.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // 1,234.56 -> 1234.56
      normalized = value.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // 1 234,56 -> 1234.56; a single comma with 3 digits is still treated as decimal
    normalized = value.replace(/\./g, '').replace(/,/g, '.');
  } else if (lastDot >= 0) {
    const parts = value.split('.');
    const last = parts[parts.length - 1] ?? '';
    if (parts.length > 2) {
      // 1.234.567 -> thousands
      normalized = last.length <= 2 ? `${parts.slice(0, -1).join('')}.${last}` : parts.join('');
    } else if (last.length === 3 && parts[0] && parts[0].length <= 3) {
      // 1.234 -> thousands (Russian display)
      normalized = parts.join('');
    } else {
      normalized = value;
    }
  } else {
    normalized = value;
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

export function detectCurrency(token: string): string | null {
  const value = token.trim().toLowerCase();
  if (value === '₽' || value === 'руб' || value === 'руб.' || value === 'р' || value === 'р.') {
    return 'RUB';
  }
  if (value === '₸' || value === 'тг') return 'KZT';
  if (value === 'br') return 'BYN';
  if (value === '$') return 'USD';
  if (value === '€') return 'EUR';
  return null;
}

export function findPriceMatches(text: string): ParsedPrice[] {
  const source = normalizeText(text);
  if (!source) return [];
  const matches: ParsedPrice[] = [];
  PRICE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRICE_PATTERN.exec(source)) !== null) {
    const rawNumber = match[1] ?? '';
    const rawCurrency = match[2] ?? '';
    const amount = parsePriceNumber(rawNumber);
    if (amount === null) continue;
    matches.push({
      amount,
      currency: detectCurrency(rawCurrency),
      raw_text: normalizeText(match[0]),
    });
  }
  return matches;
}

export function parsePriceText(text: string): ParsedPrice | null {
  return findPriceMatches(text)[0] ?? null;
}

export function parsePriceConditions(text: string): PriceConditions {
  const source = normalizeText(text).toLowerCase();
  const ozonCard = /ozon\s*карт[а-яё]*|ozon\s*card|озон\s*карт[а-яё]*|карт[а-яё]*\s*ozon/iu.test(source);
  const noCard = /без\s+(?:ozon\s*)?карт|без\s+ozon\s*card/iu.test(source);
  const subscription = /ozon\s*premium|подписк|premium/iu.test(source);
  const monthly = /\/\s*мес|в\s+месяц|за\s+месяц|ежемесяч/iu.test(source);
  const perUnit = /\/\s*(?:шт|мл|л|г|кг)|за\s+1\s*шт|цена\s+за\s+штук/iu.test(source);

  const labels: string[] = [];
  if (ozonCard) labels.push('Ozon Карта');
  if (noCard) labels.push('без Ozon Карты');
  if (subscription) labels.push('подписка');
  if (monthly) labels.push('в месяц');
  if (perUnit) labels.push('за единицу');

  return {
    ozon_card: ozonCard && !noCard,
    no_card: noCard,
    subscription,
    monthly,
    per_unit: perUnit,
    labels,
  };
}

export function moneyConditions(conditions: PriceConditions): string | null {
  return conditions.labels.length > 0 ? conditions.labels.join(', ') : null;
}
