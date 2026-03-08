export const COMPLETE_TOKEN = '<promise>COMPLETE</promise>';

export function containsCompletionSignal(text: string): boolean {
  return text.includes(COMPLETE_TOKEN);
}

export function stripCompletionSignal(text: string): string {
  return text.replaceAll(COMPLETE_TOKEN, '').trim();
}

export function collectAgentText(chunks: readonly string[]): string {
  return chunks.filter(Boolean).join('\n').trim();
}
