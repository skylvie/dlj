import { createCipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { PkgEntry } from "./catalog.ts";

const PKG_HEADER_SIZE = 192; // 0xC0
const PKG_HEADER_EXT_SIZE = 64; // 0x40
const AES_BLOCK = 16;
const CHUNK = 64 * 1024;

const PKG_PSP_KEY = Buffer.from("07f2c68290b50d2c33818d709b60e62b", "hex");
const PKG_VITA_2 = Buffer.from("e31a70c9ce1dd72bf3c0622963f2eccb", "hex");
const PKG_VITA_3 = Buffer.from("423aca3a2bd5649f9686abad6fd8801f", "hex");
const PKG_VITA_4 = Buffer.from("af07fd59652527baf13389668b17d9ea", "hex");

const CONTENT_TYPE_PSX_GAME = 6;
const CONTENT_TYPE_PSP_GAME = 7;
const CONTENT_TYPE_PSP_GAME_ALT = 14;
const CONTENT_TYPE_PSP_MINI = 15;
const CONTENT_TYPE_PSP_NEOGEO = 16;
const CONTENT_TYPE_PSV_GAME = 21;
const CONTENT_TYPE_PSV_DLC = 22;
const CONTENT_TYPE_PSM_GAME = 24;
const CONTENT_TYPE_PSM_GAME_ALT = 29;

// pkgj/src/zrif.cpp
const ZRIF_DICT = Buffer.from(
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003030303039000000000000000000000030303030363030303037303030303800303030303330303030343030303035305f30302d414444434f4e5430303030322d5043534730303030303030303030312d504353453030302d504353463030302d504353433030302d504353443030302d504353413030302d504353423030300001000100010002efcdab8967452301",
    "hex",
);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
        let c = i;

        for (let j = 0; j < 8; j++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }

        t[i] = c;
    }

    return t;
})();

function crc32(prev: number, data: Buffer): number {
    let c = prev ^ 0xffffffff;

    for (let i = 0; i < data.length; i++) {
        c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    }

    return (c ^ 0xffffffff) >>> 0;
}

function aes128Encrypt(key: Buffer, block: Buffer): Buffer {
    const c = createCipheriv("aes-128-ecb", key, null);
    c.setAutoPadding(false);

    return Buffer.concat([c.update(block), c.final()]);
}

function ctrAdd(counter: Buffer, n: bigint): void {
    let carry = n;

    for (let i = AES_BLOCK - 1; carry > 0n && i >= 0; i--) {
        carry += BigInt(counter[i]!);
        counter[i] = Number(carry & 0xffn);
        carry >>= 8n;
    }
}

function aes128Ctr(
    key: Buffer,
    iv: Buffer,
    offset: bigint,
    data: Buffer,
): Buffer {
    if (data.length === 0) return data;
    const blockNum = offset / BigInt(AES_BLOCK);
    const prefix = Number(offset % BigInt(AES_BLOCK));

    const counter = Buffer.from(iv);
    ctrAdd(counter, blockNum);

    const cipher = createCipheriv("aes-128-ctr", key, counter);
    if (prefix > 0) cipher.update(Buffer.alloc(prefix));
    return cipher.update(data);
}

export function decodeZrif(zrif: string): Buffer | null {
    if (!zrif || zrif === "MISSING" || zrif === "ZRIF") return null;

    try {
        const raw = Buffer.from(zrif, "base64");
        const hasDict = (raw[1]! & 0x20) !== 0;
        const rif = inflateSync(raw, hasDict ? { dictionary: ZRIF_DICT } : {});

        if (rif.length !== 512 && rif.length !== 1024) return null;
        const out = Buffer.alloc(1024);
        rif.copy(out, 0, 0, rif.length);

        return out;
    } catch {
        return null;
    }
}

interface CdEntry {
    nameBuf: Buffer;
    crc: number;
    size: number;
    localOffset: number;
}

class ZipWriter {
    private fh: FileHandle;
    private pos = 0;
    private cd: CdEntry[] = [];

    constructor(fh: FileHandle) {
        this.fh = fh;
    }

    async addFile(name: string, chunks: AsyncGenerator<Buffer>): Promise<void> {
        const nameBuf = Buffer.from(name, "utf8");
        const localOff = this.pos;

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // compression: STORED
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra field length
        nameBuf.copy(local, 30);
        await this.fh.write(local, 0, local.length, this.pos);
        this.pos += local.length;

        let runCrc = 0;
        let size = 0;

        for await (const chunk of chunks) {
            if (chunk.length === 0) continue;
            runCrc = crc32(runCrc, chunk);
            await this.fh.write(chunk, 0, chunk.length, this.pos);
            this.pos += chunk.length;
            size += chunk.length;
        }

        const patch = Buffer.alloc(12);
        patch.writeUInt32LE(runCrc, 0);
        patch.writeUInt32LE(size, 4);
        patch.writeUInt32LE(size, 8);
        await this.fh.write(patch, 0, 12, localOff + 14);

        this.cd.push({ nameBuf, crc: runCrc, size, localOffset: localOff });
    }

