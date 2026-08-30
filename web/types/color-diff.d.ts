declare module 'color-diff' {
  export type RGBColor = { R: number; G: number; B: number };
  export type LabColor = { L: number; a: number; b: number };

  export function diff(c1: RGBColor | LabColor, c2: RGBColor | LabColor, bc?: RGBColor): number;
  export function rgbaToLab(c: RGBColor, bc?: RGBColor): LabColor;
  export function closest<T extends RGBColor>(target: RGBColor, palette: T[], bc?: RGBColor): T;
}
