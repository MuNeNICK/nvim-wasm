// Tiny MessagePack encoder/decoder for the subset Neovim RPC uses.
// Supports: nil, booleans, positive/negative fixint, int8/16/32/64,
// strings, binary, arrays, maps.

export function encode(value) {
  const bytes = [];
  write(value, bytes);
  return new Uint8Array(bytes);
}

function write(val, out) {
  if (val === null || val === undefined) {
    out.push(0xc0);
    return;
  }
  if (typeof val === "boolean") {
    out.push(val ? 0xc3 : 0xc2);
    return;
  }
  if (typeof val === "number") {
    writeNumber(val, out);
    return;
  }
  if (typeof val === "string") {
    writeString(val, out);
    return;
  }
  if (typeof val === "bigint") {
    writeBigInt(val, out);
    return;
  }
  if (Array.isArray(val)) {
    writeArray(val, out);
    return;
  }
  if (val instanceof Uint8Array) {
    writeBinary(val, out);
    return;
  }
  if (typeof val === "object") {
    writeMap(val, out);
    return;
  }
  throw new Error("Unsupported type in msgpack encode");
}

function writeNumber(num, out) {
  if (!Number.isFinite(num)) throw new Error("Cannot encode non-finite number");
  if (Number.isInteger(num)) {
    if (num >= 0 && num <= 0x7f) {
      out.push(num);
      return;
    }
    if (num < 0 && num >= -32) {
      out.push(0xe0 | (num + 32));
      return;
    }
    if (num >= -0x80 && num <= 0x7f) {
      out.push(0xd0, (num + 0x100) & 0xff);
      return;
    }
    if (num >= -0x8000 && num <= 0x7fff) {
      out.push(0xd1, (num >> 8) & 0xff, num & 0xff);
      return;
    }
    if (num >= -0x80000000 && num <= 0x7fffffff) {
      out.push(
        0xd2,
        (num >> 24) & 0xff,
        (num >> 16) & 0xff,
        (num >> 8) & 0xff,
        num & 0xff
      );
      return;
    }
    writeBigInt(BigInt(num), out);
    return;
  }
  // Encode non-integers as float64
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, num);
  out.push(0xcb, ...new Uint8Array(buf));
}

function writeBigInt(bi, out) {
  if (bi >= 0n && bi <= 0xffffffffffffffffn) {
    out.push(0xcf, ...u64Bytes(bi));
  } else if (bi < 0n && bi >= -0x8000000000000000n) {
    out.push(0xd3, ...i64Bytes(bi));
  } else {
    throw new Error("BigInt out of range for msgpack");
  }
}

function writeString(str, out) {
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  if (len <= 31) {
    out.push(0xa0 | len, ...bytes);
  } else if (len <= 0xff) {
    out.push(0xd9, len, ...bytes);
  } else if (len <= 0xffff) {
    out.push(0xda, (len >> 8) & 0xff, len & 0xff, ...bytes);
  } else {
    out.push(0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...bytes);
  }
}

function writeBinary(bytes, out) {
  const len = bytes.length;
  if (len <= 0xff) {
    out.push(0xc4, len, ...bytes);
  } else if (len <= 0xffff) {
    out.push(0xc5, (len >> 8) & 0xff, len & 0xff, ...bytes);
  } else {
    out.push(0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...bytes);
  }
}

