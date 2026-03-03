export type Mode =
    | "psvGames"
    | "psvDlcs"
    | "psvDemos"
    | "psvThemes"
    | "psxGames"
    | "pspGames"
    | "pspDlcs"
    | "psmGames";

export const MODE_LABELS: Record<Mode, string> = {
    psvGames: "PS Vita Games",
    psvDlcs: "PS Vita DLCs",
    psvDemos: "PS Vita Demos",
    psvThemes: "PS Vita Themes",
    psxGames: "PS1 Games",
    pspGames: "PSP Games",
    pspDlcs: "PSP DLCs",
    psmGames: "PSM Games",
};

// pkgj | src/config.cpp
const CATALOG_URLS: Record<Mode, string> = Object.freeze({
    psvGames: "http://nopaystation.com/tsv/PSV_GAMES.tsv",
    psvDlcs: "http://nopaystation.com/tsv/PSV_DLCS.tsv",
    psvDemos: "http://nopaystation.com/tsv/PSV_DEMOS.tsv",
    psvThemes: "http://nopaystation.com/tsv/PSV_THEMES.tsv",
    psxGames: "http://nopaystation.com/tsv/PSX_GAMES.tsv",
    pspGames: "http://nopaystation.com/tsv/PSP_GAMES.tsv",
    pspDlcs: "http://nopaystation.com/tsv/PSP_DLCS.tsv",
    psmGames: "http://psmreborn.com/tsv.php",
});

export interface PkgEntry {
    titleId: string;
    contentId: string;
    region: string;
    name: string;
    nameOrg: string;
    url: string;
    zrif: string;
    size: number;
    sha256: string;
    fwVersion: string;
    lastModified: string;
}

function parseTsv(text: string): string[][] {
    const lines = text.split("\n");
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        rows.push(line.split("\t"));
    }

    return rows;
}

function col(cols: string[], i: number): string {
    return cols[i] ?? "";
}

function isValid(url: string, zrif: string): boolean {
    if (!url || url === "MISSING" || url === "CART ONLY") return false;
    if (zrif === "MISSING") return false;

    return true;
}

function rowToPsvGame(cols: string[]): PkgEntry {
    const contentId = col(cols, 5);

    return {
        region: col(cols, 1),
        name: col(cols, 2),
        url: col(cols, 3),
        zrif: col(cols, 4),
        contentId,
        lastModified: col(cols, 6),
        nameOrg: col(cols, 7),
        size: Number(col(cols, 8)) || 0,
        sha256: col(cols, 9),
        fwVersion: col(cols, 10),
        titleId: contentId.slice(7, 16),
    };
}

function rowToPsvDlc(cols: string[]): PkgEntry {
    const contentId = col(cols, 5);

    return {
        region: col(cols, 1),
        name: col(cols, 2),
        url: col(cols, 3),
        zrif: col(cols, 4),
        contentId,
        lastModified: col(cols, 6),
        nameOrg: "",
        size: Number(col(cols, 7)) || 0,
        sha256: col(cols, 8),
        fwVersion: "",
        titleId: contentId.slice(7, 16),
    };
}

function rowToPsxGame(cols: string[]): PkgEntry {
    const contentId = col(cols, 4);

    return {
        region: col(cols, 1),
        name: col(cols, 2),
        url: col(cols, 3),
        zrif: "",
        contentId,
        lastModified: col(cols, 5),
        nameOrg: col(cols, 6),
        size: Number(col(cols, 7)) || 0,
        sha256: col(cols, 8),
        fwVersion: "",
        titleId: contentId.slice(7, 16),
    };
}

function rowToPspGame(cols: string[]): PkgEntry {
    const contentId = col(cols, 5);

    return {
        region: col(cols, 1),
        name: col(cols, 3),
        url: col(cols, 4),
        zrif: "",
        contentId,
        lastModified: col(cols, 6),
        nameOrg: "",
        size: Number(col(cols, 9)) || 0,
        sha256: col(cols, 10),
        fwVersion: "",
        titleId: contentId.slice(7, 16),
    };
}

function rowToPspDlc(cols: string[]): PkgEntry {
    const contentId = col(cols, 4);

    return {
        region: col(cols, 1),
        name: col(cols, 2),
        url: col(cols, 3),
        zrif: "",
        contentId,
        lastModified: col(cols, 5),
        nameOrg: "",
        size: Number(col(cols, 8)) || 0,
        sha256: col(cols, 9),
        fwVersion: "",
        titleId: contentId.slice(7, 16),
    };
}

const MAPPERS: Record<Mode, (cols: string[]) => PkgEntry> = {
    psvGames: rowToPsvGame,
    psvDlcs: rowToPsvDlc,
    psvDemos: rowToPsvGame,
    psvThemes: rowToPsvDlc,
    psxGames: rowToPsxGame,
    pspGames: rowToPspGame,
    pspDlcs: rowToPspDlc,
    psmGames: rowToPsvDlc,
};

export async function fetchCatalog(mode: Mode): Promise<PkgEntry[]> {
    const url = CATALOG_URLS[mode];
    const res = await fetch(url, {
        headers: { "User-Agent": "libhttp/3.65 (PS Vita)" },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();

    const mapper = MAPPERS[mode];
    return parseTsv(text)
        .map(mapper)
        .filter((e) => isValid(e.url, e.zrif))
        .sort(compareName);
}

function nameCategory(name: string): number {
    const cp = name.codePointAt(0) ?? 0;

    if (
        (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
        (cp >= 0xff65 && cp <= 0xff9f) // Halfwidth Katakana
    ) {
        return 0;
    }

    if (cp >= 0x30 && cp <= 0x39) return 1; // 0–9
    return 2;
}

function compareName(a: PkgEntry, b: PkgEntry): number {
    const ca = nameCategory(a.name);
    const cb = nameCategory(b.name);
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
