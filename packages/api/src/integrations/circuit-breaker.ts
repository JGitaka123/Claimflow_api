import { DomainError, ErrorCode } from '@claimflow/shared';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  timeoutMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class CircuitBreaker<TArgs extends unknown[], TResult> {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly timeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  async execute(action: (...args: TArgs) => Promise<TResult>, ...args: TArgs): Promise<TResult> {
    if (this.state === 'OPEN') {
      const elapsedMs = Date.now() - this.openedAt;

      if (elapsedMs < this.resetTimeoutMs) {
        throw new DomainError(
          ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED,
          'External dependency temporarily unavailable (circuit open)',
        );
      }

      this.state = 'HALF_OPEN';
    }

    try {
      const result = await this.withTimeout(() => action(...args));
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private async withTimeout(fn: () => Promise<TResult>): Promise<TResult> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<TResult>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new DomainError(
            ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED,
            `External dependency timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
  }

  private onFailure(): void {
    this.failureCount += 1;

    if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}