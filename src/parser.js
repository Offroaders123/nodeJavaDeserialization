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

var assert = require("assert");
var Long = require("long");

/**
 * @typedef {string | ClassDesc | ObjectDesc} Handle
 */

/**
 * @typedef {{ name: string; serialVersionUID: string; flags: number; isEnum: boolean; fields: FieldDesc[]; annotations: string[]; super: ClassDesc; }} ClassDesc
 */

/**
 * @typedef {{ class: ClassDesc; extends: Record<string, ClassDesc>; }} ObjectDesc
 */

/**
 * @typedef {Handle[] & { class: ClassDesc; extends: Record<string, ClassDesc>; }} ArrayDesc
 */

/**
 * @typedef {{ type: string; name: string; className: string; }} FieldDesc
 */

/**
 * @typedef {(cls: ClassDesc, res: Record<string, Handle>, data: [Buffer, ...Buffer[]]) => Record<string, Handle>} ParseFunc
 */

var names = [
    "Null", "Reference", "ClassDesc", "Object", "String", "Array", "Class", "BlockData", "EndBlockData",
    "Reset", "BlockDataLong", "Exception", "LongString", "ProxyClassDesc", "Enum"
];

var endBlock = {};

/**
 * @param {Buffer} buf
 */
function Parser(buf) {
    /** @type {Buffer} */
    this.buf = buf;
    this.pos = 0;
    this.nextHandle = 0x7e0000;
    /**
     * @type {(Handle | null)[]}
     */
    this.handles = [];
    /** @type {[]} */
    this.contents = [];
    // @ts-expect-error
    this.magic();
    // @ts-expect-error
    this.version();
    while (this.pos < this.buf.length) {
        this.contents.push(this.content());
    }
}

/**
 * @param {number} len
 * @returns {number}
 */
Parser.prototype.step = function(len) {
    var pos = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
        /** @type {any} */
        var err = new Error("Premature end of input");
        err.buf = this.buf;
        err.pos = this.pos;
        throw err;
    }
    return pos;
}

/**
 * @param {number} len
 * @param {BufferEncoding} encoding
 * @returns {string}
 */
Parser.prototype.chunk = function(len, encoding) {
    var pos = this.step(len);
    return this.buf.toString(encoding, pos, this.pos);
}

/**
 * @returns {number}
 */
Parser.prototype.readUInt8 = function() {
    return this.buf.readUInt8(this.step(1));
}

/**
 * @returns {number}
 */
Parser.prototype.readInt8 = function() {
    return this.buf.readInt8(this.step(1));
}

/**
 * @returns {number}
 */
Parser.prototype.readUInt16 = function() {
    return this.buf.readUInt16BE(this.step(2));
}

/**
 * @returns {number}
 */
Parser.prototype.readInt16 = function() {
    return this.buf.readInt16BE(this.step(2));
}

/**
 * @returns {number}
 */
Parser.prototype.readUInt32 = function() {
    return this.buf.readUInt32BE(this.step(4));
}

/**
 * @returns {number}
 */
Parser.prototype.readInt32 = function() {
    return this.buf.readInt32BE(this.step(4));
}

/**
 * @param {number} len
 * @returns {string}
 */
Parser.prototype.readHex = function(len) {
    return this.chunk(len, "hex");
}

/**
 * @returns {string}
 */
Parser.prototype.utf = function() {
    return this.chunk(this.readUInt16(), "utf8");
}

/**
 * @returns {string}
 */
Parser.prototype.utfLong = function() {
    if (this.readUInt32() !== 0)
        throw new Error("Can't handle more than 2^32 bytes in a string");
    return this.chunk(this.readUInt32(), "utf8");
}

/**
 * @type {number | (() => void)}
 */
Parser.prototype.magic = function() {
    this.magic = this.readUInt16();
    if (this.magic !== 0xaced)
        throw Error("STREAM_MAGIC not found");
}

/**
 * @type {number | (() => void)}
 */
Parser.prototype.version = function() {
    this.version = this.readUInt16();
    if (this.version !== 5)
        throw Error("Only understand protocol version 5");
}

/**
 * @template {Handle} T
 * @param {string[]} [allowed]
 * @returns {T}
 */
Parser.prototype.content = function(allowed) {
    var tc = this.readUInt8() - 0x70;
    if (tc < 0 || tc > names.length)
        throw Error("Don't know about type 0x" + (tc + 0x70).toString(16));
    /** @type {string} */
    var name = /** @type {string} */ (names[tc]);
    if (allowed && allowed.indexOf(name) === -1)
        throw Error(name + " not allowed here");
    //// @ts-expect-error
    /** @type {() => T} */
    var handler = this["parse" + name];
    if (!handler)
        throw Error("Don't know how to handle " + name);
    ///** @type {unknown} */
    var elt = handler.call(this);
    return elt;
}

/**
 * @param {string[]} [allowed]
 * @returns {string[]}
 */
Parser.prototype.annotations = function(allowed) {
    /** @type {string[]} */
    var annotations = [];
    while (true) {
        /** @type {string} */
        var annotation = this.content(allowed);
        if (annotation === endBlock)
            break;
        annotations.push(annotation);
    }
    return annotations;
}

/**
 * @returns {ClassDesc}
 */
Parser.prototype.classDesc = function() {
    return this.content(["ClassDesc", "ProxyClassDesc", "Null", "Reference"]);
}

/**
 * @returns {ClassDesc}
 */
