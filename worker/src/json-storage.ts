export async function encodeJsonGzip(value: unknown): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(value)]).stream();
  return new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

export async function decodeJsonGzip<T>(compressed: ArrayBuffer): Promise<T> {
  const source = new Blob([compressed]).stream();
  const json = await new Response(
    source.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return JSON.parse(json) as T;
}
