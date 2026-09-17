/**
 * Color decisions, in one place, with the reasoning attached.
 *
 * Every palette below was run through the data-viz validator against this
 * page's dark surface (#141416) rather than picked by eye:
 *
 * - ALTITUDE_BANDS is an ordinal ramp on a single hue (blue), monotone in
 *   lightness, and passes every ordinal check. Altitude is a magnitude, so it
 *   gets a one-hue ramp and never a rainbow.
 * - Aircraft blue vs vessel orange vs inactive gray passes all-pairs CVD
 *   separation. Gray is reserved for "no data / not moving / stale" and is
 *   always labeled, never used as an identity color.
 * - SEVERITY uses the reserved status palette. Red vs green is inherently
 *   weak under deuteranopia, which is exactly why every alert in the UI ships
 *   a glyph and the severity word next to the color.
 * - ZONE_KIND_STYLE clears the normal-vision floor (worst pair 24.6) but sits
 *   in the CVD warn band (7.2), which is only legal with secondary encoding.
 *   So zone kind is *also* carried by outline dash pattern and by a direct
 *   text label on every zone. Do not remove either one.
 */

/**
 * Chrome colors are jaronwilson.dev and jaronwilson.org's own dark tokens, so
 * this reads as part of the same web presence. The data colors below are
 * unchanged and were re-validated against this warmer surface (#201d16): the
 * altitude ramp still passes every ordinal check with its darkest step at
 * 2.08:1.
 *
 * One rule follows from the rebrand. The brand accent (#d97a4a) is only four
 * units of color difference from the vessel orange (#d95926), far below the
 * separation a viewer needs, so the accent is confined to chrome: the brand
 * mark, navigation links, primary buttons and the footer. It never appears in
 * the data panels, in the legend or on the map, and no data color appears in
 * the chrome. Keep that separation.
 */
export const INK = {
  page: '#17150f',
  surface: '#201d16',
  surfaceRaised: '#272319',
  primary: '#ede9e0',
  secondary: '#c9c3b5',
  muted: '#a39d8f',
  grid: '#35322a',
  border: 'rgba(237,233,224,0.12)',
  accent: '#d97a4a',
};

/** Ordinal ramp: low altitude dark, high altitude light. */
export const ALTITUDE_BANDS = [
  { maxFt: 2500, color: '#184f95', label: 'below 2,500 ft' },
  { maxFt: 10000, color: '#256abf', label: '2,500 - 10,000 ft' },
  { maxFt: 20000, color: '#3987e5', label: '10,000 - 20,000 ft' },
  { maxFt: 30000, color: '#6da7ec', label: '20,000 - 30,000 ft' },
  { maxFt: 40000, color: '#9ec5f4', label: '30,000 - 40,000 ft' },
  { maxFt: Infinity, color: '#cde2fb', label: '40,000 ft and above' },
];

export const GROUND_COLOR = '#898781';
export const VESSEL_UNDERWAY = '#d95926';
export const VESSEL_STATIC = '#898781';

export function altitudeBand(alt, onGround) {
  if (onGround) return { color: GROUND_COLOR, label: 'on the ground', index: -1 };
  if (typeof alt !== 'number') return { color: GROUND_COLOR, label: 'altitude unknown', index: -1 };
  const index = ALTITUDE_BANDS.findIndex((band) => alt < band.maxFt);
  const resolved = index === -1 ? ALTITUDE_BANDS.length - 1 : index;
  return { ...ALTITUDE_BANDS[resolved], index: resolved };
}

/** Reserved status palette. Never reuse these for a data series. */
export const SEVERITY = {
  critical: { color: '#d03b3b', glyph: '!', label: 'Critical', rank: 3 },
  serious: { color: '#ec835a', glyph: '▲', label: 'Serious', rank: 2 },
  warning: { color: '#fab219', glyph: '△', label: 'Warning', rank: 1 },
  notice: { color: '#898781', glyph: 'i', label: 'Notice', rank: 0 },
  good: { color: '#0ca30c', glyph: '✓', label: 'Nominal', rank: -1 },
};

/**
 * Zone kind: color plus the dash pattern that carries the same information
 * for anyone who cannot separate the hues.
 */
export const ZONE_KIND_STYLE = {
  prohibited: { color: '#d03b3b', dash: [1], label: 'Prohibited', width: 2 },
  tfr: { color: '#d03b3b', dash: [3, 2], label: 'TFR', width: 2 },
  restricted: { color: '#fab219', dash: [6, 2], label: 'Restricted', width: 1.75 },
  sfra: { color: '#9085e9', dash: [4, 2, 1, 2], label: 'Special flight rules', width: 1.5 },
  custom: { color: '#199e70', dash: [1, 2], label: 'Custom watch', width: 1.75 },
};

export const zoneStyle = (kind) => ZONE_KIND_STYLE[kind] || ZONE_KIND_STYLE.custom;
