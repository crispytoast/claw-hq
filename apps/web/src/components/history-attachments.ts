/**
 * Extract `[📎 filename](/uploads/<id>)` references from chat history so the
 * composer can offer a "re-attach from history" picker. Pure function, no
 * React deps — exported so the smoke test can drive it directly.
 *
 * Dedupes by uploadId. The first occurrence wins (i.e. the earliest filename
 * a user gave it).
 */
export interface HistoryAttachment {
  uploadId: string;
  filename: string;
  url: string;
}

const ATTACH_RX = /\[📎\s*([^\]]+)\]\((\/uploads\/([A-Za-z0-9._-]+))\)/g;

export function extractHistoryAttachments(
  texts: Iterable<string>,
): HistoryAttachment[] {
  const seen = new Set<string>();
  const out: HistoryAttachment[] = [];
  for (const text of texts) {
    if (!text) continue;
    // matchAll consumes the iterator once; rebuild a fresh regex per call by
    // resetting lastIndex. (The g-flag regex above is reused safely because
    // matchAll creates its own iterator.)
    for (const m of text.matchAll(ATTACH_RX)) {
      const filename = m[1]?.trim();
      const url = m[2];
      const uploadId = m[3];
      if (!filename || !url || !uploadId) continue;
      if (seen.has(uploadId)) continue;
      seen.add(uploadId);
      out.push({ uploadId, filename, url });
    }
  }
  return out;
}
