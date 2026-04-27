const PATTERNS: Array<[RegExp, string]> = [
  [/AUTHORIZATION:\s*Basic\s+\S+/gi, "AUTHORIZATION: Basic ***"],
  [/x-access-token:[^@\s'"]+/g, "x-access-token:***"],
  [/ghs_[A-Za-z0-9]{20,}/g, "ghs_***"],
  [/ghu_[A-Za-z0-9]{20,}/g, "ghu_***"],
  [/gho_[A-Za-z0-9]{20,}/g, "gho_***"],
];

export function maskSecrets(input: string): string {
  let output = input;

  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output;
}
