/** ONNX session shim: Node (onnxruntime-node) + browser (onnxruntime-web).
 * Lazy imports only — unit tests with a fake provider never touch onnxruntime. */
/** Opt-in reviewed commit SHAs of the published checkpoints (mirror of laya/revisions.py).
 * They are not applied implicitly, so existing Hub/offline caches keep working. */
export declare const PINNED_REVISIONS: Record<string, string>;
/** Return an explicit revision unchanged; otherwise preserve the Hub default and cache. */
export declare function resolveRevision(_repoOrId: string, revision?: string | null): string | null;
export interface Batch {
    inputIds: number[][];
    attentionMask: number[][];
    markerPos: number[][];
    markerMask: boolean[][];
    qtype: number[];
}
export interface SessionProvider {
    runEncoder(batch: Batch): Promise<{
        lastHidden: number[][][];
    }>;
    runHead(hidden: number[][][] | unknown, batch: Batch): Promise<{
        logits: number[][];
        act: number[][];
    }>;
}
/** Encoder feeds: input_ids + attention_mask (int64). */
export declare function feed(ort: any, b: Batch): Record<string, any>;
/** Head feeds: encoder hidden + marker_pos/mask + qtype. */
export declare function feedHead(ort: any, hidden: number[][][] | any, b: Batch): Record<string, any>;
export interface ProviderOptions {
    device?: string;
    numThreads?: number;
    /** Opt-in {artifact name: SHA-256 hexdigest} check for fetched ONNX files (web). */
    expectedSha256?: Record<string, string>;
    signal?: AbortSignal | null;
    onProgress?: ((done: number, total: number, file: string) => void) | null;
}
export interface NodeBundle {
    dir: string;
    cfg: any;
    tokenizerJson: unknown | null;
    /** Commit SHA the artifacts came from (pinned/requested, or the hub's `x-repo-commit`); null for local dirs. */
    revision: string | null;
}
export declare function loadNodeBundle(modelDirOrRepo: string, opts?: {
    subfolder?: string | null;
    localDir?: string;
    token?: string | null;
    revision?: string | null;
    expectedSha256?: Record<string, string>;
    signal?: AbortSignal | null;
    onProgress?: ((done: number, total: number, file: string) => void) | null;
}): Promise<NodeBundle>;
export interface WebBundle {
    dir: string;
    cfg: any;
    tokenizerJson: unknown | null;
    /** Pinned/requested commit SHA, if any (full-URL sources have no implicit revision). */
    revision: string | null;
}
export declare function loadWebBundle(repoOrUrl: string, opts?: {
    subfolder?: string | null;
    revision?: string | null;
    expectedSha256?: Record<string, string>;
    signal?: AbortSignal | null;
    onProgress?: ((done: number, total: number, file: string) => void) | null;
}): Promise<WebBundle>;
export declare function createNodeProvider(modelDir: string, opts?: ProviderOptions): Promise<SessionProvider>;
export declare function createWebProvider(modelUrl: string, opts?: ProviderOptions): Promise<SessionProvider>;