    async finalize(): Promise<void> {
        const cdOffset = this.pos;
        let cdSize = 0;

        for (const e of this.cd) {
            const cd = Buffer.alloc(46 + e.nameBuf.length);
            cd.writeUInt32LE(0x02014b50, 0);
            cd.writeUInt16LE(20, 4); // version made by
            cd.writeUInt16LE(20, 6); // version needed
            cd.writeUInt16LE(0, 8); // flags
            cd.writeUInt16LE(0, 10); // STORED
            cd.writeUInt16LE(0, 12); // mod time
            cd.writeUInt16LE(0, 14); // mod date
            cd.writeUInt32LE(e.crc, 16);
            cd.writeUInt32LE(e.size, 20);
            cd.writeUInt32LE(e.size, 24);
            cd.writeUInt16LE(e.nameBuf.length, 28);
            cd.writeUInt16LE(0, 30); // extra
            cd.writeUInt16LE(0, 32); // comment
            cd.writeUInt16LE(0, 34); // disk start
            cd.writeUInt16LE(0, 36); // internal attr
            cd.writeUInt32LE(0, 38); // external attr
            cd.writeUInt32LE(e.localOffset, 42);
            e.nameBuf.copy(cd, 46);
            await this.fh.write(cd, 0, cd.length, this.pos);
            this.pos += cd.length;
            cdSize += cd.length;
        }

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); // disk number
        eocd.writeUInt16LE(0, 6); // disk with cd
        eocd.writeUInt16LE(this.cd.length, 8);
        eocd.writeUInt16LE(this.cd.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        eocd.writeUInt16LE(0, 20); // comment length
        await this.fh.write(eocd, 0, eocd.length, this.pos);
        await this.fh.sync();
        await this.fh.close();
    }
}

function resolveZipPath(
    contentType: number,
    titleId: string,
    contentId: string,
    itemName: string,
): string | null {
    switch (contentType) {
        case CONTENT_TYPE_PSV_GAME:
            return `ux0:app/${titleId}/${itemName}`;

        case CONTENT_TYPE_PSV_DLC:
            return `ux0:addcont/${titleId}/${contentId}/${itemName}`;

        case CONTENT_TYPE_PSM_GAME:
        case CONTENT_TYPE_PSM_GAME_ALT: {
            const pre = "contents/";
            const name = itemName.startsWith(pre)
                ? itemName.slice(pre.length)
                : itemName.slice(pre.length - 1);

            return name.startsWith("runtime")
                ? `ux0:psm/${contentId}/${name}`
                : `ux0:psm/${contentId}/RO/${name}`;
        }

        case CONTENT_TYPE_PSX_GAME: {
            const pre = "USRDIR/CONTENT";

            if (itemName.startsWith(pre)) {
                const rest = itemName.slice(pre.length);
                if (!rest) return null;
                return `ur0:psp2emu/content/${titleId}.PSPDATA${rest}`;
            }

            return `ur0:psp2emu/content/${titleId}.PSPDATA/${itemName}`;
        }

        case CONTENT_TYPE_PSP_GAME:
        case CONTENT_TYPE_PSP_GAME_ALT:
        case CONTENT_TYPE_PSP_MINI:
        case CONTENT_TYPE_PSP_NEOGEO: {
            const pre = "USRDIR/CONTENT";

            if (itemName.startsWith(pre)) {
                const rest = itemName.slice(pre.length);
                if (!rest) return null;
                return `ux0:pspemu/PSP/GAME/${titleId}${rest}`;
            }

            return `ux0:pspemu/PSP/GAME/${titleId}/${itemName}`;
        }

        default:
            return null;
    }
}

export interface DecryptOptions {
    outDir?: string;
    /** Keep the source .pkg file after decryption (default: delete it) */
    keepPkg?: boolean;
    onProgress?: (received: number, total: number) => void;
}

