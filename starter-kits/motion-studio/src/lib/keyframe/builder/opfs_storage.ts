/**
 * Minimal OPFS storage stub (vendored integration).
 *
 * The upstream repo ships a full OPFS (Origin Private File System) streaming
 * bake-cache implementation. For the vendored integration we keep the same
 * public surface but operate in pure in-memory mode so the engine runs
 * everywhere (including non-secure contexts where OPFS is unavailable).
 * The engine gracefully degrades: mount() returns false and frame-index
 * lookups always miss, falling back to live evaluation.
 */

import type { EvaluatedInstance } from "./builder/types";

export class OPFSStorage {
  private mounted = false;

  public async mount(): Promise<boolean> {
    // OPFS requires a secure browser context; skip entirely in this build.
    this.mounted = false;
    return this.mounted;
  }

  public async buildFrameIndex(): Promise<void> {
    // no-op in memory mode
  }

  public isMounted(): boolean {
    return this.mounted;
  }

  public getFrameFromIndex(_globalTime: number): EvaluatedInstance[] | null {
    return null;
  }
}
