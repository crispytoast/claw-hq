/**
 * Relay server, exposed as a module so the CLI can start it programmatically.
 *
 * Entry point (`src/index.ts`) is a thin wrapper that loads config from disk
 * and calls `startServer`. The CLI calls `startServer` directly with a config
 * it composed.
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolveConfig, type ClawHqConfig, type ResolvedConfig } from "./config.js";
import { openDb } from "./db.js";
import { registerAuthRoutes } from "./auth.js";
import { registerSystemRoutes } from "./system.js";
import { registerWsRoutes } from "./ws-routing.js";

export interface ServerHandle {
  config: ResolvedConfig;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  config?: ClawHqConfig;
  /** When set, the relay will accept this token on /ws/agent without DB lookup
   *  (used for the in-process auto-pair in single-host mode). */
  inProcessAgentToken?: string;
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const config = resolveConfig(opts.config);
  const db = openDb(config.dbPath);

  const fastify = Fastify({
    logger: { level: process.env.CLAW_HQ_LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  await fastify.register(fastifyCookie);
  await fastify.register(fastifyWebsocket);
  await registerAuthRoutes(fastify, { db, config });
  await registerSystemRoutes(fastify, { db, config });
  registerWsRoutes(fastify, { db, config, inProcessAgentToken: opts.inProcessAgentToken });

  if (existsSync(config.webDistPath)) {
    await fastify.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: "/",
    });
    fastify.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
        reply.code(404);
        return { error: "not found" };
      }
      return reply.sendFile("index.html");
    });
  } else {
    fastify.log.warn(`[relay] web dist not found at ${config.webDistPath}; SPA disabled (api+ws only)`);
  }

  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`[relay] auth mode: ${config.auth.mode}`);
  fastify.log.info(`[relay] data dir:  ${config.dataDir}`);
  fastify.log.info(`[relay] public:    ${config.publicUrl}`);

  return {
    config,
    async stop() {
      await fastify.close();
    },
  };
}
