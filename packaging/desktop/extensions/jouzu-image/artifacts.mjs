// Artifact store shared by tools and the desktop. One file per artifact plus a
// JSON sidecar; the id is the SHA-256 of the bytes, so identical output reuses
// the same artifact and only appends the prompt that produced it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function extensionFor(mimeType) {
  const extension = EXTENSIONS[mimeType];
  if (!extension) throw new Error(`Unsupported artifact type: ${mimeType}`);
  return extension;
}

/** PNG and JPEG dimensions are read from the header; other kinds stay null. */
export function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1];
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

export function artifactId(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readArtifact(home, kind, id) {
  try {
    return JSON.parse(await readFile(join(home, "artifacts", kind, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function saveArtifact({ home, kind, mimeType, bytes, source = {}, prompt = "" }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("The artifact has no data.");
  if (bytes.length > 64 * 1024 * 1024) throw new Error("The artifact is larger than the 64 MB limit.");
  const extension = extensionFor(mimeType);
  const id = artifactId(bytes);
  const directory = join(home, "artifacts", kind);
  await mkdir(directory, { recursive: true });
  const path = `${kind}/${id}.${extension}`;
  const file = join(directory, `${id}.${extension}`);
  const sidecar = join(directory, `${id}.json`);
  const previous = await readArtifact(home, kind, id);
  await writeFile(file, bytes);
  const prompts = [...new Set([...(Array.isArray(previous?.prompts) ? previous.prompts : []), ...(prompt ? [prompt] : [])])];
  const record = {
    schema: 1,
    id,
    kind,
    mimeType,
    path,
    bytes: bytes.length,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    source: { ...(previous?.source ?? {}), ...source },
    prompt: prompt || previous?.prompt || "",
    prompts,
    dimensions: imageDimensions(bytes) ?? previous?.dimensions ?? null,
  };
  await writeFile(sidecar, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
