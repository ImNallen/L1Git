export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseHex(text: string): Rgba | null {
  const m = HEX.exec(text.trim());
  if (!m?.[1]) return null;
  const digits = m[1].length <= 4 ? [...m[1]].map((d) => d + d).join("") : m[1];
  const channel = (i: number) =>
    parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: digits.length === 8 ? channel(3) : 1,
  };
}

export function formatHex({ r, g, b, a }: Rgba): string {
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ""}`;
}

export const isHex = (text: string) => HEX.test(text.trim());

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

type Lab = { L: number; a: number; b: number };

function toOklab({ r, g, b }: Rgba): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function fromOklab({ L, a, b }: Lab, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, fromLinear(v)));
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

/** Moves `from` a fraction `t` of the way toward `to`, in OKLab so steps look even. */
export function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const [x, y] = [toOklab(from), toOklab(to)];
  const lerp = (p: number, q: number) => p + (q - p) * t;
  return fromOklab(
    { L: lerp(x.L, y.L), a: lerp(x.a, y.a), b: lerp(x.b, y.b) },
    lerp(from.a, to.a),
  );
}

function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** `color` with its OKLab lightness moved a fraction `t` toward `target`'s, keeping its hue and chroma. */
export function relight(color: Rgba, target: Rgba, t: number): Rgba {
  const [x, y] = [toOklab(color), toOklab(target)];
  return fromOklab({ ...x, L: x.L + (y.L - x.L) * t }, color.a);
}

/** WCAG contrast ratio between two opaque colours, 1 to 21. */
export function contrast(x: Rgba, y: Rgba): number {
  const [p, q] = [luminance(x), luminance(y)];
  return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05);
}

export function isDark(hex: string): boolean {
  const c = parseHex(hex);
  return c !== null && luminance(c) < 0.18;
}

/** OKLab chroma: about 0 for greys, 0.1 and up for clearly coloured. */
export function chroma(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const { a, b } = toOklab(c);
  return Math.hypot(a, b);
}

export function over(top: Rgba, bottom: Rgba): Rgba {
  const blend = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return {
    r: blend(top.r, bottom.r),
    g: blend(top.g, bottom.g),
    b: blend(top.b, bottom.b),
    a: 1,
  };
}

/** Euclidean distance in OKLab, alpha included: about 0.02 is a just-noticeable difference. */
export function distance(x: Rgba, y: Rgba): number {
  const [p, q] = [toOklab(x), toOklab(y)];
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b, x.a - y.a);
}
