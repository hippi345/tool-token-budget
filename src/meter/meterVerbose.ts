let verbose = false;

export function setMeterVerbose(enabled: boolean): void {
  verbose = enabled;
}

export function isMeterVerbose(): boolean {
  return verbose;
}

/** One-line stderr reason when HF exact path is unavailable (--verbose only). */
export function logMeterVerbose(line: string): void {
  if (verbose) {
    console.error(line);
  }
}
