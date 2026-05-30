import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { DocumentStore, PutDocumentInput, PutDocumentResult } from './document-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSION_PATTERN = /^[a-z0-9]+$/;

export class LocalFsDocumentStore implements DocumentStore {
  private readonly docsRoot: string;

  constructor(storagePath: string) {
    this.docsRoot = resolve(storagePath, 'docs');
  }

  async put(input: PutDocumentInput): Promise<PutDocumentResult> {
    if (!UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.claimId) || !UUID_PATTERN.test(input.documentId)) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Invalid document path identifiers');
    }

    if (!EXTENSION_PATTERN.test(input.extension)) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Invalid document extension');
    }

    const directory = resolve(this.docsRoot, input.tenantId, input.claimId);
    const fullPath = resolve(directory, `${input.documentId}.${input.extension}`);

    this.ensureWithinDocsRoot(fullPath);

    await mkdir(directory, { recursive: true });
    await writeFile(fullPath, input.data);

    return { storagePath: fullPath };
  }

  async get(storagePath: string): Promise<Buffer> {
    const safePath = this.resolveSafePath(storagePath);
    return readFile(safePath);
  }

  async getStream(storagePath: string) {
    const safePath = this.resolveSafePath(storagePath);
    return createReadStream(safePath);
  }

  async delete(storagePath: string): Promise<void> {
    const safePath = this.resolveSafePath(storagePath);

    try {
      await unlink(safePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    const safePath = this.resolveSafePath(storagePath);

    try {
      await access(safePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveSafePath(storagePath: string): string {
    const fullPath = resolve(storagePath);
    this.ensureWithinDocsRoot(fullPath);
    return fullPath;
  }

  private ensureWithinDocsRoot(pathToCheck: string): void {
    const rootWithSeparator = this.docsRoot.endsWith(sep) ? this.docsRoot : `${this.docsRoot}${sep}`;

    if (pathToCheck === this.docsRoot || pathToCheck.startsWith(rootWithSeparator)) {
      return;
    }

    throw new DomainError(ErrorCode.FORBIDDEN, 'Invalid storage path');
  }
}

export function createLocalFsDocumentStore(storagePath: string): LocalFsDocumentStore {
  return new LocalFsDocumentStore(storagePath);
}

