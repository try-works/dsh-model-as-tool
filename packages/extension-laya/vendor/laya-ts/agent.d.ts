import type { BinningMap, MinConfidence, OptionStats } from "./common.js";
import type { SessionProvider } from "./providers.js";
import { type TokenizerLike } from "./tokenizer.js";
import { type DecideOptions, type DecisionResult } from "./structured.js";
import { HookRegistry, type HookArg, type PredictHook } from "./hooks.js";
export declare const QTYPES: Record<string, number>;
export interface QuestionDef {
    type: string;
    instructions?: unknown;
    criteria?: unknown;
    [k: string]: unknown;
}
export interface ActionInfo {
    act_probability: number;
}
export interface ChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
    low_confidence?: boolean;
}
export interface ScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
    low_confidence?: boolean;
}
export interface NoulAnswer {
    type: "noul";
    noul: number;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
    low_confidence?: boolean;
}
export type SystemAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface SystemUsage {
    input_tokens: number;
    output_tokens: number;
    /** State-fit reporting (issue #174, mirrors Python #181). Present on inference results;
     * absent on hook-supplied (skipped) results and empty-question early returns. */
    state_tokens?: number;
    /** Worst case across the questions, which share one state but not one head budget. */
    state_tokens_dropped?: number;
    truncated?: boolean;
    truncated_questions?: string[];
    /** Present only when some question's options no longer have a token span each (issue #538,
     * Python `collapsed_options`), keyed by question id. Absent when every option kept its own. */
    options?: Record<string, OptionStats>;
}
export interface SystemOneResult {
    model: string;
    answers: Record<string, SystemAnswer>;
    usage: SystemUsage;
}
export interface AgentCfg {
    max_len?: number;
    head_max_len?: number;
    temperature?: unknown;
    temperature_by_options?: Record<string, unknown>;
    binning_map?: BinningMap | null;
    [k: string]: unknown;
}
export interface AgentOptions {
    provider: SessionProvider;
    tok?: TokenizerLike;
    cfg?: AgentCfg;
    /** Commit SHA the artifacts were loaded from (pinned/requested or `x-repo-commit`); null for local dirs. */
    revision?: string | null;
    max_len?: number;
    head_max_len?: number;
    temperature?: unknown;
    temperature_by_options?: Record<string, unknown>;
    /** Optional histogram-binning map applied to answer_confidence. */
    binning_map?: BinningMap | null;
    binningMap?: BinningMap | null;
    /**
     * Per-language temperature overrides, keyed by language code; keys are normalised to
     * their base subtag (`de-AT` -> `de`), matching Python `Agent(lang_temperatures=...)`.
     * Each entry may carry a `temperature` list of 3 floats (default: the base raw
     * temperature) and/or a `temperature_by_options` map (default: none). A matching
     * override replaces the scale wholesale — see the note at the decode site.
     */
    lang_temperatures?: Record<string, {
        temperature?: unknown;
        temperature_by_options?: Record<string, unknown>;
    } | null>;
    hooks?: HookArg;
    onPredictStart?: PredictHook;
    onPredictEnd?: PredictHook;
    hooksRaise?: boolean;
    /** Timeout for each hook call in seconds (null = no limit). */
    hooksTimeout?: number | null;
}
/** Per-call options shared by Agent.systemOne/predict and Router.predict. */
export interface PredictOptions {
    /**
     * Language of the request (e.g. "de"); when the Agent has a matching
     * `lang_temperatures` override it selects that language's temperature, exactly like
     * Python `system_one(..., lang=...)`. Routing alone never sets this.
     */
    lang?: string | null;
    hooks?: HookArg;
    onPredictStart?: PredictHook;
    onPredictEnd?: PredictHook;
    hooksRaise?: boolean;
    /** Timeout for each hook call in seconds (null = no limit). */
    hooksTimeout?: number | null;
    /** Per-call token-budget overrides; null = agent config. A start hook may also set them. */
    maxLen?: number | null;
    headMaxLen?: number | null;
    /** predictBatch: cap on states per shared forward pass; null sends them all in one pass. */
    batchSize?: number | null;
    /** Minimum confidence threshold in [0.0, 1.0] or per-bucket map. Low confidence answers get `low_confidence: true`. */
    minConfidence?: MinConfidence | null;
    /** Python parity alias for minConfidence. */
    min_confidence?: MinConfidence | null;
}
export declare function checkQuestion(qid: string, qdef: unknown): void;
export declare function toInternal(qdef: QuestionDef): {
    t: "choice" | "score" | "noul";
    ins: string;
    crit: unknown;
    labels?: {
        false: string;
        true: string;
    };
};
export declare function defaultTokenizer(): TokenizerLike;
export declare class Agent extends HookRegistry {
    hooksRaise: boolean;
    hooksTimeout?: number | null;
    cfg: AgentCfg;
    provider: SessionProvider;
    revision: string | null;
    tok: TokenizerLike;
    maxLen: number;
    headMaxLen: number;
    temperatureRaw: unknown;
    temperatureByOptionsRaw: Record<string, unknown>;
    temperature: number[];
    temperatureByOptions: Record<string, number>;
    readonly binningMap: BinningMap | null;
    langTemperatures: Record<string, {
        temperature: number[];
        temperatureByOptions: Record<string, number>;
    }>;
    constructor(opts: AgentOptions);
    /**
     * Evaluate typed questions across one state in a single forward pass.
     *
     * `hooks` / `onPredictStart` / `onPredictEnd` observe or shape the prediction, appended
     * after any hooks installed on the Agent; a start hook may rewrite the state/questions or
     * call `ctx.skip(...)` to short-circuit inference, an end hook may rewrite the results.
     * See hooks.ts. `hooksRaise` overrides the Agent's setting for this call.
     */
    systemOne(state: unknown, questions: Record<string, QuestionDef>, opts?: PredictOptions): Promise<SystemOneResult>;
    private _predictHooked;
    /** Encode one state into one sequence row per question; the state text is tokenized once. */
    private _encodeItems;
    /**
     * Evaluate one shared question schema over many states. Each chunk of up to `batchSize`
     * states is collated into a single encoder+head forward pass; results align with `states`
     * by index. (Python `Agent.predict_batch` parity; its `sort_by_length` is not ported.)
     */
    private _systemOneMany;
    /** Decode one head row into the answer for its question. */
    private _decodeRow;
    predict(state: unknown, questions: Record<string, QuestionDef>, opts?: PredictOptions): Promise<SystemOneResult>;
    /**
     * Evaluate the same questions over many states, packing each chunk of up to
     * `opts.batchSize` states into one shared forward pass (Python `Agent.predict_batch`
     * parity). This is the throughput path: `systemOne`/`predict` run one state per forward
     * pass, which leaves most of the batch dimension idle on GPU. Results align with
     * `states` by index and are identical in shape to `systemOne`'s output.
     *
     * `opts.maxLen` / `opts.headMaxLen` override the agent config for this call; a start
     * hook may also set `ctx.maxLen` / `ctx.headMaxLen` or call `ctx.skip(results)`.
     * Python's `sort_by_length` grouping is not ported.
     */
    predictBatch(states: unknown[], questions: Record<string, QuestionDef>, opts?: PredictOptions): Promise<SystemOneResult[]>;
    /**
     * Answer `state` against a JSON schema (or explicit `opts.questions`) and return typed
     * values — see `structured.ts`. Pass exactly one of `schema` or `opts.questions`; other
     * options are forwarded to `predict`.
     */
    decide(state: unknown, schema: unknown, opts: DecideOptions & PredictOptions & {
        returnDetails: true;
    }): Promise<DecisionResult>;
    decide(state: unknown, schema?: unknown, opts?: DecideOptions & PredictOptions): Promise<Record<string, unknown>>;
    static load(modelDirOrRepo: string, opts?: {
        device?: string;
        subfolder?: string | null;
        localDir?: string;
        token?: string | null;
        numThreads?: number;
        /** Per-language temperature overrides; see AgentOptions.lang_temperatures. */
        lang_temperatures?: AgentOptions["lang_temperatures"];
        /** Optional commit SHA/branch/tag to fetch; omitted uses the Hub default and existing cache. */
        revision?: string | null;
        /**
         * Opt-in `{artifact name: SHA-256 hexdigest}` check before any artifact is parsed
         * or executed. A missing artifact or digest mismatch throws and loading is refused.
         */
        expectedSha256?: Record<string, string>;
        signal?: AbortSignal | null;
        onProgress?: ((done: number, total: number, file: string) => void) | null;
    }): Promise<Agent>;
}
