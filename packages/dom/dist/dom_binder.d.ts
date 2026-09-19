export interface BatchApplyOptions {
    transformPrefix?: string;
    engine?: any;
}
export declare class DOMAdapter {
    /**
     * Batch apply evaluated matrix transforms to DOM elements via matrix3d().
     * Minimizes reflows and includes performance guardrail (>200 elements warning).
     */
    batchApply(elements: Array<any>, time: number, options?: BatchApplyOptions): void;
}
export declare const domAdapter: DOMAdapter;
