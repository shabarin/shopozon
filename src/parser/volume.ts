import type { FieldState, VolumeUnit } from '../shared/types.ts';
import { normalizeText } from '../shared/util.ts';

export interface QuantityVolumeResult {
  volume: number | null;
  volume_unit: VolumeUnit | null;
  quantity: number | null;
  volume_state: FieldState;
  quantity_state: FieldState;
  notes: string[];
}

const UNIT_PATTERN = '(мл|ml|л|l|кг|kg|гр|g|г)';
const UNIT_MAP: Record<string, VolumeUnit> = {
  мл: 'ml',
  ml: 'ml',
  л: 'l',
  l: 'l',
  кг: 'kg',
  kg: 'kg',
  гр: 'g',
  g: 'g',
  г: 'g',
};

const VOLUME_TOKEN = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNIT_PATTERN}(?![a-zа-яё])`, 'giu');
const RANGE_TOKEN = new RegExp(
  `\\d+(?:[.,]\\d+)?\\s*[-–—]\\s*\\d+(?:[.,]\\d+)?\\s*${UNIT_PATTERN}(?![a-zа-яё])`,
  'iu',
);

const QUANTITY_UNIT =
  '(?:шт\\.?|штук[а-яё]*|штуч[а-яё]*|единиц[а-яё]*|ед\\.?|предмет[а-яё]*|таблет[а-яё]*|капсул[а-яё]*|саше|ампул[а-яё]*|пакет[а-яё]*|пастил[а-яё]*|порци[а-яё]*|упаковк[а-яё]*|уп\\.?)';

function parseDecimal(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function isPricePerUnitContext(title: string, matchIndex: number): boolean {
  const prefix = title.slice(Math.max(0, matchIndex - 8), matchIndex);
  return /за\s*$/u.test(prefix);
}

/**
 * Extract package volume/weight and explicit package quantity from a product
 * title. Ambiguous titles deliberately produce null values.
 */
export function parseQuantityVolume(rawTitle: string | null | undefined): QuantityVolumeResult {
  const title = normalizeText(rawTitle).toLowerCase();
  const result: QuantityVolumeResult = {
    volume: null,
    volume_unit: null,
    quantity: null,
    volume_state: 'absent',
    quantity_state: 'absent',
    notes: [],
  };
  if (!title) return result;

  let volumeTokens: { value: number; unit: VolumeUnit; raw: string }[] = [];
  VOLUME_TOKEN.lastIndex = 0;
  let volumeMatch: RegExpExecArray | null;
  while ((volumeMatch = VOLUME_TOKEN.exec(title)) !== null) {
    const rawValue = volumeMatch[1] ?? '';
    const rawUnit = volumeMatch[2] ?? '';
    const value = parseDecimal(rawValue);
    const unit = UNIT_MAP[rawUnit.toLowerCase()];
    if (value !== null && unit) {
      volumeTokens.push({ value, unit, raw: volumeMatch[0] });
    }
  }

  // 2 × 75 мл / 75 мл × 2 (and Cyrillic x / asterisk)
  const multiplyForward = new RegExp(
    `(\\d{1,3})\\s*[x×*]\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNIT_PATTERN}(?![a-zа-яё])`,
    'iu',
  ).exec(title);
  const multiplyBackward = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*${UNIT_PATTERN}(?![a-zа-яё])\\s*[x×*]\\s*(\\d{1,3})`,
    'iu',
  ).exec(title);

  let multipliedQuantity: number | null = null;
  let multipliedVolume: number | null = null;
  let multipliedUnit: VolumeUnit | null = null;
  if (multiplyForward) {
    multipliedQuantity = Number.parseInt(multiplyForward[1] ?? '', 10);
    multipliedVolume = parseDecimal(multiplyForward[2] ?? '');
    multipliedUnit = UNIT_MAP[(multiplyForward[3] ?? '').toLowerCase()] ?? null;
  } else if (multiplyBackward) {
    multipliedQuantity = Number.parseInt(multiplyBackward[3] ?? '', 10);
    multipliedVolume = parseDecimal(multiplyBackward[1] ?? '');
    multipliedUnit = UNIT_MAP[(multiplyBackward[2] ?? '').toLowerCase()] ?? null;
  }

  if (multipliedVolume !== null && multipliedUnit) {
    result.volume = multipliedVolume;
    result.volume_unit = multipliedUnit;
    result.volume_state = 'extracted';
  }

  const uniqueVolumes = new Map<string, { value: number; unit: VolumeUnit }>();
  for (const token of volumeTokens) {
    uniqueVolumes.set(`${token.value}:${token.unit}`, { value: token.value, unit: token.unit });
  }

  if (result.volume === null && volumeTokens.length > 0) {
    if (RANGE_TOKEN.test(title)) {
      result.volume_state = 'failed';
      result.notes.push('volume:ambiguous_range');
    } else if (uniqueVolumes.size > 1) {
      result.volume_state = 'failed';
      result.notes.push('volume:multiple_values');
    } else {
      const only = [...uniqueVolumes.values()][0];
      if (only) {
        result.volume = only.value;
        result.volume_unit = only.unit;
        result.volume_state = 'extracted';
      }
    }
  }

  let quantity: number | null = null;
  if (multipliedQuantity !== null && multipliedQuantity > 0 && multipliedQuantity < 1000) {
    quantity = multipliedQuantity;
    result.notes.push('quantity:from_multiplier');
  }

  if (quantity === null) {
    const setPattern = new RegExp(
      `(?:набор|комплект|упаковка)\\s*(?:из\\s*)?(\\d{1,4})\\s*${QUANTITY_UNIT}`,
      'iu',
    ).exec(title);
    const countPattern = new RegExp(`(\\d{1,4})\\s*${QUANTITY_UNIT}`, 'giu');
    countPattern.lastIndex = 0;
    let countMatch: RegExpExecArray | null;
    const counts: number[] = [];
    while ((countMatch = countPattern.exec(title)) !== null) {
      if (isPricePerUnitContext(title, countMatch.index)) continue;
      const parsed = Number.parseInt(countMatch[1] ?? '', 10);
      if (parsed > 0 && parsed < 1000) counts.push(parsed);
    }
    const explicit = setPattern ? Number.parseInt(setPattern[1] ?? '', 10) : counts[0];
    if (explicit && explicit > 0 && explicit < 1000) quantity = explicit;
  }

  const quantityRange = new RegExp(
    `\\d+\\s*[-–—]\\s*\\d+\\s*${QUANTITY_UNIT}`,
    'iu',
  ).test(title);
  if (quantityRange) {
    result.quantity_state = 'failed';
    result.notes.push('quantity:ambiguous_range');
  } else if (quantity !== null) {
    result.quantity = quantity;
    result.quantity_state = 'extracted';
  } else if (result.volume_state === 'extracted') {
    // A single packaged item with a declared size is one unit.
    result.quantity = 1;
    result.quantity_state = 'extracted';
    result.notes.push('quantity:inferred_single_item');
  }

  return result;
}
