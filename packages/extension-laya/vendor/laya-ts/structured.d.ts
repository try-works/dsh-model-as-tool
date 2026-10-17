/**
 * Schema-driven decisions: turn a JSON schema into Laya questions.
 *
 * Port of `laya/structured.py` (#280). Provider-free. The mapping is a documented subset:
 * an object of properties, each an enum choice, a boolean, or a bounded integer scale.
 * Anything that cannot be answered from a fixed option set (free strings, arrays, nested
 * objects, $ref) is rejected with a SchemaError that names the path.
 *
 *     const values = await agent.decide(state, {
 *       type: "object",
 *       properties: {
 *         department: { type: "string", enum: ["billing", "support", "sales"] },
 *         urgency: { type: "integer", minimum: 0, maximum: 2 },
 *         needs_human: { type: "boolean" },
 *       },
 *     });
 *
 * Zod/TypeBox users can pass their schema's JSON form (`z.toJSONSchema(Model)`); anything
 * with a `toJSONSchema()` method is accepted.
 */
import type { QuestionDef } from "./agent.js";
import type { MinConfidence } from "./common.js";
export declare const MAX_PROPERTIES = 32;
export declare const MAX_OPTIONS = 32;
export declare const MAX_SCORE_LEVELS = 10;
/** A schema cannot be expressed as Laya questions; the message names the path. */
export declare class SchemaError extends Error {
    constructor(message: string);
}
/** The detailed result of `decide(..., { returnDetails: true })`. */
export interface DecisionResult {
    /** Schema-shaped output (choice values, integer levels, booleans). */
    values: Record<string, unknown>;
    /** Per-field confidence. */
    confidence: Record<string, number>;
    /** Per-field probabilities (noul fields report { false, true }). */
    probabilities: Record<string, Record<string, unknown>>;
    /** Laya's raw answer per field. */
    answers: Record<string, unknown>;
    usage?: unknown;
    routing?: unknown;
}
/** One planned field: the Laya question plus how to project its answer back. */
export interface PlannedField {
    name: string;
    kind: "choice" | "score" | "noul";
    question: QuestionDef;
    /** choice: (label, value) pairs, in enum order. */
    options?: [string, unknown][];
    /** score: value of level 0. */
    minimum?: number;
}
/** Anything with an async predict(state, questions, opts) — Agent and Router both qualify. */
export interface DecideRunner {
    predict(state: unknown, questions: Record<string, QuestionDef>, opts?: Record<string, unknown>): Promise<{
        answers?: Record<string, Record<string, any> | undefined>;
        usage?: unknown;
        routing?: unknown;
    }>;
}
export interface DecideOptions {
    /** Explicit questions instead of a schema (answers are returned unprojected). */
    questions?: Record<string, QuestionDef>;
    /** Return a DecisionResult with confidence, probabilities and raw answers. */
    returnDetails?: boolean;
    /** Minimum confidence threshold in [0.0, 1.0] or per-bucket map. Low confidence answers project to null. */
    minConfidence?: MinConfidence | null;
    /** Python parity alias for minConfidence. */
    min_confidence?: MinConfidence | null;
    /** Anything else is forwarded to runner.predict (hooks, model, ...). */
    [k: string]: unknown;
}
/** Validate a JSON schema and return one planned field per property. */
export declare function planFromJsonSchema(schema: unknown): PlannedField[];
/** Turn a JSON schema into Laya questions (a documented subset; see the module docstring). */
export declare function questionsFromJsonSchema(schema: unknown): Record<string, QuestionDef>;
/** Project Laya answers onto the schema values (choice value, integer level, boolean). */
export declare function answersToJson(answers: Record<string, Record<string, any> | undefined>, schema: unknown): Record<string, unknown>;
/**
 * Answer `state` against a schema (or explicit questions) and return the decided values.
 *
 * Pass exactly one of `schema` or `opts.questions`. With `schema`, the values follow the
 * schema (choice values, integer levels, booleans). With `questions`, the raw answers are
 * returned. Extra options are forwarded to `runner.predict`.
 */
export declare function decide(runner: DecideRunner, state: unknown, schema: unknown, opts: DecideOptions & {
    returnDetails: true;
}): Promise<DecisionResult>;
export declare function decide(runner: DecideRunner, state: unknown, schema?: unknown, opts?: DecideOptions): Promise<Record<string, unknown>>;
