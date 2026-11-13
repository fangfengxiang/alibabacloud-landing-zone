import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MiB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * MiB;
const MAX_EXTRACTED_BYTES = 256 * MiB;
const MAX_ENTRIES = 10_000;
const MAX_ARTIFACT_BYTES = 50 * MiB;
const MAX_ARTIFACTS = 200;
const MAX_ARTIFACT_TOTAL_BYTES = 200 * MiB;
const MAX_RECEIPT_BYTES = MiB;
const NETWORK_TIMEOUT_MS = 60_000;

const ZIP_END = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_DESCRIPTOR = 0x08074b50;
const ZIP_DESCRIPTOR_FLAG = 8;
const ZIP_ALLOWED_FLAGS = 0x080e;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function requireValid(condition, code) {
  if (!condition) throw new Error(code);
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function portablePath(name) {
  requireValid(typeof name === 'string' && name.length <= 1024, 'CAPSULE_PATH_INVALID');
  const parts = name.split('/');
  requireValid(parts.every(part => part && part !== '.' && part !== '..'
    && !/[\x00-\x1f\x7f\\:*?"<>|]|[ .]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)), 'CAPSULE_PATH_INVALID');
  return parts;
}

function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('RUNTIME_URL_INVALID'); }
  requireValid(['http:', 'https:'].includes(url.protocol)
    && !url.username && !url.password && !url.hash, 'RUNTIME_URL_INVALID');
  return url;
}

function networkSignal(signal) {
  const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponse(response, maximum, code) {
  requireValid(response.ok && response.body, code);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    requireValid(total <= maximum, code);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function verifyArchive(frame, bytes) {
  requireValid(bytes.length === frame.size
    && /^[a-f0-9]{32}$/i.test(frame.md5)
    && digest('md5', bytes) === frame.md5.toLowerCase(), 'CAPSULE_ARCHIVE_INTEGRITY_FAILED');
  const sha256 = 'sha256:' + digest('sha256', bytes);
  if (frame.checksum != null) {
    requireValid(frame.checksumAlgorithm === 'sha256' && frame.checksumScope === 'zip_archive'
      && frame.checksum === sha256, 'CAPSULE_ARCHIVE_INTEGRITY_FAILED');
  }

  const signedFields = [frame.signature, frame.signatureRef, frame.signatureAlgorithm,
    frame.signaturePublicKey, frame.issuer, frame.expiresAt];
  if (signedFields.every(field => field == null)) return;

  requireValid(frame.signatureAlgorithm === 'ed25519' && frame.issuer === 'autowonder-server'
    && Date.parse(frame.expiresAt) > Date.now()
    && signedFields.every(field => typeof field === 'string' && field.length > 0)
    && frame.checksum === sha256, 'CAPSULE_SIGNATURE_INVALID');
  const der = Buffer.from(frame.signaturePublicKey, 'base64');
  const signature = Buffer.from(frame.signature, 'base64');
  requireValid(der.length === 44 && signature.length === 64
    && frame.signatureRef === 'sha256:' + digest('sha256', der), 'CAPSULE_SIGNATURE_INVALID');
  const message = Buffer.from(['autowonder.taskPackage.signature.v1', frame.issuer, frame.signatureRef,
    frame.expiresAt, frame.packageId, sha256, ''].join('\n'));
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    requireValid(key.asymmetricKeyType === 'ed25519' && verify(null, message, key, signature),
      'CAPSULE_SIGNATURE_INVALID');
  } catch {
    throw new Error('CAPSULE_SIGNATURE_INVALID');
  }
}

function archiveEnd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === ZIP_END && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      return offset;
    }
  }
  throw new Error('CAPSULE_ZIP_INVALID');
}

