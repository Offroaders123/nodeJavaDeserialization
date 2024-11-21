/*
 * Copyright (c) 2015,2018 Martin von Gagern
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// See http://docs.oracle.com/javase/7/docs/platform/serialization/spec/protocol.html for reference

"use strict";

import assert = require("assert");
import Long = require("long");

export type Handle = string | ClassDesc | ObjectDesc;

export type ClassDesc = { name: names; serialVersionUID: string; flags: number; isEnum: boolean; fields: FieldDesc[]; annotations: string[]; super: ClassDesc; };

export type ObjectDesc = { class: ClassDesc; extends: Record<names, ClassDesc>; };

export type ArrayDesc = Handle[] & { class: ClassDesc; extends: Record<names, ClassDesc>; };

export type FieldDesc = { type: string; name: string; className: string; };

export type ParseFunc = (cls: ClassDesc, res: Record<string, Handle>, data: [Buffer, ...Buffer[]]) => Record<string, Handle>;

export type names = (typeof names)[number];

var names = [
    "Null", "Reference", "ClassDesc", "Object", "String", "Array", "Class", "BlockData", "EndBlockData",
    "Reset", "BlockDataLong", "Exception", "LongString", "ProxyClassDesc", "Enum"
] as const;

var endBlock = {};

export type ParserMethods = {
    [K in `${names}@${string}`]: ParseFunc;
};

class Parser implements ParserMethods {
buf: Buffer;
pos: number;
nextHandle: number;
handles: (Handle | null)[];
contents: Handle[];

constructor(buf: Buffer) {
    this.buf = buf;
    this.pos = 0;
    this.nextHandle = 0x7e0000;
    this.handles = [];
    this.contents = [];
    // @ts-expect-error
    this.magic();
    // @ts-expect-error
    this.version();
    while (this.pos < this.buf.length) {
        this.contents.push(this.content());
    }
}

step(len: number): number {
    var pos = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
        var err: any = new Error("Premature end of input");
        err.buf = this.buf;
        err.pos = this.pos;
        throw err;
    }
    return pos;
}

chunk(len: number, encoding: BufferEncoding): string {
    var pos = this.step(len);
    return this.buf.toString(encoding, pos, this.pos);
}

readUInt8(): number {
    return this.buf.readUInt8(this.step(1));
}

readInt8(): number {
    return this.buf.readInt8(this.step(1));
}

readUInt16(): number {
    return this.buf.readUInt16BE(this.step(2));
}

readInt16(): number {
    return this.buf.readInt16BE(this.step(2));
}

readUInt32(): number {
    return this.buf.readUInt32BE(this.step(4));
}

readInt32(): number {
    return this.buf.readInt32BE(this.step(4));
}

readHex(len: number): string {
    return this.chunk(len, "hex");
}

utf(): string {
    return this.chunk(this.readUInt16(), "utf8");
}

utfLong(): string {
    if (this.readUInt32() !== 0)
        throw new Error("Can't handle more than 2^32 bytes in a string");
    return this.chunk(this.readUInt32(), "utf8");
}

magic: number | (() => void) = () => {
    this.magic = this.readUInt16();
    if (this.magic !== 0xaced)
        throw Error("STREAM_MAGIC not found");
}

version: number | (() => void) = () => {
    this.version = this.readUInt16();
    if (this.version !== 5)
        throw Error("Only understand protocol version 5");
}

content<T extends Handle>(allowed?: string[]): T {
    var tc = this.readUInt8() - 0x70;
    if (tc < 0 || tc > names.length)
        throw Error("Don't know about type 0x" + (tc + 0x70).toString(16));
    var name: string = names[tc]!;
    if (allowed && allowed.indexOf(name) === -1)
        throw Error(name + " not allowed here");
    //// @ts-expect-error
    var handler: () => T = this["parse" + name];
    if (!handler)
        throw Error("Don't know how to handle " + name);
    var elt: T = handler.call(this);
    return elt;
}

annotations(allowed?: string[]): string[] {
    var annotations: string[] = [];
    while (true) {
        var annotation: string = this.content(allowed);
        if (annotation === endBlock)
            break;
        annotations.push(annotation);
    }
    return annotations;
}

classDesc(): ClassDesc {
    return this.content(["ClassDesc", "ProxyClassDesc", "Null", "Reference"]);
}

parseClassDesc(): ClassDesc {
    var res = {} as ClassDesc;
    res.name = this.utf() as names;
    res.serialVersionUID = this.readHex(8);
    this.newHandle(res);
    res.flags = this.readUInt8();
    res.isEnum = !!(res.flags & 0x10);
    var count = this.readUInt16();
    res.fields = [];
    for (var i = 0; i < count; ++i)
        res.fields.push(this.fieldDesc());
    res.annotations = this.annotations();
    res.super = this.classDesc();
    return res;
}

fieldDesc(): FieldDesc {
    var res = {} as FieldDesc;
    res.type = String.fromCharCode(this.readUInt8());
    res.name = this.utf();
    if ("[L".indexOf(res.type) !== -1)
        res.className = this.content();
    return res;
}

parseClass(): ClassDesc {
    return this.newHandle(this.classDesc());
}

parseObject(): ObjectDesc {
    var res: ObjectDesc = Object.defineProperties({} as ObjectDesc, {
        "class": {
            configurable: true,
            value: this.classDesc()
        },
        "extends": {
            configurable: true,
            value: {}
        }
    });
    this.newHandle(res);
    this.recursiveClassData(res.class, res);
    return res;
}

recursiveClassData(cls: ClassDesc, obj: ObjectDesc): void {
    if (cls.super)
        this.recursiveClassData(cls.super, obj);
    var fields = obj.extends[cls.name] = this.classdata(cls, obj);
    for (var name in fields)
        obj[name] = fields[name];
}

classdata(cls: ClassDesc): Record<string, Handle> {
    var res: Record<string, Handle>, data: [Buffer, ...Buffer[]];
    var postproc: ParseFunc = this[`${cls.name}@${cls.serialVersionUID}`];
    switch (cls.flags & 0x0f) {
    case 0x02: // SC_SERIALIZABLE without SC_WRITE_METHOD
        return this.values(cls);
    case 0x03: // SC_SERIALIZABLE with SC_WRITE_METHOD
        res = this.values(cls);
        data = res["@"] = this.annotations();
        if (postproc)
            res = postproc.call(this, cls, res, data);
        return res;
    case 0x04: // SC_EXTERNALIZABLE without SC_BLOCKDATA
        throw Error("Can't parse version 1 external content");
    case 0x0c: // SC_EXTERNALIZABLE with SC_BLOCKDATA
        return {"@": this.annotations()};
    default:
        throw Error("Don't know how to deserialize class with flags 0x" + cls.flags.toString(16));
    }
}

parseArray(): ArrayDesc {
    var classDesc = this.classDesc();
    var res: ArrayDesc = Object.defineProperties([] as ArrayDesc, {
        "class": {
            configurable: true,
            value: classDesc
        },
        "extends": {
            configurable: true,
            value: {}
        }
    });
    this.newHandle(res);
    var len = this.readInt32();
    var handler = this.primHandler(classDesc.name.charAt(1));
    res.length = len;
    for (var i = 0; i < len; ++i)
        res[i] = handler.call(this);
    return res;
}

parseEnum(): Handle {
    var clazz = this.classDesc();
    var deferredHandle = this.newDeferredHandle();
    var constant = this.content();
    var res: Handle = Object.defineProperties(new String(constant) as Handle, {
        "class": {
            configurable: true,
            value: clazz
        },
        "extends": {
            configurable: true,
            value: {}
        }
    });
    deferredHandle(res);
    return res;
}

parseBlockData(): Buffer {
    var len = this.readUInt8();
    var res = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return res;
}

parseBlockDataLong(): Buffer {
    var len = this.readUInt32();
    var res = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return res;
}

parseString(): string {
    return this.newHandle(this.utf());
}

parseLongString(): string {
    return this.newHandle(this.utfLong());
}

primHandler<T extends Handle>(type: string): () => T {
    var handler: () => T = this["prim" + type];
    if (!handler)
        throw Error("Don't know how to read field of type '" + type + "'");
    return handler;
}

values(cls: ClassDesc): Record<string, Handle> {
    var vals: Record<string, Handle> = {};
    var fields = cls.fields;
    for (var i = 0; i < fields.length; ++i) {
        var field = fields[i];
        var handler = this.primHandler(field.type);
        vals[field.name] = handler.call(this);
    }
    return vals;
}

newHandle<T extends Handle>(obj: T): T {
    this.handles[this.nextHandle++] = obj;
    return obj;
}

newDeferredHandle<T extends Handle>(): (obj: T) => void {
    var idx = this.nextHandle++;
    var handles = this.handles;
    handles[idx] = null;
    return function(obj: T) {
        handles[idx] = obj;
    };
}

parseReference(): Handle | null | undefined {
    return this.handles[this.readInt32()];
}

parseNull(): null {
    return null;
}

parseEndBlockData(): {} {
    return endBlock;
}

primB(): number {
    return this.readInt8();
}

primC(): string {
    return String.fromCharCode(this.readUInt16());
}

primD(): number {
    return this.buf.readDoubleBE(this.step(8));
}

primF(): number {
    return this.buf.readFloatBE(this.step(4));
}

primI(): number {
    return this.readInt32();
}

primJ(): Long {
    var high = this.readUInt32();
    var low = this.readUInt32();
    return Long.fromBits(low, high);
}

primS(): number {
    return this.readInt16();
}

primZ(): boolean {
    return !!this.readInt8();
}

primL(): number {
    return this.content();
}

["prim["](): number {
    return this.content();
}

static register(className: names, serialVersionUID: string, parser: ParseFunc): void {
    assert.strictEqual(serialVersionUID.length, 16,
                       "serialVersionUID must be 16 hex digits");
    Parser.prototype[className + "@" + serialVersionUID] = parser;
}
}

export default Parser;
