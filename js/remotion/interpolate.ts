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

  // Extrapolation logic for values outside range when extend
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
