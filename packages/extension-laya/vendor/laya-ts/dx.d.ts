import type { QuestionDef, SystemAnswer } from "./agent.js";
/** One-line question factories; output always passes checkQuestion. */
export declare const q: {
    choice(instructions: string, criteria: Record<string, unknown> | string[]): QuestionDef;
    score(instructions: string, criteria: unknown[]): QuestionDef;
    noul(instructions: string, criteria?: Record<string, unknown>, labels?: {
        false: string;
        true: string;
    }): QuestionDef;
};
/** Argmax label: choice string, score key, noul boolean. */
export declare function best(answer: SystemAnswer): string | boolean;
/** Top-k probability keys, descending. */
export declare function topK(probs: Record<string, number>, k: number): string[];
/** Confidence gate (default 0.8) on answer_confidence (max(p)) alone, so the
 * gate uses one scale across question types instead of mixing in entropy. */
export declare function isConfident(answer: Pick<SystemAnswer, "answer_confidence">, thresh?: number): boolean;