export async function decryptPkg(
    pkgPath: string,
    entry: PkgEntry,
    opts: DecryptOptions = {},
): Promise<string> {
    const outDir = opts.outDir ?? ".";
    const titleId = entry.titleId || entry.contentId.slice(7, 16);
    const contentId = entry.contentId;
    const zipOut = join(outDir, `${titleId}.zip`);
    const pkgFh = await open(pkgPath, "r");

    try {
        const header = Buffer.alloc(PKG_HEADER_SIZE + PKG_HEADER_EXT_SIZE);
        await pkgFh.read(header, 0, header.length, 0);

        if (header.readUInt32BE(0) !== 0x7f504b47) {
            throw new Error("Not a valid PKG file (bad magic)");
        }

        const metaOffset = header.readUInt32BE(8);
        const metaCount = header.readUInt32BE(12);
        const indexCount = header.readUInt32BE(20);
        const totalSize = header.readBigUInt64BE(24);
        const encOffset = header.readBigUInt64BE(32);
        const encOffsetN = Number(encOffset);
        const iv = Buffer.from(header.subarray(0x70, 0x70 + 16));
        const keyType = header[0xe7]! & 7;

        let key: Buffer;
        if (keyType === 1) key = Buffer.from(PKG_PSP_KEY);
        else if (keyType === 2) key = aes128Encrypt(PKG_VITA_2, iv);
        else if (keyType === 3) key = aes128Encrypt(PKG_VITA_3, iv);
        else if (keyType === 4) key = aes128Encrypt(PKG_VITA_4, iv);
        else throw new Error(`Unsupported PKG key type: ${keyType}`);

        let contentType = CONTENT_TYPE_PSV_GAME;
        const metaBytes = encOffsetN - (PKG_HEADER_SIZE + PKG_HEADER_EXT_SIZE);

        if (metaBytes > 0) {
            const metaBuf = Buffer.alloc(metaBytes);
            await pkgFh.read(
                metaBuf,
                0,
                metaBytes,
                PKG_HEADER_SIZE + PKG_HEADER_EXT_SIZE,
            );

            let mp = metaOffset - (PKG_HEADER_SIZE + PKG_HEADER_EXT_SIZE);

            for (let i = 0; i < metaCount && mp + 8 <= metaBuf.length; i++) {
                const type = metaBuf.readUInt32BE(mp);
                const size = metaBuf.readUInt32BE(mp + 4);

                if (type === 2 && mp + 12 <= metaBuf.length)
                    contentType = metaBuf.readUInt32BE(mp + 8);
                mp += 8 + size;
            }
        }

        const indexBuf = Buffer.alloc(indexCount * 32);
        await pkgFh.read(indexBuf, 0, indexBuf.length, encOffsetN);

        interface FileEntry {
            nameOffset: number;
            nameSize: number;
            itemOffset: bigint;
            itemSize: bigint;
            type: number;
        }

        const files: FileEntry[] = [];

        for (let i = 0; i < indexCount; i++) {
            const raw = aes128Ctr(
                key,
                iv,
                BigInt(i * 32),
                Buffer.from(indexBuf.subarray(i * 32, (i + 1) * 32)),
            );

            files.push({
                nameOffset: raw.readUInt32BE(0),
                nameSize: raw.readUInt32BE(4),
                itemOffset: raw.readBigUInt64BE(8),
                itemSize: raw.readBigUInt64BE(16),
                type: raw[27]!,
            });
        }

        const outFh = await open(zipOut, "w+");
        const zip = new ZipWriter(outFh);

        let progressBytes = 0n;

        for (const f of files) {
            if (f.type === 4 || f.type === 18) continue; // directory / metadata

            const nameBuf = Buffer.alloc(f.nameSize);
            await pkgFh.read(nameBuf, 0, f.nameSize, encOffsetN + f.nameOffset);
            const itemName = aes128Ctr(
                key,
                iv,
                BigInt(f.nameOffset),
                nameBuf,
            ).toString("utf8");

            const zipFilePath = resolveZipPath(
                contentType,
                titleId,
                contentId,
                itemName,
            );
            if (!zipFilePath) continue;

            const encSize =
                (f.itemSize + BigInt(AES_BLOCK) - 1n) &
                ~(BigInt(AES_BLOCK) - 1n);
            const absStart = encOffsetN + Number(f.itemOffset);

            async function* fileChunks(): AsyncGenerator<Buffer> {
                let encRead = 0n;
                let written = 0;

                while (encRead < encSize) {
                    const toRead = Number(
                        encRead + BigInt(CHUNK) > encSize
                            ? encSize - encRead
                            : BigInt(CHUNK),
                    );
                    const chunk = Buffer.alloc(toRead);
                    await pkgFh.read(
                        chunk,
                        0,
                        toRead,
                        absStart + Number(encRead),
                    );
                    const dec = aes128Ctr(
                        key,
                        iv,
                        f.itemOffset + encRead,
                        chunk,
                    );
                    encRead += BigInt(toRead);

                    const remaining = Number(f.itemSize) - written;
                    if (remaining <= 0) return;
                    const slice =
                        remaining >= toRead ? dec : dec.subarray(0, remaining);
                    written += slice.length;

                    yield slice;
                }
            }

            await zip.addFile(zipFilePath, fileChunks());

            progressBytes += encSize;
            opts.onProgress?.(Number(progressBytes), Number(totalSize));
        }

        if (
            entry.zrif &&
            entry.zrif !== "MISSING" &&
            entry.zrif !== "ZRIF" &&
            (contentType === CONTENT_TYPE_PSV_GAME ||
                contentType === CONTENT_TYPE_PSV_DLC)
        ) {
            const rif = decodeZrif(entry.zrif);

            if (rif) {
                const rifPath =
                    contentType === CONTENT_TYPE_PSV_DLC
                        ? `ux0:license/addcont/${titleId}/${contentId}.rif`
                        : `ux0:license/app/${titleId}/${contentId}.rif`;

                async function* rifChunks(): AsyncGenerator<Buffer> {
                    yield rif!;
                }

                await zip.addFile(rifPath, rifChunks());
            }
        }

        await zip.finalize();
    } finally {
        await pkgFh.close();
    }

    if (!opts.keepPkg) {
        const { unlink } = await import("node:fs/promises");
        await unlink(pkgPath).catch(() => {});
    }

    return zipOut;
}
