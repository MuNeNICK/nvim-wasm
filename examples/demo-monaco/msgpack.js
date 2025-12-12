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
  if (isExt(val)) {
    writeExt(val, out);
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
    // Ext payloads are used for Buffer/Window/Tabpage handles.
    if (isExt(val)) {
      writeExt(val, out);
      return;
    }
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
      out.push(0xd2, (num >> 24) & 0xff, (num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff);
      return;
    }
    // Use int64
    writeBigInt(BigInt(num), out);
    return;
  }
  // float64
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, num);
  out.push(0xcb, ...new Uint8Array(buf));
}

function writeBigInt(bi, out) {
  // Encode as signed int64
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigInt64(0, BigInt(bi));
  out.push(0xd3, ...new Uint8Array(buf));
}

function writeString(str, out) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const len = bytes.length;
  if (len <= 0x1f) {
    out.push(0xa0 | len);
  } else if (len <= 0xff) {
    out.push(0xd9, len);
  } else if (len <= 0xffff) {
    out.push(0xda, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  out.push(...bytes);
}

function writeBinary(bytes, out) {
  const len = bytes.length;
  if (len <= 0xff) {
    out.push(0xc4, len);
  } else if (len <= 0xffff) {
    out.push(0xc5, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  out.push(...bytes);
}

function writeArray(arr, out) {
  const len = arr.length;
  if (len <= 0x0f) {
    out.push(0x90 | len);
  } else if (len <= 0xffff) {
    out.push(0xdc, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  for (const item of arr) {
    write(item, out);
  }
}

function writeMap(map, out) {
  const keys = Object.keys(map);
  const len = keys.length;
  if (len <= 0x0f) {
    out.push(0x80 | len);
  } else if (len <= 0xffff) {
    out.push(0xde, (len >> 8) & 0xff, len & 0xff);
  } else {
    out.push(0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  for (const key of keys) {
    write(key, out);
    write(map[key], out);
  }
}

function writeExt(ext, out) {
  const len = ext.data.length;
  if (len === 1) {
    out.push(0xd4, ext.type);
  } else if (len === 2) {
    out.push(0xd5, ext.type);
  } else if (len === 4) {
    out.push(0xd6, ext.type);
  } else if (len === 8) {
    out.push(0xd7, ext.type);
  } else if (len === 16) {
    out.push(0xd8, ext.type);
  } else {
    out.push(0xc7, len, ext.type);
  }
  for (let i = 0; i < len; i += 1) {
    out.push(ext.data[i]);
  }
}

function isExt(val) {
  return Boolean(
    val
    && typeof val === "object"
    && typeof val.type === "number"
    && val.data instanceof Uint8Array
  );
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
    case 0xd4: return decodeFixExt(buf, offset, 1);
    case 0xd5: return decodeFixExt(buf, offset, 2);
    case 0xd6: return decodeFixExt(buf, offset, 4);
    case 0xd7: return decodeFixExt(buf, offset, 8);
    case 0xd8: return decodeFixExt(buf, offset, 16);
    case 0xd9: return decodeString(buf, offset, buf[offset + 1], 2);
    case 0xda: return decodeString(buf, offset, readU16(buf, offset + 1), 3);
    case 0xdb: return decodeString(buf, offset, readU32(buf, offset + 1), 5);
    case 0xdc: return decodeArray(buf, offset, readU16(buf, offset + 1), 3);
    case 0xdd: return decodeArray(buf, offset, readU32(buf, offset + 1), 5);
    case 0xde: return decodeMap(buf, offset, readU16(buf, offset + 1), 3);
    case 0xdf: return decodeMap(buf, offset, readU32(buf, offset + 1), 5);
    case 0xc4: return decodeBin(buf, offset, buf[offset + 1], 2);
    case 0xc5: return decodeBin(buf, offset, readU16(buf, offset + 1), 3);
    case 0xc6: return decodeBin(buf, offset, readU32(buf, offset + 1), 5);
    case 0xcb: return decodeFloat(buf, offset, 8);
    default:
      throw new Error(`Unsupported msgpack type: 0x${type.toString(16)}`);
  }
}

function decodeBin(buf, offset, len, header) {
  const start = offset + header;
  const end = start + len;
  if (end > buf.length) throw needMore();
  return { value: buf.slice(start, end), nextOffset: end };
}

function decodeString(buf, offset, len, header) {
  const start = offset + header;
  const end = start + len;
  if (end > buf.length) throw needMore();
  const value = new TextDecoder().decode(buf.slice(start, end));
  return { value, nextOffset: end };
}

function decodeArray(buf, offset, count, header) {
  let off = offset + header;
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const { value, nextOffset } = decodeValue(buf, off);
    items.push(value);
    off = nextOffset;
  }
  return { value: items, nextOffset: off };
}

function decodeMap(buf, offset, count, header) {
  let off = offset + header;
  const obj = {};
  for (let i = 0; i < count; i += 1) {
    const key = decodeValue(buf, off);
    const val = decodeValue(buf, key.nextOffset);
    obj[key.value] = val.value;
    off = val.nextOffset;
  }
  return { value: obj, nextOffset: off };
}

function decodeFixExt(buf, offset, len) {
  // format: type byte + type id + data
  const type = buf[offset];
  const typeId = buf[offset + 1];
  const start = offset + 2;
  const end = start + len;
  if (end > buf.length) throw needMore();
  const data = buf.slice(start, end);
  const value = { type: typeId, data };
  return { value, nextOffset: end };
}

function decodeExt(buf, offset, len, header) {
  const typeId = buf[offset + header - 1];
  const start = offset + header;
  const end = start + len;
  if (end > buf.length) throw needMore();
  const data = buf.slice(start, end);
  const value = { type: typeId, data };
  return { value, nextOffset: end };
}

function decodeUInt(buf, offset, size, bigint) {
  const start = offset + 1;
  const end = start + size;
  if (end > buf.length) throw needMore();
  const view = new DataView(buf.slice(start, end).buffer);
  let value;
  if (size === 1) value = view.getUint8(0);
  else if (size === 2) value = view.getUint16(0);
  else if (size === 4) value = view.getUint32(0);
  else value = view.getBigUint64(0);
  return { value: bigint ? value : Number(value), nextOffset: end };
}

function decodeInt(buf, offset, size) {
  const start = offset + 1;
  const end = start + size;
  if (end > buf.length) throw needMore();
  const view = new DataView(buf.slice(start, end).buffer);
  let value;
  if (size === 1) value = view.getInt8(0);
  else if (size === 2) value = view.getInt16(0);
  else if (size === 4) value = view.getInt32(0);
  else value = view.getBigInt64(0);
  return { value: Number(value), nextOffset: end };
}

function decodeFloat(buf, offset, size) {
  const start = offset + 1;
  const end = start + size;
  if (end > buf.length) throw needMore();
  const view = new DataView(buf.slice(start, end).buffer);
  const value = size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  return { value, nextOffset: end };
}

function readLen(buf, offset, size) {
  const start = offset;
  const end = start + size;
  if (end > buf.length) throw needMore();
  if (size === 1) return buf[start];
  if (size === 2) return readU16(buf, start);
  return readU32(buf, start);
}

function readU16(buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1];
}

function readU32(buf, offset) {
  return (buf[offset] * 0x1000000) + ((buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]);
}
