declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      cb: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
    ): void;
    free(): void;
  }
  export interface LibHeif {
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
  }
  const factory: (opts?: Record<string, unknown>) => LibHeif | Promise<LibHeif>;
  export default factory;
}
