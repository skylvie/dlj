#!/usr/bin/env bun
import * as p from "@clack/prompts";
import kleur from "kleur";
import { fetchCatalog, MODE_LABELS, type Mode } from "./catalog.ts";
import { downloadPkg } from "./download.ts";
import { fmtSize, renderProgress } from "./format.ts";
import { interactiveBrowse } from "./browse.ts";

const USAGE = `
${kleur.bold("dlj")} – PKGj downloader

${kleur.bold("Usage:")}
  dlj                        Interactive browser
  dlj list <catalog>         List all packages in a catalog
  dlj search <catalog> <q>   Search packages by name or title ID
  dlj get <url>              Download a .pkg by direct URL
  dlj help                   Show this message

${kleur.bold("Catalogs:")}
${Object.entries(MODE_LABELS)
    .map(([k, v]) => `  ${k.padEnd(12)} ${v}`)
    .join("\n")}

${kleur.bold("Options:")}
  --out, -o <dir>   Output directory (default: current directory)
`.trim();

function parseArgs(argv: string[]): {
    command: string;
    args: string[];
    outDir: string;
} {
    const args: string[] = [];
    let outDir = ".";
    let command = "";

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;

        if (a === "--out" || a === "-o") {
            outDir = argv[++i] ?? ".";
        } else if (command === "") {
            command = a;
        } else {
            args.push(a);
        }
    }

    return { command, args, outDir };
}

async function cmdList(mode: Mode): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Fetching ${MODE_LABELS[mode]}…`);

    const entries = await fetchCatalog(mode);
    spinner.stop(`${entries.length} packages`);

    for (const e of entries) {
        const region = e.region.padEnd(4);
        const id = kleur.bold(e.titleId.padEnd(10));
        const size = fmtSize(e.size).padStart(9);

        console.log(`${region}  ${id}  ${size}  ${e.name}`);
    }
}

async function cmdSearch(mode: Mode, query: string): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Fetching ${MODE_LABELS[mode]}…`);

    const entries = await fetchCatalog(mode);
    spinner.stop();

    const q = query.toLowerCase();
    const results = entries.filter(
        (e) =>
            e.name.toLowerCase().includes(q) ||
            e.titleId.toLowerCase().includes(q),
    );

    if (results.length === 0) {
        console.log(kleur.dim(`No results for "${query}"`));
        return;
    }

    console.log(
        kleur.dim(
            `${results.length} results for "${query}" in ${MODE_LABELS[mode]}\n`,
        ),
    );

    for (const e of results) {
        const region = e.region.padEnd(4);
        const id = kleur.bold(e.titleId.padEnd(10));
        const size = fmtSize(e.size).padStart(9);

        console.log(`${region}  ${id}  ${size}  ${e.name}`);
        if (e.url) console.log(`          ${kleur.dim(e.url)}`);
    }
}

async function cmdGet(url: string, outDir: string): Promise<void> {
    const filename = url.split("/").pop()?.split("?")[0] ?? "download.pkg";
    const titleId = filename.replace(/\.pkg$/i, "");

    p.log.step(`Downloading ${kleur.cyan(url)}`);

    const entry = {
        titleId,
        contentId: "",
        region: "",
        name: filename,
        nameOrg: "",
        url,
        zrif: "",
        size: 0,
        sha256: "",
        fwVersion: "",
        lastModified: "",
    };

    const destPath = await downloadPkg(entry, {
        outDir,
        onProgress(received, total) {
            process.stdout.write(
                "\r  " + renderProgress(received, total) + "  ",
            );
        },
    });

    process.stdout.write("\n");
    p.log.success(`Saved to ${kleur.green(destPath)}`);
}

const { command, args, outDir } = parseArgs(process.argv.slice(2));

try {
    switch (command) {
        case "":
        case "browse":
            await interactiveBrowse(outDir);
            break;

        case "list": {
            const mode = args[0] as Mode | undefined;

            if (!mode || !(mode in MODE_LABELS)) {
                console.error(
                    kleur.red(`Unknown catalog: ${mode ?? "(none)"}`),
                );
                console.error(
                    `Valid catalogs: ${Object.keys(MODE_LABELS).join(", ")}`,
                );
                process.exit(1);
            }

            await cmdList(mode);
            break;
        }

        case "search": {
            const mode = args[0] as Mode | undefined;
            const query = args[1];

            if (!mode || !(mode in MODE_LABELS)) {
                console.error(
                    kleur.red(`Unknown catalog: ${mode ?? "(none)"}`),
                );
                process.exit(1);
            }

            if (!query) {
                console.error(kleur.red("search requires a query"));
                process.exit(1);
            }

            await cmdSearch(mode, query);
            break;
        }

        case "get": {
            const url = args[0];

            if (!url) {
                console.error(kleur.red("get requires a URL"));
                process.exit(1);
            }

            await cmdGet(url, outDir);
            break;
        }

        case "help":
        case "--help":
        case "-h":
            console.log(USAGE);
            break;

        default:
            console.error(kleur.red(`Unknown command: ${command}`));
            console.log(USAGE);
            process.exit(1);
    }
} catch (err) {
    p.log.error(String(err));
    process.exit(1);
}
