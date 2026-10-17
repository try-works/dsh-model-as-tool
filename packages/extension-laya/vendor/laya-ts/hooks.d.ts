/**
 * Opt-in prediction hooks: observe or shape every decision without forking.
 *
 * A hook is either a plain `(ctx) => void` or an object implementing any subset of the
 * lifecycle methods on `Hook`. Hooks are configured on `Agent` / `Router` and can be
 * overridden per call. Port of `laya/hooks.py`.
 */
/** Mutable state passed to every hook for one call. */
export declare class PredictContext {
    /** `states` / `questions` may be rewritten by `onPredictStart`. */
    states: unknown[];
    questions: Record<string, unknown>;
    /** Shared by every hook of one call. */
    runId: string;
    /** Set by `skip()` or after inference; `onPredictEnd` may rewrite it. */
    results: Record<string, unknown>[] | null;
    /** Router: the RouteDecision. */
    decision: Record<string, unknown> | null;
    /** Resolved checkpoint name. */
    model: string | null;
    agent: unknown;
    router: unknown;
    /** Per-call token-budget overrides; null = agent config. */
    maxLen: number | null;
    headMaxLen: number | null;
    /** Aggregated input/output tokens across results. */
    usage: Record<string, number> | null;
    startedAt: number;
    elapsedMs: number | null;
    error: unknown;
    constructor(init: {
        states: unknown[];
        questions: Record<string, unknown>;
    } & Partial<PredictContext>);
    /** Set cached results from a start hook; inference is skipped, end hooks still run. */
    skip(results: Record<string, unknown>[]): void;
    /** Set elapsedMs from startedAt. Called by the dispatching call, not by hooks. */
    markElapsed(): void;
}
/** Optional lifecycle methods. Implement any subset; missing methods are skipped. */
export interface Hook {
    onPredictStart?(ctx: PredictContext): void | Promise<void>;
    onPredictEnd?(ctx: PredictContext): void | Promise<void>;
    onRoute?(ctx: PredictContext): void;
    onLoad?(ctx: PredictContext): void | Promise<void>;
    onEvict?(ctx: PredictContext): void | Promise<void>;
    onError?(ctx: PredictContext): void | Promise<void>;
}
export type PredictHook = (ctx: PredictContext) => void | Promise<void>;
export type HookArg = Hook | Hook[] | null | undefined;
export type PredictHookArg = PredictHook | PredictHook[] | null | undefined;
export declare const HOOK_EVENTS: readonly ["onPredictStart", "onPredictEnd", "onRoute", "onLoad", "onEvict", "onError"];
export type HookEvent = (typeof HOOK_EVENTS)[number];
/**
 * No-op base class: subclass it and override only the events you need.
 *
 * `Hook` is the structural interface; `BaseHook` is the concrete convenience when you would
 * rather subclass than implement methods by shape. Every method does nothing by default.
 */
export declare class BaseHook implements Hook {
    onPredictStart(_ctx: PredictContext): void;
    onPredictEnd(_ctx: PredictContext): void;
    onRoute(_ctx: PredictContext): void;
    onLoad(_ctx: PredictContext): void;
    onEvict(_ctx: PredictContext): void;
    onError(_ctx: PredictContext): void;
}
/**
 * Normalise the hook arguments shared by Agent, Router and every predict call: an optional
 * hook (object or list) plus optional plain start/end callables. A plain callable is not a
 * hook on its own -- which lifecycle event would it bind to? Passing one as `hooks` is a
 * TypeError; pass it as `onPredictStart` / `onPredictEnd` instead. The same callable as both
 * start and end is a TypeError too: the registry dedupes by identity, so one of the two would
 * silently never fire.
 */
export declare function normaliseHooks(hooks?: unknown, onPredictStart?: PredictHookArg, onPredictEnd?: PredictHookArg): Hook[];
/** The process-wide hooks, a copy, in order. Empty unless set via `setDefaultHooks`. */
export declare function defaultHooks(): Hook[];
/**
 * Replace the process-wide default hooks.
 *
 * Defaults run before installed and per-call hooks for every `Agent` and `Router` in the
 * process, so a tracer or metrics hook does not have to be threaded through every
 * construction. Accepts the same arguments as the `hooks` option.
 */
export declare function setDefaultHooks(hooks?: HookArg, onPredictStart?: PredictHookArg, onPredictEnd?: PredictHookArg): void;
/** Append one hook or a list of hooks to the process-wide defaults. */
export declare function addDefaultHook(hook: HookArg): void;
/** Remove every process-wide default hook. */
export declare function clearDefaultHooks(): void;
/** `Router.predict` marks the options of its Agent call: the Router already ran the defaults for this request. */
export declare function markDefaultsRan(opts: object): void;
/** Whether `opts` was marked by `markDefaultsRan`, so the Agent must not run the defaults a second time. */
export declare function defaultsAlreadyRan(opts: object): boolean;
/**
 * Effective hook list for one call: defaults, then installed, then per-call hooks.
 *
 * Reads the process-wide defaults at call time, so hooks set after construction still apply.
 */
export declare function composeHooks(installed: readonly Hook[], hooks?: HookArg, onPredictStart?: PredictHookArg, onPredictEnd?: PredictHookArg): Hook[];
/**
 * Base class giving a runtime-mutable hook list.
 *
 * `Agent` and `Router` extend it so hooks can be added, removed or scoped after construction.
 * Mutation replaces the array, so a call that already snapshotted its active hooks is never
 * disturbed by an add or remove that lands mid-flight.
 */
export declare class HookRegistry {
    hooks: Hook[];
    /** Install one hook or a list of them. Returns this for chaining. */
    addHook(hook: HookArg): this;
    /** Remove a hook by identity. Returns true if it was installed. */
    removeHook(hook: unknown): boolean;
    /**
     * Run `fn` with hooks installed, then remove them -- works for sync and async `fn`:
     *
     *     await router.withHooks([tracer], () => router.predict(state, questions));
     */
    withHooks<T>(hookArgs: HookArg[], fn: () => T): T;
}
/** Sum the per-state usage blocks so a hook sees one total for the call. */
export declare function aggregateUsage(results: Record<string, unknown>[]): Record<string, number>;
export declare function dispatch(hooks: Hook[], event: HookEvent, ctx: PredictContext, opts?: {
    raiseErrors?: boolean;
    timeoutMs?: number | null;
    hook?: Hook;
}): void;
/** Like `dispatch`, but waits for each hook that returns a promise before the next runs, and a
 *  rejection follows `raiseErrors` the way a thrown error does. */
export declare function dispatchAsync(hooks: Hook[], event: HookEvent, ctx: PredictContext, opts?: {
    raiseErrors?: boolean;
    timeoutMs?: number | null;
    hook?: Hook;
}): Promise<void>;
