/**
 * Content-addressed file storage for chat attachments.
 *
 * Layout:
 *   <dataDir>/uploads/<sha256>.<ext>     — bytes
 *   <dataDir>/uploads/<sha256>.meta.json — {filename, mimeType, size, createdMs}
 *
 * POST /api/uploads   multipart/form-data with field "file" -> {id, url, mimeType, size, filename}
 * GET  /uploads/:id                                          -> bytes with correct Content-Type
 *
 * Trust model: trusted-lan + shared-secret deployments rely on the cookie-auth
 * helper from auth.ts. Uploads are gated by requireUser, same as every other
 * /api/* route. real-auth mode requires a logged-in user.
 */
import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveOwner } from "./auth.js";
import type { ResolvedConfig } from "./config.js";
import type Database from "better-sqlite3";

export interface UploadsDeps {
  config: ResolvedConfig;
  db: Database.Database;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per file
const SHA256_HEX = /^[0-9a-f]{64}$/;

function extFromName(filename: string | undefined): string {
  if (!filename) return "";
  const ext = path.extname(filename).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return "";
  return ext;
}

interface MetaRecord {
  filename: string;
  mimeType: string;
  size: number;
  createdMs: number;
}

async function readMeta(metaPath: string): Promise<MetaRecord | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8")) as MetaRecord;
  } catch {
    return null;
  }
}

export async function registerUploadsRoutes(app: FastifyInstance, deps: UploadsDeps): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_BYTES,
      files: 1,
      fieldSize: 1024 * 1024,
    },
  });

  const uploadsDir = path.join(deps.config.dataDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });

  app.post("/api/uploads", async (req, reply) => {
    const owner = resolveOwner(req, deps.config, deps.db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: "missing file" };
    }
    let size = 0;
    const hasher = createHash("sha256");
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reply.code(413);
        return { error: `file exceeds ${MAX_BYTES} bytes` };
      }
      hasher.update(chunk);
      chunks.push(chunk);
    }
    if (size === 0) {
      reply.code(400);
      return { error: "empty file" };
    }
    if (file.file.truncated) {
      reply.code(413);
      return { error: `file exceeds ${MAX_BYTES} bytes` };
    }
    const id = hasher.digest("hex");
    const ext = extFromName(file.filename);
    const blobPath = path.join(uploadsDir, `${id}${ext}`);
    const metaPath = path.join(uploadsDir, `${id}.meta.json`);
    // Skip rewrite if the same content was already uploaded (content-addressed).
    try {
      await fs.access(blobPath);
    } catch {
      await fs.writeFile(blobPath, Buffer.concat(chunks));
    }
    const meta: MetaRecord = {
      filename: file.filename ?? "upload",
      mimeType: file.mimetype || "application/octet-stream",
      size,
      createdMs: Date.now(),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta));
    return {
      id,
      url: `/uploads/${id}`,
      mimeType: meta.mimeType,
      filename: meta.filename,
      size: meta.size,
    };
  });

  app.get("/uploads/:id", async (req, reply) => {
    const params = req.params as { id?: string };
    const rawId = (params.id ?? "").toLowerCase();
    // Allow callers to send `<sha>.ext` too — strip the extension before lookup.
    const id = rawId.replace(/\.[a-z0-9]+$/, "");
    if (!SHA256_HEX.test(id)) {
      reply.code(404);
      return { error: "not found" };
    }
    const metaPath = path.join(uploadsDir, `${id}.meta.json`);
    const meta = await readMeta(metaPath);
    if (!meta) {
      reply.code(404);
      return { error: "not found" };
    }
    const ext = extFromName(meta.filename);
    const blobPath = path.join(uploadsDir, `${id}${ext}`);
    try {
      await fs.access(blobPath);
    } catch {
      reply.code(404);
      return { error: "not found" };
    }
    reply.header("Content-Type", meta.mimeType);
    reply.header("Content-Length", meta.size);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header(
      "Content-Disposition",
      `inline; filename="${meta.filename.replace(/"/g, "")}"`,
    );
    return reply.send(createReadStream(blobPath));
  });
}
