import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";

import { config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { serializeBigInts } from "./lib/serialization.js";
import { registerRoutes } from "./http/routes.js";

export async function buildApp() {
  const app = Fastify({
    logger: config.NODE_ENV !== "test",
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });

  await app.register(helmet);
  await app.register(cors, {
    origin:
      config.NODE_ENV === "development"
        ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
        : config.CORS_ORIGINS,
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.addHook("preSerialization", async (_request, _reply, payload) =>
    serializeBigInts(payload),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          issues: error.issues,
          requestId: request.id,
        },
      });
    }

    request.log.error(error);
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred",
        requestId: request.id,
      },
    });
  });

  await registerRoutes(app);
  return app;
}
