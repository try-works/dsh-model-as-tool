export declare const NON_EN_DIACRITIC_RATE = 0.02;
export declare function stateText(state: unknown, maxChars?: number): string;
export declare function detectScript(text: string): string;
export declare function scriptProfile(text: string): Record<string, number>;
export interface LatinProfile {
    language: string | null;
    englishHits: number;
    diacriticRate: number;
    looksNonEnglish: boolean;
}
export declare function latinProfile(text: string): LatinProfile;
export declare function guessLatinLanguage(text: string): string | null;
export interface AnalyseResult {
    script: string;
    scriptProfile: Record<string, number>;
    language: string | null;
    isEnglish: boolean;
    languageUndecided: boolean;
    diacriticRate: number;
    nonLatinFraction: number;
    mixedSegment: string | null;
}
export declare function analyse(state: unknown): AnalyseResult;
export declare function isEnglish(state: unknown): boolean;
