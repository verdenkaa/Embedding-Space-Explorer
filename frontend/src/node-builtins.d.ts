/**
 * Minimal ambient types for the Node built-ins used by tests that read a
 * source file from disk (e.g. the palette ⇄ tokens.css single-source check).
 * The frontend bundle itself never imports Node; this only satisfies tsc for
 * the vitest runtime, avoiding a full @types/node dev dependency.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readFileSync(path: string | URL, options: { encoding: "utf8" }): string;
}
