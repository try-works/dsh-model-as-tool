export declare function cleanEmailBody(body: string, maxChars?: number): string;
export declare function emailState(subject: string, body: string, sender?: string | null, clean?: boolean, extra?: Record<string, unknown>, maxChars?: number): Record<string, unknown>;