function zipEntries(bytes) {
  const end = archiveEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const directory = bytes.readUInt32LE(end + 16);
  requireValid(count > 0 && count <= MAX_ENTRIES
    && bytes.readUInt32LE(end + 4) === 0 && bytes.readUInt16LE(end + 8) === count
    && directory + bytes.readUInt32LE(end + 12) === end, 'CAPSULE_ZIP_INVALID');

  const entries = new Map();
  const foldedNames = new Set();
  let offset = directory;
  let total = 0;
  for (let index = 0; index < count; index++) {
    requireValid(offset + 46 <= end && bytes.readUInt32LE(offset) === ZIP_CENTRAL, 'CAPSULE_ZIP_INVALID');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const fileType = mode & 0o170000;
    total += size;
    requireValid(next <= end && bytes.readUInt16LE(offset + 34) === 0
      && !(flags & ~ZIP_ALLOWED_FLAGS) && (method === 0 || method === 8)
      && total <= MAX_EXTRACTED_BYTES && (fileType === 0 || fileType === 0o100000)
      && local + 30 <= directory, 'CAPSULE_ZIP_INVALID');

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = UTF8.decode(nameBytes);
    const parts = portablePath(name);
    const folded = name.normalize('NFC').toLowerCase();
    requireValid(!foldedNames.has(folded), 'CAPSULE_PATH_INVALID');
    foldedNames.add(folded);
    const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressedSize;
    requireValid(bytes.readUInt32LE(local) === ZIP_LOCAL && bytes.readUInt16LE(local + 6) === flags
      && bytes.readUInt16LE(local + 8) === method && bytes.readUInt16LE(local + 26) === nameLength
      && bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)
      && dataEnd <= directory, 'CAPSULE_ZIP_INVALID');

    let localEnd = dataEnd;
    if (flags & ZIP_DESCRIPTOR_FLAG) {
      requireValid(dataEnd + 12 <= directory, 'CAPSULE_ZIP_INVALID');
      const descriptor = bytes.readUInt32LE(dataEnd) === ZIP_DESCRIPTOR ? dataEnd + 4 : dataEnd;
      requireValid(descriptor + 12 <= directory && bytes.readUInt32LE(descriptor) === crc
        && bytes.readUInt32LE(descriptor + 4) === compressedSize
        && bytes.readUInt32LE(descriptor + 8) === size, 'CAPSULE_ZIP_INVALID');
      localEnd = descriptor + 12;
    } else {
      requireValid(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressedSize
        && bytes.readUInt32LE(local + 22) === size, 'CAPSULE_ZIP_INVALID');
    }
    entries.set(name, { local, localEnd, dataStart, dataEnd, method, size, parts });
    offset = next;
  }

  const ordered = [...entries.values()].sort((a, b) => a.local - b.local);
  requireValid(offset === end && ordered[0].local === 0 && ordered.at(-1).localEnd === directory
    && ordered.every((entry, index) => index === 0 || ordered[index - 1].localEnd === entry.local),
  'CAPSULE_ZIP_INVALID');
  for (const name of foldedNames) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      requireValid(!foldedNames.has(parts.slice(0, i).join('/')), 'CAPSULE_PATH_INVALID');
    }
  }
  return entries;
}

function entryBytes(archive, entry) {
  requireValid(entry, 'CAPSULE_REQUIRED_FILE_MISSING');
  const data = archive.subarray(entry.dataStart, entry.dataEnd);
  const content = entry.method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) }) : data;
  requireValid(content.length === entry.size, 'CAPSULE_ZIP_INVALID');
  return content;
}

function jsonObject(bytes) {
  let value;
  try { value = JSON.parse(UTF8.decode(bytes)); } catch { throw new Error('CAPSULE_JSON_INVALID'); }
  requireValid(value && typeof value === 'object' && !Array.isArray(value), 'CAPSULE_JSON_INVALID');
  return value;
}

function verifyManifest(frame, manifest, entries) {
  requireValid(manifest.schemaVersion === 'autoWonder.taskPackage.v1'
    && frame.packageId === 'pkg_' + frame.dispatchId, 'CAPSULE_MANIFEST_INVALID');
  for (const key of ['packageId', 'dispatchId', 'tenantId', 'workitemId', 'executorId', 'agentId',
    'agentVersionId', 'sdlcStepId', 'attempt', 'idempotencyKey', 'issuer', 'signatureRef', 'expiresAt']) {
    if (frame[key] != null) {
      requireValid(String(manifest[key]) === String(frame[key]), 'CAPSULE_MANIFEST_MISMATCH');
    }
  }
  requireValid(manifest.fileDigests && typeof manifest.fileDigests === 'object'
    && !Array.isArray(manifest.fileDigests)
    && Object.keys(manifest.fileDigests).length === entries.size - 1, 'CAPSULE_MANIFEST_INVALID');
}