function writeArray(arr, out) {
  const len = arr.length;
  if (len <= 15) {
    out.push(0x90 | len);
  } else if (len <= 0xffff) {
    out.push(0xdc, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  for (const v of arr) write(v, out);
}

function writeMap(obj, out) {
  const entries = Object.entries(obj);
  const len = entries.length;
  if (len <= 15) {
    out.push(0x80 | len);
  } else if (len <= 0xffff) {
    out.push(0xde, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  for (const [k, v] of entries) {
    write(k, out);
    write(v, out);
  }
}

function u64Bytes(bi) {
  const arr = new Uint8Array(8);
  const view = new DataView(arr.buffer);
  view.setBigUint64(0, bi);
  return arr;
}

function i64Bytes(bi) {
  const arr = new Uint8Array(8);
  const view = new DataView(arr.buffer);
  view.setBigInt64(0, bi);
  return arr;
}

export class Decoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = new Uint8Array();
  }

  push(chunk) {
    this.buffer = concat(this.buffer, chunk);
    let offset = 0;
    while (offset < this.buffer.length) {
      try {
        const { value, nextOffset } = decodeValue(this.buffer, offset);
        offset = nextOffset;
        this.onMessage(value);
      } catch (err) {
        // Likely incomplete buffer; keep remaining bytes
        if (err && err.incomplete) break;
        throw err;
      }
    }
    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function needMore() {
  const err = new Error("incomplete msgpack buffer");
  err.incomplete = true;
  return err;
}

function decodeValue(buf, offset) {
  if (offset >= buf.length) throw needMore();
  const type = buf[offset];

  // Positive fixint
  if (type <= 0x7f) return { value: type, nextOffset: offset + 1 };
  // Fixmap
  if (type >= 0x80 && type <= 0x8f) return decodeMap(buf, offset, type & 0x0f, 1);
  // Fixarray
  if (type >= 0x90 && type <= 0x9f) return decodeArray(buf, offset, type & 0x0f, 1);
  // Fixstr
  if (type >= 0xa0 && type <= 0xbf) return decodeString(buf, offset, type & 0x1f, 1);
  // Negative fixint
  if (type >= 0xe0) return { value: type - 0x100, nextOffset: offset + 1 };

  switch (type) {
    case 0xc0: return { value: null, nextOffset: offset + 1 };
    case 0xc2: return { value: false, nextOffset: offset + 1 };
    case 0xc3: return { value: true, nextOffset: offset + 1 };
    case 0xc7: return decodeExt(buf, offset, readLen(buf, offset + 1, 1), 3);
    case 0xc8: return decodeExt(buf, offset, readLen(buf, offset + 1, 2), 4);
    case 0xc9: return decodeExt(buf, offset, readLen(buf, offset + 1, 4), 6);
    case 0xcc: return decodeUInt(buf, offset, 1, false);
    case 0xcd: return decodeUInt(buf, offset, 2, false);
    case 0xce: return decodeUInt(buf, offset, 4, false);
    case 0xcf: return decodeUInt(buf, offset, 8, true);
    case 0xd0: return decodeInt(buf, offset, 1);
    case 0xd1: return decodeInt(buf, offset, 2);
    case 0xd2: return decodeInt(buf, offset, 4);
    case 0xd3: return decodeInt(buf, offset, 8);
    case 0xd4: return decodeExt(buf, offset, 1, 2);
    case 0xd5: return decodeExt(buf, offset, 2, 2);
    case 0xd6: return decodeExt(buf, offset, 4, 2);
    case 0xd7: return decodeExt(buf, offset, 8, 2);
    case 0xd8: return decodeExt(buf, offset, 16, 2);
    case 0xd9: return decodeString(buf, offset, readLen(buf, offset + 1, 1), 2);
    case 0xda: return decodeString(buf, offset, readLen(buf, offset + 1, 2), 3);
    case 0xdb: return decodeString(buf, offset, readLen(buf, offset + 1, 4), 5);
    case 0xc4: return decodeBinary(buf, offset, readLen(buf, offset + 1, 1), 2);
    case 0xc5: return decodeBinary(buf, offset, readLen(buf, offset + 1, 2), 3);
    case 0xc6: return decodeBinary(buf, offset, readLen(buf, offset + 1, 4), 5);
    case 0xdc: return decodeArray(buf, offset, readLen(buf, offset + 1, 2), 3);
    case 0xdd: return decodeArray(buf, offset, readLen(buf, offset + 1, 4), 5);
    case 0xde: return decodeMap(buf, offset, readLen(buf, offset + 1, 2), 3);
    case 0xdf: return decodeMap(buf, offset, readLen(buf, offset + 1, 4), 5);
    default: throw new Error(`Unsupported msgpack type: 0x${type.toString(16)}`);
  }
}

function readLen(buf, offset, width) {
  if (offset + width > buf.length) throw needMore();
  let val = 0;
  for (let i = 0; i < width; i += 1) {
    val = (val << 8) | buf[offset + i];
  }
  return val >>> 0;
}

function decodeString(buf, offset, len, headBytes) {
  const start = offset + headBytes;
  const end = start + len;
  if (end > buf.length) throw needMore();
  const value = new TextDecoder().decode(buf.slice(start, end));
  return { value, nextOffset: end };
}

function decodeBinary(buf, offset, len, headBytes) {
  const start = offset + headBytes;
  const end = start + len;
  if (end > buf.length) throw needMore();
  return { value: buf.slice(start, end), nextOffset: end };
}

function decodeExt(buf, offset, len, headBytes) {
  const typeOffset = offset + headBytes - 1; // type byte is just before payload
  const start = offset + headBytes;
  const end = start + len;
  if (typeOffset >= buf.length || end > buf.length) throw needMore();
  const extType = buf[typeOffset];
  const data = buf.slice(start, end);
  // Return as a simple object; Neovim doesn't use ext currently, but tolerate it.
  return { value: { extType, data }, nextOffset: end };
}

function decodeArray(buf, offset, len, headBytes) {
  let next = offset + headBytes;
  const out = new Array(len);
  for (let i = 0; i < len; i += 1) {
    const res = decodeValue(buf, next);
    out[i] = res.value;
    next = res.nextOffset;
  }
  return { value: out, nextOffset: next };
}

function decodeMap(buf, offset, len, headBytes) {
  let next = offset + headBytes;
  const obj = {};
  for (let i = 0; i < len; i += 1) {
    const k = decodeValue(buf, next);
    const v = decodeValue(buf, k.nextOffset);
    obj[k.value] = v.value;
    next = v.nextOffset;
  }
  return { value: obj, nextOffset: next };
}

function decodeUInt(buf, offset, width, big) {
  const start = offset + 1;
  const end = start + width;
  if (end > buf.length) throw needMore();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let value;
  if (width === 1) value = view.getUint8(offset + 1);
  else if (width === 2) value = view.getUint16(offset + 1);
  else if (width === 4) value = view.getUint32(offset + 1);
  else value = view.getBigUint64(offset + 1);
  return { value: big ? Number(value) : value, nextOffset: end };
}

function decodeInt(buf, offset, width) {
  const start = offset + 1;
  const end = start + width;
  if (end > buf.length) throw needMore();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let value;
  if (width === 1) value = view.getInt8(offset + 1);
  else if (width === 2) value = view.getInt16(offset + 1);
  else if (width === 4) value = view.getInt32(offset + 1);
  else value = Number(view.getBigInt64(offset + 1));
  return { value, nextOffset: end };
}
