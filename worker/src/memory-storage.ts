import type { StrategyMemory } from "./contracts";

export async function encodeStrategyMemory(
  memory: StrategyMemory,
): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(memory)]).stream();
  return new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

export async function decodeStrategyMemory(
  compressed: ArrayBuffer,
): Promise<StrategyMemory> {
  const source = new Blob([compressed]).stream();
  const json = await new Response(
    source.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return JSON.parse(json) as StrategyMemory;
}
