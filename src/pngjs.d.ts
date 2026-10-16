declare module 'pngjs' {
  interface PngImage {
    width: number;
    height: number;
    data: Buffer;
  }
  export class PNG implements PngImage {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: { width?: number; height?: number; fill?: boolean });
    static sync: {
      read(buffer: Buffer | Uint8Array): PngImage;
      write(png: PngImage): Buffer;
    };
  }
}
