import { createWriteStream, existsSync, statSync } from "fs";
import { join } from "path";
import type { PkgEntry } from "./catalog.ts";

export interface DownloadOptions {
    outDir?: string;
    onProgress?: (received: number, total: number) => void;
}

function safeFilename(entry: PkgEntry): string {
    const id = entry.titleId || entry.contentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${id}.pkg`;
}

export async function downloadPkg(
    entry: PkgEntry,
    opts: DownloadOptions = {},
): Promise<string> {
    const outDir = opts.outDir ?? ".";
    const filename = safeFilename(entry);
    const destPath = join(outDir, filename);

    let resumeFrom = 0;

    if (existsSync(destPath)) {
        resumeFrom = statSync(destPath).size;
    }

    const headers: Record<string, string> = {
        "User-Agent": "libhttp/3.65 (PS Vita)",
    };

    if (resumeFrom > 0) {
        headers["Range"] = `bytes=${resumeFrom}-`;
    }

    const res = await fetch(entry.url, { headers });

    if (res.status !== 200 && res.status !== 206) {
        throw new Error(`HTTP ${res.status} for ${entry.url}`);
    }

    if (res.status === 200 && resumeFrom > 0) {
        resumeFrom = 0;
    }

    const contentLength = Number(res.headers.get("Content-Length") ?? 0);
    const total = contentLength + resumeFrom;

    const fileFlags = resumeFrom > 0 ? "a" : "w";
    const dest = createWriteStream(destPath, { flags: fileFlags });

    let received = resumeFrom;

    const reader = res.body!.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);

            await new Promise<void>((resolve, reject) => {
                dest.write(chunk, (err) => (err ? reject(err) : resolve()));
            });

            received += chunk.length;
            opts.onProgress?.(received, total);
        }
    } finally {
        reader.releaseLock();
        await new Promise<void>((resolve) => dest.end(resolve));
    }

    return destPath;
}
