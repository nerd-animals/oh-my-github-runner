const MAX_MENTIONS = 30;

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
// `#N` only when not preceded by a word/digit character (so `abc#36`,
// `page#36`, `0x#36` do not match) and not followed by another digit.
const ISSUE_MENTION = /(?<![\w])#(\d+)(?!\d)/g;

export function parseBodyMentions(body: string, selfNumber: number): number[] {
  if (body.length === 0) {
    return [];
  }

  const stripped = body
    .replace(FENCED_CODE_BLOCK, "")
    .replace(INLINE_CODE, "");

  const seen = new Set<number>();
  const ordered: number[] = [];

  for (const match of stripped.matchAll(ISSUE_MENTION)) {
    const captured = match[1];
    if (captured === undefined) {
      continue;
    }
    const number = Number.parseInt(captured, 10);
    if (!Number.isFinite(number) || number <= 0) {
      continue;
    }
    if (number === selfNumber) {
      continue;
    }
    if (seen.has(number)) {
      continue;
    }
    seen.add(number);
    ordered.push(number);

    if (ordered.length >= MAX_MENTIONS) {
      break;
    }
  }

  return ordered;
}