export async function prepareCapsule(frame, directory, signal) {
  requireValid(Number.isSafeInteger(frame.size) && frame.size > 0 && frame.size <= MAX_ARCHIVE_BYTES,
    'CAPSULE_SIZE_INVALID');
  requireValid((await lstat(directory)).isDirectory() && (await readdir(directory)).length === 0,
    'CAPSULE_DIRECTORY_INVALID');
  const url = httpUrl(frame.downloadUrl);
  const response = await fetch(url, { redirect: 'error', signal: networkSignal(signal) });
  const bytes = await readResponse(response, frame.size, 'CAPSULE_DOWNLOAD_FAILED');
  verifyArchive(frame, bytes);

  const entries = zipEntries(bytes);
  const manifest = jsonObject(entryBytes(bytes, entries.get('manifest.json')));
  verifyManifest(frame, manifest, entries);
  let sdlc;
  let identity;
  let workitem;
  for (const [name, entry] of entries) {
    signal?.throwIfAborted();
    const content = entryBytes(bytes, entry);
    if (name !== 'manifest.json') {
      requireValid(Object.hasOwn(manifest.fileDigests, name)
        && manifest.fileDigests[name] === 'sha256:' + digest('sha256', content), 'CAPSULE_FILE_INTEGRITY_FAILED');
    }
    if (name === 'identity.json') identity = jsonObject(content);
    if (name === 'sdlc.json') sdlc = jsonObject(content);
    if (name === 'workitem.md') workitem = UTF8.decode(content);
    const destination = join(directory, ...entry.parts);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { flag: 'wx', mode: 0o600 });
  }
  requireValid(identity && workitem !== undefined, 'CAPSULE_REQUIRED_FILE_MISSING');
  return { manifest, sdlc: sdlc ?? {}, identity, workitem };
}

async function artifactFiles(directory, signal) {
  const root = await realpath(directory);
  const artifacts = join(root, 'artifacts');
  const output = join(artifacts, 'output');
  for (const path of [artifacts, output]) {
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    requireValid(stat.isDirectory() && await realpath(path) === path, 'ARTIFACT_PATH_INVALID');
  }

  const files = [];
  let total = 0;
  let visited = 0;
  async function walk(path, relative) {
    for (const name of (await readdir(path)).sort()) {
      signal?.throwIfAborted();
      requireValid(++visited <= MAX_ENTRIES, 'ARTIFACT_LIMIT_EXCEEDED');
      const artifactPath = relative + '/' + name;
      portablePath(artifactPath);
      const absolute = join(path, name);
      const stat = await lstat(absolute);
      requireValid(await realpath(absolute) === absolute, 'ARTIFACT_PATH_INVALID');
      if (stat.isDirectory()) {
        await walk(absolute, artifactPath);
        continue;
      }
      requireValid(stat.isFile() && stat.nlink === 1, 'ARTIFACT_PATH_INVALID');
      total += stat.size;
      requireValid(files.length < MAX_ARTIFACTS && stat.size <= MAX_ARTIFACT_BYTES
        && total <= MAX_ARTIFACT_TOTAL_BYTES, 'ARTIFACT_LIMIT_EXCEEDED');
      files.push({ path: artifactPath, absolute, stat });
    }
  }
  await walk(output, 'artifacts/output');
  return files;
}

async function readArtifact(file) {
  const handle = await open(file.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    requireValid(stat.isFile() && stat.nlink === 1 && stat.size === file.stat.size
      && stat.dev === file.stat.dev && stat.ino === file.stat.ino
      && await realpath(file.absolute) === file.absolute, 'ARTIFACT_PATH_INVALID');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      requireValid(bytesRead > 0, 'ARTIFACT_CHANGED');
      offset += bytesRead;
    }
    const after = await handle.stat();
    requireValid(after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'ARTIFACT_CHANGED');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function uploadArtifacts(frame, directory, platformOrigin, token, signal) {
  const expectedPath = '/api/daemon/dispatches/' + frame.dispatchId + '/artifacts';
  requireValid(frame.artifactUploadPath === expectedPath, 'ARTIFACT_ENDPOINT_INVALID');
  const url = httpUrl(new URL(expectedPath, httpUrl(platformOrigin)));
  url.searchParams.set('token', token);

  const files = await artifactFiles(resolve(directory), signal);
  for (const file of files) {
    signal?.throwIfAborted();
    const bytes = await readArtifact(file);
    const form = new FormData();
    form.set('filesMetadata', JSON.stringify([{ path: file.path, sizeBytes: bytes.length,
      sha256: digest('sha256', bytes) }]));
    form.set('files', new Blob([bytes]), basename(file.absolute));
    const response = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: networkSignal(signal) });
    const body = jsonObject(await readResponse(response, MAX_RECEIPT_BYTES, 'ARTIFACT_UPLOAD_FAILED'));
    const receipt = Array.isArray(body.files) && body.files.length === 1 && body.files[0];
    requireValid(receipt && receipt.index === 0 && receipt.path === file.path
      && receipt.status === 'ACCEPTED' && receipt.sizeBytes === bytes.length
      && typeof receipt.ossRef === 'string' && receipt.ossRef, 'ARTIFACT_UPLOAD_REJECTED');
  }
  return files.length;
}
