import type { QuestionDef, SystemOneResult } from "./agent.js";
export declare const DEFAULT_SHORTLIST_K = 20;
export declare const DEFAULT_TOURNAMENT_GROUP = 16;
export declare const DEFAULT_SHORTLIST_MAXSIZE = 4096;
export type EmbedFn = (texts: string[]) => Promise<number[][]> | number[][];
export interface ShortlistMeta {
    labels: string[];
    scores: number[] | null;
    k: number;
    n: number;
    passthrough: boolean;
}
export interface TournamentMeta {
    labels: string[];
    n: number;
    rounds: number;
}
export interface CacheInfo {
    size: number;
    maxsize: number;
    hits: number;
    misses: number;
}
export interface CachedEmbedFn {
    (texts: string[]): Promise<number[][]>;
    cacheInfo(): CacheInfo;
    cache_info(): CacheInfo;
    cacheClear(): void;
    cache_clear(): void;
}
/** Return the top-k choice labels for state. Skips embed_fn when k >= n. */
export declare function shortlistChoice(state: unknown, criteria: unknown, embedFn: EmbedFn, k?: number, instructions?: unknown): Promise<string[]>;
/** Shortlist each choice question, then call predict/systemOne once. */
export declare function predictShortlist(agent: unknown, state: unknown, questions: Record<string, QuestionDef>, embedFn?: EmbedFn | null, k?: number, predictKwargs?: Record<string, unknown>): Promise<SystemOneResult & {
    shortlist: Record<string, ShortlistMeta>;
}>;
/**
 * Reduce large choices through balanced elimination rounds, then predict all questions.
 * Each round batches every group's question in one call. Metadata lists the finalists;
 * probabilities, confidence, usage and other result fields come from the final call only.
 */
export declare function predictTournament(agent: unknown, state: unknown, questions: Record<string, QuestionDef>, groupSize?: number, predictKwargs?: Record<string, unknown>): Promise<SystemOneResult & {
    tournament: Record<string, TournamentMeta>;
}>;
/** Mean-pool the agent's provider encoder. Throws honestly without encoder access. */
export declare function embedFnFromAgent(agent: unknown, maxLength?: number, batchSize?: number): EmbedFn;
/**
 * Wrap `embedFn` with an LRU cache keyed by text.
 *
 * Shortlisting embeds the query plus every option on every call. When the option
 * set is fixed -- a label list, an intent taxonomy -- those rows never change
 * between requests and are re-embedded every time. Wrapping the embedder once
 * leaves the first call unchanged and reduces each repeat to embedding the new
 * query alone.
 *
 * A cold cache costs the same number of embedder calls as the unwrapped function:
 * the misses are deduplicated and embedded in one call. Nothing is cached when
 * the embedder throws or returns a bad shape, so a transient failure cannot
 * poison the cache.
 *
 * @param embedFn The underlying embedding function
 * @param maxsize Maximum number of distinct text rows to cache (default: 4096)
 */
export declare function cachedEmbedFn(embedFn: EmbedFn, maxsize?: number): CachedEmbedFn;
export declare const cached: typeof cachedEmbedFn;
