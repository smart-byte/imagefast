export type ImageFastErrorCode =
  /** Required browser API missing (`Worker`, `OffscreenCanvas`, `createImageBitmap`). */
  | 'unsupported'
  /** File needs a plugin that was not passed to `createImageFast`. */
  | 'no-decoder'
  /** The browser or a plugin could not decode the file. */
  | 'decode-failed'
  /** `terminate()` was called while the job was pending. */
  | 'terminated'
  /** The worker running the job died. */
  | 'worker-crashed'
  /** The job's `AbortSignal` fired (also `AbortSignal.timeout`). */
  | 'aborted';

/** What a failed operation rejects with; branch on `code`, not on the message. (Bad arguments reject with a `TypeError`/`RangeError` instead.) */
export class ImageFastError extends Error {
  override readonly name = 'ImageFastError';
  constructor(
    readonly code: ImageFastErrorCode,
    message: string,
  ) {
    super(message.startsWith('imagefast: ') ? message : `imagefast: ${message}`);
  }
}

/** Whatever an op throws, as an `ImageFastError`: an error from a decoder or the browser counts as 'decode-failed'. */
export function toImageFastError(e: unknown): ImageFastError {
  return e instanceof ImageFastError ? e : new ImageFastError('decode-failed', e instanceof Error ? e.message : String(e));
}
