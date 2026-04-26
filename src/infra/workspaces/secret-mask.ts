const PATTERNS: Array<[RegExp, string]> = [
  [/AUTHORIZATION:\s*Basic\s+\S+/gi, "AUTHORIZATION: Basic ***"],
  [/x-access-token:[^@\s'"]+/g, "x-access-token:***"],
];

export function maskSecrets(input: string): string {
  let output = input;

  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output;
}
