export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly type = "gateway_error",
  ) {
    super(message);
  }
}

export function openAiError(error: GatewayError | Error, requestId?: string) {
  const known = error instanceof GatewayError;
  return {
    error: {
      message: error.message,
      type: known ? error.type : "gateway_error",
      param: null,
      code: known ? error.code : "gateway_error",
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}
