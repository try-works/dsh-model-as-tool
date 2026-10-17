/**
 * The BERT WordPiece tokenizer the MiniLM cross-encoder graph was trained with.
 *
 * The pinned checkpoint is an uncased BERT tokenizer (`do_lower_case: true`,
 * `do_basic_tokenize: true`, `strip_accents: null` — which HF applies as
 * `do_strip_accents = do_lower_case`). This module implements exactly the
 * BasicTokenizer step plus greedy longest-match WordPiece over the shipped
 * `vocab.txt`, so the extension needs no second runtime and no tokenizer
 * dependency: the same ORT build that runs the graph also feeds it.
 *
 * Pair encoding follows the BERT convention: `[CLS] query [SEP] passage [SEP]`
 * with type ids 0 for the query half and 1 for the passage half (including the
 * closing `[SEP]`), which is what the cross-encoder logits were trained on.
 *
 * The ids are pinned by golden fixtures in the suite (recorded from the HF
 * reference tokenizer), so a divergence surfaces as a test failure rather than
 * a silently different ranking.
 *
 * @module @try-works/extension-minilm-rerank/tokenizer
 */

/** The special ids the uncased BERT vocabulary assigns. */
export const PAD_ID = 0
export const UNK_ID = 100
export const CLS_ID = 101
export const SEP_ID = 102
export const MASK_ID = 103

/** The maximum positions the pinned graph declares. */
export const MODEL_MAX_LENGTH = 512

/** One tokenized sequence: ids only (this graph needs no type ids). */
export interface EncodedText {
  readonly inputIds: readonly number[]
  readonly attentionMask: readonly number[]
}

/** A loaded vocabulary: token → id. */
export type Vocabulary = ReadonlyMap<string, number>

/**
 * Parse the shipped `vocab.txt` (one token per line, line index is the id).
 * @param text - raw file contents.
 * @returns the token→id map.
 */
export function parseVocab(text: string): Vocabulary {
  const vocab = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const token = lines[index] ?? ''
    if (token.length === 0) continue
    if (!vocab.has(token)) vocab.set(token, index)
  }
  return vocab
}

/** One word after the basic tokenization step. */
function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
    || /[\p{Zs}]/u.test(char)
}

/** CJK ranges the HF basic tokenizer splits per character. */
function isChineseChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x20000 && code <= 0x2A6DF)
    || (code >= 0x2A700 && code <= 0x2B73F)
    || (code >= 0x2B740 && code <= 0x2B81F)
    || (code >= 0x2B820 && code <= 0x2CEAF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0x2F800 && code <= 0x2FA1F)
}

/** ASCII punctuation plus the Unicode punctuation classes HF splits on. */
function isPunctuation(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true
  return /[\p{P}\p{S}]/u.test(char)
}

/**
 * Fold one character to the form the uncased vocabulary expects: lowercase and
 * accent-stripped (NFD, remove combining marks), matching HF's `_run_strip_accents`.
 * @param char - one character.
 * @returns the folded character.
 */
function foldChar(char: string): string {
  const lower = char.toLowerCase()
  const decomposed = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return decomposed.length === 0 ? lower : decomposed
}

/**
 * Split text into basic tokens: whitespace, CJK characters one-by-one, and
 * punctuation as its own token; everything folded to lowercase ASCII-ish form.
 * @param text - the input text.
 * @returns the words to run through WordPiece.
 */
export function basicTokenize(text: string): string[] {
  const words: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.length > 0) {
      words.push(current)
      current = ''
    }
  }
  for (const char of text) {
    if (isWhitespace(char) || char === '\u0000' || char === '\uFFFD') {
      flush()
      continue
    }
    // Control characters (other than the whitespace handled above) are dropped.
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue
    if (isChineseChar(char)) {
      flush()
      words.push(char)
      continue
    }
    if (isPunctuation(char)) {
      flush()
      words.push(char)
      continue
    }
    current += foldChar(char)
  }
  flush()
  return words
}

/**
 * Greedy longest-match WordPiece over one word.
 * @param word - one basic token.
 * @param vocab - the token map.
 * @returns ids (unknown pieces contribute UNK once).
 */
export function wordPiece(word: string, vocab: Vocabulary): number[] {
  const maxChars = 100
  if (word.length > maxChars) return [UNK_ID]
  const ids: number[] = []
  let start = 0
  let unknown = false
  while (start < word.length) {
    let end = word.length
    let found = -1
    while (start < end) {
      const piece = start > 0 ? `##${word.slice(start, end)}` : word.slice(start, end)
      const id = vocab.get(piece)
      if (id !== undefined) {
        found = id
        break
      }
      end -= 1
    }
    if (found === -1) {
      unknown = true
      break
    }
    ids.push(found)
    start = end
  }
  return unknown ? [UNK_ID] : ids
}

/**
 * Tokenize one text into the model's input ids with the [CLS]/[SEP] frame and
 * truncation to `limit` positions (the graph's declared maximum is 512).
 * @param text - the input text.
 * @param vocab - the token map.
 * @param limit - maximum sequence length including the special tokens.
 * @returns the padded-free ids and the all-ones attention mask.
 */
export function encodeText(text: string, vocab: Vocabulary, limit: number = MODEL_MAX_LENGTH): EncodedText {
  const budget = Math.max(1, limit - 2)
  const ids: number[] = [CLS_ID]
  for (const word of basicTokenize(text)) {
    for (const id of wordPiece(word, vocab)) {
      if (ids.length >= budget + 1) break
      ids.push(id)
    }
    if (ids.length >= budget + 1) break
  }
  ids.push(SEP_ID)
  return { inputIds: ids, attentionMask: ids.map(() => 1) }
}

/** One tokenized pair: ids and the BERT segment ids (0 = query, 1 = passage). */
export interface EncodedPair {
  readonly inputIds: readonly number[]
  readonly attentionMask: readonly number[]
  readonly tokenTypeIds: readonly number[]
}

/**
 * Tokenize a query/passage pair as one sequence: `[CLS] query [SEP] passage
 * [SEP]`, with type ids 0 for the query half and 1 from the first passage token
 * through the closing `[SEP]` (the convention the cross-encoder was trained on).
 * @param query - the search query.
 * @param passage - the candidate passage.
 * @param vocab - the token map.
 * @param limit - maximum sequence length including the three special tokens.
 * @returns the padded-free ids, all-ones attention mask, and the segment ids.
 */
export function encodePair(
  query: string,
  passage: string,
  vocab: Vocabulary,
  limit: number = MODEL_MAX_LENGTH,
): EncodedPair {
  const budget = Math.max(1, limit - 3)
  const queryIds = wordPieceAll(query, vocab)
  const passageIds = wordPieceAll(passage, vocab)
  const ids: number[] = [CLS_ID]
  const segments: number[] = [0]
  for (const id of queryIds) {
    if (ids.length >= budget + 1) break
    ids.push(id)
    segments.push(0)
  }
  ids.push(SEP_ID)
  segments.push(0)
  for (const id of passageIds) {
    if (ids.length >= budget + 2) break
    ids.push(id)
    segments.push(1)
  }
  ids.push(SEP_ID)
  segments.push(1)
  return { inputIds: ids, attentionMask: ids.map(() => 1), tokenTypeIds: segments }
}

/** WordPiece every word of a text into one flat id list. */
function wordPieceAll(text: string, vocab: Vocabulary): number[] {
  const ids: number[] = []
  for (const word of basicTokenize(text)) ids.push(...wordPiece(word, vocab))
  return ids
}
