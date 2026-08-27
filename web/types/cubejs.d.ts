declare module 'cubejs' {
  class Cube {
    static initSolver(): void;
    static fromString(facelets: string): Cube;
    solve(maxDepth?: number): string;
  }

  export = Cube;
}
