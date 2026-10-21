export async function ImageReplayPayloadProbe(input: { text: string; count: number }): Promise<string> {
  return `${input.text}:${input.count}`;
}
