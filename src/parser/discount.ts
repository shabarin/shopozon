import { normalizeText } from '../shared/util.ts';

export interface ParsedDiscount {
  percent: number;
  raw_text: string;
}

const DISCOUNT_PATTERNS: RegExp[] = [
  /(?:^|\s)[-−–]\s?(\d{1,2})\s?%/u,
  /скидк[а-яё]*\s*(?:до\s*)?(\d{1,2})\s?%/iu,
  /(\d{1,2})\s?%\s*скидк[а-яё]*/iu,
];

/**
 * Parse only explicitly displayed discount labels ("-35%", "скидка 20%").
 * The caller must not pass the product title here.
 */
export function parseDiscountText(text: string | null | undefined): ParsedDiscount | null {
  const source = normalizeText(text);
  if (!source || source.length > 60) return null;
  for (const pattern of DISCOUNT_PATTERNS) {
    const match = pattern.exec(source);
    if (!match) continue;
    const percent = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(percent) && percent > 0 && percent < 100) {
      return { percent, raw_text: source };
    }
  }
  return null;
}
