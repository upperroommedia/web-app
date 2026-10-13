import { ExtendedSendMailOptions } from '../types';

const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1024;
const MAX_PRIVATE_ENVELOPE_BYTES = 512 * 1024;
/** Never allow provider libraries to fetch a URL or read a worker-mounted secret.
 * Snapshot external attachments into bounded inline content before queue admission. */
export function secureMailOptions(input: ExtendedSendMailOptions, forcedMessageId?: string): ExtendedSendMailOptions {
  const options: ExtendedSendMailOptions = { ...input, disableFileAccess: true, disableUrlAccess: true };
  let totalBytes = 0;
  if (options.attachments)
    options.attachments = options.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== 'object' || attachment.path || attachment.href)
        throw new Error('MAIL_EXTERNAL_ATTACHMENT_NOT_SNAPSHOTTED');
      const safe = { ...attachment };
      const content = safe.content;
      if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
        const bytes = Buffer.from(content);
        totalBytes += bytes.length;
        safe.content = bytes.toString('base64');
        safe.encoding = 'base64';
      } else if (typeof content === 'string') {
        totalBytes +=
          safe.encoding === 'base64'
            ? Buffer.byteLength(content, 'base64')
            : Buffer.byteLength(content, (safe.encoding as BufferEncoding) || 'utf8');
      } else if (content !== undefined && content !== null) {
        // Plain objects can instruct Nodemailer to open a file/URL just like path/href.
        throw new Error('MAIL_ATTACHMENT_CONTENT_INVALID');
      }
      if (safe.raw !== undefined && typeof safe.raw !== 'string') throw new Error('MAIL_ATTACHMENT_CONTENT_INVALID');
      if (typeof safe.raw === 'string') totalBytes += Buffer.byteLength(safe.raw);
      if (totalBytes > MAX_INLINE_ATTACHMENT_BYTES) throw new Error('MAIL_ATTACHMENTS_TOO_LARGE');
      return safe;
    });
  if (forcedMessageId) {
    options.messageId = forcedMessageId;
    if (Array.isArray(options.headers))
      options.headers = options.headers.filter((header) => header.key?.toLowerCase() !== 'message-id');
    else if (options.headers && typeof options.headers === 'object')
      options.headers = Object.fromEntries(
        Object.entries(options.headers).filter(([key]) => key.toLowerCase() !== 'message-id')
      );
  }
  if (Buffer.byteLength(JSON.stringify(options)) > MAX_PRIVATE_ENVELOPE_BYTES)
    throw new Error('MAIL_ENVELOPE_TOO_LARGE');
  return options;
}
