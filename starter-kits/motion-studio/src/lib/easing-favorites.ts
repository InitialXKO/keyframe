/**
 * Easing favorites — user-saved cubic-bezier presets persisted to localStorage.
 *
 * Seeded with four industry-classic profiles on first run so the palette is
 * immediately useful. Each favorite stores its control points + label and can
 * be applied to any keyframe (switching it to CubicBezier) or deleted.
 */

import type { CubicControl } from "./scene";

export interface EasingFavorite {
  id: string;
  label: string;
  cubic: CubicControl;
}

const KEY = "keyforge.easing-favorites";

const SEED: EasingFavorite[] = [
  { id: "fav-backout", label: "回弹 Back Out", cubic: { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1 } },
  { id: "fav-anticipate", label: "预备 Anticipate", cubic: { p1x: 0.68, p1y: -0.42, p2x: 0.32, p2y: 1.42 } },
  { id: "fav-swift", label: "急速 Swift", cubic: { p1x: 0.85, p1y: 0, p2x: 0.15, p2y: 1 } },
  { id: "fav-spring", label: "弹簧 Spring", cubic: { p1x: 0.175, p1y: 0.885, p2x: 0.32, p2y: 1.18 } },
];

export function loadEasingFavorites(): EasingFavorite[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw == null) {
      window.localStorage.setItem(KEY, JSON.stringify(SEED));
      return [...SEED];
    }
    const parsed = JSON.parse(raw) as EasingFavorite[];
    if (!Array.isArray(parsed)) return [...SEED];
    return parsed.filter((f) => f && typeof f.id === "string" && f.cubic);
  } catch {
    return [...SEED];
  }
}

export function persistEasingFavorites(list: EasingFavorite[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage full / disabled — favorites stay session-local
  }
}

export function makeFavoriteId(): string {
  return `fav_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}
