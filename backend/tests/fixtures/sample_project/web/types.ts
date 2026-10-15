export interface Point {
  x: number;
  y: number;
}

export type Handler = (event: string) => void;

export enum Mode {
  Fast = "fast",
  Slow = "slow",
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
