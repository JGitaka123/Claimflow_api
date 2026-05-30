import type { Readable } from 'node:stream';

export interface PutDocumentInput {
  tenantId: string;
  claimId: string;
  documentId: string;
  extension: string;
  data: Buffer;
}

export interface PutDocumentResult {
  storagePath: string;
}

export interface DocumentStore {
  put(input: PutDocumentInput): Promise<PutDocumentResult>;
  get(storagePath: string): Promise<Buffer>;
  getStream(storagePath: string): Promise<Readable>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}
