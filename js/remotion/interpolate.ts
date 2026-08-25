export type ExtrapolateType = "clamp" | "extend" | "identity";

export interface InterpolateOptions {
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
  easing?: (t: number) => number;
}

export function interpolate(
  value: number,
  inputRange: number[],
  outputRange: number[],
  options?: InterpolateOptions
): number {
  if (inputRange.length === 0 || outputRange.length === 0) return value;
  if (inputRange.length !== outputRange.length) {
    throw new Error("inputRange and outputRange must have the same length");
  }

  const extrapolateLeft = options?.extrapolateLeft ?? "extend";
  const extrapolateRight = options?.extrapolateRight ?? "extend";
  const easing = options?.easing ?? ((t: number) => t);

  if (value <= inputRange[0]) {
    if (extrapolateLeft === "clamp") return outputRange[0];
    if (extrapolateLeft === "identity") return value;
  }

  const lastIdx = inputRange.length - 1;
  if (value >= inputRange[lastIdx]) {
    if (extrapolateRight === "clamp") return outputRange[lastIdx];
    if (extrapolateRight === "identity") return value;
  }

  for (let i = 0; i < lastIdx; i++) {
    if (value >= inputRange[i] && value <= inputRange[i + 1]) {
      const inLen = inputRange[i + 1] - inputRange[i];
      if (Math.abs(inLen) < 1e-7) return outputRange[i];
      const linearT = (value - inputRange[i]) / inLen;
      const easedT = easing(linearT);
      return outputRange[i] + easedT * (outputRange[i + 1] - outputRange[i]);
    }
  }

  if (value < inputRange[0]) {
    const inLen = inputRange[1] - inputRange[0];
    const linearT = (value - inputRange[0]) / inLen;
    return outputRange[0] + linearT * (outputRange[1] - outputRange[0]);
  } else {
    const inLen = inputRange[lastIdx] - inputRange[lastIdx - 1];
    const linearT = (value - inputRange[lastIdx - 1]) / inLen;
    return outputRange[lastIdx - 1] + linearT * (outputRange[lastIdx] - outputRange[lastIdx - 1]);
  }
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(colorStr: string): RGBA {
  const str = colorStr.trim();

  // Hex format #rgb, #rgba, #rrggbb, #rrggbbaa
  if (str.startsWith("#")) {
    const hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const match = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (match) {
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10),
      a: match[4] !== undefined ? parseFloat(match[4]) : 1,
    };
  }

  // Default fallback
  return { r: 0, g: 0, b: 0, a: 1 };
}

export function interpolateColors(
  value: number,
  inputRange: number[],
  outputRange: string[],
  options?: InterpolateOptions
): string {
  const parsedColors = outputRange.map(parseColor);

  const rValues = parsedColors.map((c) => c.r);
  const gValues = parsedColors.map((c) => c.g);
  const bValues = parsedColors.map((c) => c.b);
  const aValues = parsedColors.map((c) => c.a);

  const r = Math.round(interpolate(value, inputRange, rValues, options));
  const g = Math.round(interpolate(value, inputRange, gValues, options));
  const b = Math.round(interpolate(value, inputRange, bValues, options));
  const a = interpolate(value, inputRange, aValues, options);

  return `rgba(${Math.max(0, Math.min(255, r))}, ${Math.max(0, Math.min(255, g))}, ${Math.max(0, Math.min(255, b))}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
