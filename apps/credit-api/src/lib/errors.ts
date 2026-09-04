export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function assertFound<T>(value: T | undefined, code: string, message: string): T {
  if (value === undefined) throw new AppError(404, code, message);
  return value;
}