Parser.prototype.parseClassDesc = function() {
    /** @type {ClassDesc} */
    var res = {};
    res.name = this.utf();
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

/**
 * @returns {FieldDesc}
 */
Parser.prototype.fieldDesc = function() {
    /** @type {FieldDesc} */
    var res = {};
    res.type = String.fromCharCode(this.readUInt8());
    res.name = this.utf();
    if ("[L".indexOf(res.type) !== -1)
        res.className = this.content();
    return res;
}

/**
 * @returns {ClassDesc}
 */
Parser.prototype.parseClass = function() {
    return this.newHandle(this.classDesc());
}

/**
 * @returns {ObjectDesc}
 */
Parser.prototype.parseObject = function() {
    /** @type {ObjectDesc} */
    var res = Object.defineProperties(/** @type {ObjectDesc} */ ({}), {
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

/**
 * @param {ClassDesc} cls
 * @param {ObjectDesc} obj
 * @returns {void}
 */
Parser.prototype.recursiveClassData = function(cls, obj) {
    if (cls.super)
        this.recursiveClassData(cls.super, obj);
    var fields = obj.extends[cls.name] = this.classdata(cls, obj);
    for (var name in fields)
        obj[name] = fields[name];
}

/**
 * @param {ClassDesc} cls
 * @returns {Record<string, Handle>}
 */
Parser.prototype.classdata = function(cls) {
    var /** @type {Record<string, Handle>} */ res, /** @type {[Buffer, ...Buffer[]]} */ data;
    /** @type {ParseFunc} */
    var postproc = this[cls.name + "@" + cls.serialVersionUID];
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

/**
 * @returns {ArrayDesc}
 */
Parser.prototype.parseArray = function() {
    var classDesc = this.classDesc();
    /** @type {ArrayDesc} */
    var res = Object.defineProperties(/** @type {ArrayDesc} */ ([]), {
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

/**
 * @returns {Handle}
 */
Parser.prototype.parseEnum = function() {
    var clazz = this.classDesc();
    var deferredHandle = this.newDeferredHandle();
    var constant = this.content();
    /** @type {Handle} */
    var res = Object.defineProperties(/** @type {Handle} */ (new String(constant)), {
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

/**
 * @returns {Buffer}
 */
Parser.prototype.parseBlockData = function() {
    var len = this.readUInt8();
    var res = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return res;
}

/**
 * @returns {Buffer}
 */
Parser.prototype.parseBlockDataLong = function() {
    var len = this.readUInt32();
    var res = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return res;
}

/**
 * @returns {string}
 */
Parser.prototype.parseString = function() {
    return this.newHandle(this.utf());
}

/**
 * @returns {string}
 */
Parser.prototype.parseLongString = function() {
    return this.newHandle(this.utfLong());
}

/**
 * @template {Handle} T
 * @param {string} type
 * @returns {() => T}
 */
Parser.prototype.primHandler = function(type) {
    /** @type {() => T} */
    var handler = this["prim" + type];
    if (!handler)
        throw Error("Don't know how to read field of type '" + type + "'");
    return handler;
}

/**
 * @param {ClassDesc} cls
 * @returns {Record<string, Handle>}
 */
Parser.prototype.values = function(cls) {
    /** @type {Record<string, Handle>} */
    var vals = {};
    var fields = cls.fields;
    for (var i = 0; i < fields.length; ++i) {
        var field = fields[i];
        var handler = this.primHandler(field.type);
        vals[field.name] = handler.call(this);
    }
    return vals;
}

/**
 * @template {Handle} T
 * @param {T} obj
 * @returns {T}
 */
Parser.prototype.newHandle = function(obj) {
    this.handles[this.nextHandle++] = obj;
    return obj;
}

/**
 * @template {Handle} T
 * @returns {(obj: T) => void}
 */
Parser.prototype.newDeferredHandle = function() {
    var idx = this.nextHandle++;
    var handles = this.handles;
    handles[idx] = null;
    /**
     * @param {T} obj
     */
    return function(obj) {
        handles[idx] = obj;
    };
}

/**
 * @returns {Handle | null | undefined}
 */
Parser.prototype.parseReference = function() {
    return this.handles[this.readInt32()];
}

/**
 * @returns {null}
 */
Parser.prototype.parseNull = function() {
    return null;
}

/**
 * @returns {{}}
 */
Parser.prototype.parseEndBlockData = function() {
    return endBlock;
}

/**
 * @returns {number}
 */
Parser.prototype.primB = function() {
    return this.readInt8();
}

/**
 * @returns {string}
 */
Parser.prototype.primC = function() {
    return String.fromCharCode(this.readUInt16());
}

/**
 * @returns {number}
 */
Parser.prototype.primD = function() {
    return this.buf.readDoubleBE(this.step(8));
}

/**
 * @returns {number}
 */
Parser.prototype.primF = function() {
    return this.buf.readFloatBE(this.step(4));
}

/**
 * @returns {number}
 */
Parser.prototype.primI = function() {
    return this.readInt32();
}

/**
 * @returns {Long}
 */
Parser.prototype.primJ = function() {
    var high = this.readUInt32();
    var low = this.readUInt32();
    return Long.fromBits(low, high);
}

/**
 * @returns {number}
 */
Parser.prototype.primS = function() {
    return this.readInt16();
}

/**
 * @returns {boolean}
 */
Parser.prototype.primZ = function() {
    return !!this.readInt8();
}

/**
 * @returns {number}
 */
Parser.prototype.primL = function() {
    return this.content();
}

/**
 * @returns {number}
 */
Parser.prototype["prim["] = function() {
    return this.content();
}

/**
 * @param {string} className
 * @param {string} serialVersionUID
 * @param {ParseFunc} parser
 * @returns {void}
 */
Parser.register = function(className, serialVersionUID, parser) {
    assert.strictEqual(serialVersionUID.length, 16,
                       "serialVersionUID must be 16 hex digits");
    Parser.prototype[className + "@" + serialVersionUID] = parser;
}

module.exports = Parser;
