import type { Bucket, CreateWriteStreamOptions, File, FileMetadata } from '@google-cloud/storage';
import { mosesBacklogDocumentFence, type MosesBacklogReceipt } from '@upperroom/contracts/mosesDeferredRecovery';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTempFile } from './utils';

const BUCKET = 'urm-app.appspot.com';
const invalid = (): never => {
  throw new Error('Unconfirmed backlog storage ownership');
};
export type BacklogOutput = { path: string; generation: string; bytes: string };
export type BacklogOutputs = { processed: BacklogOutput; final: BacklogOutput };

function generation(value: unknown): string {
  const number = Number(value);
  // The installed Storage SDK converts FileOptions.generation to a JS number.
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== String(value)) return invalid();
  return String(number);
}

export class MosesBacklogStorage {
  private readonly processed: string;
  private readonly final: string;
  private readonly writes = new Map<string, BacklogOutput>();
  readonly documentFence: ReturnType<typeof mosesBacklogDocumentFence>;
  constructor(
    private readonly bucket: Bucket,
    private readonly evidence: MosesBacklogReceipt,
    private readonly taskId: string
  ) {
    this.documentFence = mosesBacklogDocumentFence(evidence);
    if (bucket.name !== BUCKET) invalid();
    this.processed = 'processed-sermons/' + evidence.sermonId;
    this.final = 'intro-outro-sermons/' + evidence.sermonId;
    for (const kind of ['intro', 'outro'] as const) {
      const pin = evidence.bumperGenerations[kind];
      generation(pin.generation);
      const url = new URL(evidence.payload[kind === 'intro' ? 'introUrl' : 'outroUrl'] ?? '');
      const stem = '/v0/b/' + BUCKET + '/o/';
      const [directory, name, extra] = pin.path.split('/');
      if (
        url.origin !== 'https://firebasestorage.googleapis.com' ||
        url.username ||
        url.password ||
        url.hash ||
        !url.pathname.startsWith(stem) ||
        decodeURIComponent(url.pathname.slice(stem.length)) !== pin.path ||
        directory !== kind + 's' ||
        !name ||
        extra !== undefined ||
        /[%\\\x00-\x1f\x7f]/u.test(name) ||
        !name.endsWith('_' + kind + '.mp3')
      )
        invalid();
    }
  }

  async verifyWitness(nonce: string, witness: { generation: string; sha256: string }) {
    const path = '_ops/moses-backlog-drain/' + this.evidence.sermonId + '/' + nonce + '.json';
    const version = this.bucket.file(path, { generation: generation(witness.generation) });
    const [metadata] = await version.getMetadata();
    const bytes = Number(metadata.size);
    if (
      metadata.bucket !== BUCKET ||
      metadata.name !== path ||
      generation(metadata.generation) !== witness.generation ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > 65536 ||
      metadata.contentEncoding
    )
      invalid();
    const [raw] = await version.download({ decompress: false });
    if (raw.length !== bytes || createHash('sha256').update(raw).digest('hex') !== witness.sha256) invalid();
  }

  async checkBeforeAcquisition() {
    const exists = await Promise.all([
      this.bucket.file(this.processed).exists(),
      this.bucket.file(this.final).exists(),
    ]);
    if (exists.some(([present]) => present)) invalid();
    for (const pin of Object.values(this.evidence.bumperGenerations)) {
      const [metadata] = await this.bucket.file(pin.path).getMetadata();
      if (
        metadata.bucket !== BUCKET ||
        metadata.name !== pin.path ||
        generation(metadata.generation) !== pin.generation
      )
        invalid();
    }
  }

  uploadOptions(path: string, options: CreateWriteStreamOptions): CreateWriteStreamOptions {
    if ((path !== this.processed && path !== this.final) || this.writes.has(path)) return invalid();
    return {
      ...options,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        ...options.metadata,
        metadata: { ...options.metadata?.metadata, urmBacklogTask: this.taskId },
      },
    };
  }

  private output(path: string, metadata: FileMetadata): BacklogOutput {
    if (
      metadata.bucket !== BUCKET ||
      metadata.name !== path ||
      metadata.metadata?.urmBacklogTask !== this.taskId ||
      metadata.contentType !== 'audio/mpeg' ||
      !/^[1-9][0-9]*$/u.test(String(metadata.size))
    )
      return invalid();
    return { path, generation: generation(metadata.generation), bytes: String(metadata.size) };
  }

  recordUpload(file: File) {
    if (
      file.bucket.name !== BUCKET ||
      (file.name !== this.processed && file.name !== this.final) ||
      this.writes.has(file.name)
    )
      invalid();
    // createWriteStream populates this particular File's metadata with the native upload response.
    this.writes.set(file.name, this.output(file.name, file.metadata));
  }

  async downloadInputs(processedDestination: string, tempFiles: Set<string>) {
    const processed = this.writes.get(this.processed);
    if (!processed) return invalid();
    const inputs = {
      INTRO: createTempFile(this.taskId + '-intro', tempFiles),
      OUTRO: createTempFile(this.taskId + '-outro', tempFiles),
    };
    const { intro, outro } = this.evidence.bumperGenerations;
    await Promise.all([
      this.bucket
        .file(processed.path, { generation: processed.generation })
        .download({ destination: processedDestination }),
      this.bucket.file(intro.path, { generation: intro.generation }).download({ destination: inputs.INTRO }),
      this.bucket.file(outro.path, { generation: outro.generation }).download({ destination: inputs.OUTRO }),
    ]);
    return inputs;
  }

  async verifyCurrent(expected?: BacklogOutputs): Promise<BacklogOutputs> {
    const read = async (path: string, proof: BacklogOutput | undefined) => {
      if (!proof || proof.path !== path) return invalid();
      const [metadata] = await this.bucket.file(path).getMetadata();
      const native = this.output(path, metadata);
      if (!isDeepStrictEqual(native, proof)) return invalid();
      return native;
    };
    return {
      processed: await read(this.processed, expected?.processed ?? this.writes.get(this.processed)),
      final: await read(this.final, expected?.final ?? this.writes.get(this.final)),
    };
  }
}
