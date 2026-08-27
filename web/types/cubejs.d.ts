declare module 'cubejs' {
  class Cube {
    static initSolver(): void;
    static fromString(facelets: string): Cube;
    move(algorithm: string): Cube;
    solve(maxDepth?: number): string;
  }

  export = Cube;
}
