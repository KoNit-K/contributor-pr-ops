export type Outcome = 'SUCCESS' | 'FAILED' | 'CONFIG_ERROR' | 'PAUSED' | 'PARTIAL';
export const exitCodes: Record<Outcome, number> = { SUCCESS: 0, FAILED: 1, CONFIG_ERROR: 2, PAUSED: 3, PARTIAL: 4 };

export class OpsError extends Error {
  constructor(message: string, public readonly outcome: Outcome = 'FAILED', public readonly code = 'OPERATION_FAILED') {
    super(message);
    this.name = 'OpsError';
  }
}

export function safeError(error: unknown): { status: Outcome; code: string; message: string } {
  if (error instanceof OpsError) return { status: error.outcome, code: error.code, message: error.message };
  // Dependency errors may carry authorization headers, response bodies or command output.
  return { status: 'FAILED', code: 'UNEXPECTED_ERROR', message: 'Operation failed. Run offline doctor and inspect the documented prerequisites.' };
}
