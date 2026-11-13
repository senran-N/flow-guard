// Both NDJSON (MCP stdio) and the older Content-Length framing are accepted.
// Keep byte boundaries until a complete message is available, including UTF-8.
export function createRpcInput({ onMessage, onParseError, onFraming, maxBytes = 8 * 1024 * 1024 }) {
  let buffer = Buffer.alloc(0);
  const prefix = 'content-length:';
  const parse = (bytes) => {
    let message;
    try { message = JSON.parse(bytes.toString('utf8')); }
    catch { onParseError(); return; }
    onMessage(message);
  };
  return {
    write(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const preview = buffer.subarray(0, prefix.length).toString('ascii').toLowerCase();
        if (buffer.length < prefix.length && prefix.startsWith(preview)) return;
        if (preview === prefix) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) {
            if (buffer.length > 8192) throw new Error('RPC header exceeds 8192 bytes');
            return;
          }
          if (headerEnd > 8192) throw new Error('RPC header exceeds 8192 bytes');
          const header = buffer.subarray(0, headerEnd).toString('ascii');
          const lengths = header.split('\r\n').filter((line) => /^content-length:/i.test(line));
          const value = lengths.length === 1 && lengths[0].match(/^content-length:\s*(\d+)\s*$/i);
          const length = value && Number(value[1]);
          if (!value || !Number.isSafeInteger(length) || length > maxBytes) throw new Error('Invalid or oversized RPC Content-Length');
          const end = headerEnd + 4 + length;
          if (buffer.length < end) return;
          onFraming(true);
          parse(buffer.subarray(headerEnd + 4, end));
          buffer = buffer.subarray(end);
        } else {
          const newline = buffer.indexOf('\n');
          if ((newline < 0 ? buffer.length : newline) > maxBytes) throw new Error('RPC message exceeds size limit');
          if (newline < 0) return;
          const bytes = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (bytes.toString('utf8').trim()) {
            onFraming(false);
            parse(bytes);
          }
        }
      }
    },
    end() {
      if (buffer.length && buffer.toString('utf8').trim()) onParseError();
      buffer = Buffer.alloc(0);
    }
  };
}
