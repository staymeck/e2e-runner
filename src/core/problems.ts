/** Collects every configuration problem so the operator fixes them in one pass. */
export class Problems {
  private readonly found: string[] = [];

  add(message: string): void {
    this.found.push(message);
  }

  get list(): readonly string[] {
    return this.found;
  }

  get any(): boolean {
    return this.found.length > 0;
  }
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}
