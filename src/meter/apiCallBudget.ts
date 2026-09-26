/** Shared cap on outbound token-count API HTTP requests per analyze run. */
export class ApiCallBudget {
  private remaining: number;

  constructor(maxCalls: number) {
    this.remaining = Math.max(0, maxCalls);
  }

  tryConsume(): boolean {
    if (this.remaining <= 0) {
      return false;
    }
    this.remaining -= 1;
    return true;
  }

  get remainingCalls(): number {
    return this.remaining;
  }
}
