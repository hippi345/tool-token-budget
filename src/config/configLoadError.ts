export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}
