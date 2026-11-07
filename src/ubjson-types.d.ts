// @shelacek/ubjson's types take only an ArrayBuffer, but its decode copies whatever it is handed into a new Uint8Array
// first (`new Uint8Array(buffer)`), so a Uint8Array (the bytes of a fetched replay) decodes the same. TypeScript 5.7 and
// later no longer let a Uint8Array pass as an ArrayBuffer; this overload says what the library does.
import type { UbjsonDecoderOptions } from "@shelacek/ubjson";

declare module "@shelacek/ubjson" {
  export function decode(buffer: ArrayBuffer | Uint8Array, options?: Partial<UbjsonDecoderOptions>): any;
}
