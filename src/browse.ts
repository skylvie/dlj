import * as p from "@clack/prompts";
import kleur from "kleur";
import {
    fetchCatalog,
    MODE_LABELS,
    type Mode,
    type PkgEntry,
} from "./catalog.ts";
import { downloadPkg } from "./download.ts";
import { fmtSize, regionColor, renderProgress } from "./format.ts";

const MODES = Object.keys(MODE_LABELS) as Mode[];

async function selectMode(): Promise<Mode | null> {
    const result = await p.select<Mode>({
        message: "Select a catalog",
        options: MODES.map((m) => ({ value: m, label: MODE_LABELS[m] })),
    });

    if (p.isCancel(result)) return null;
    return result;
}

const PAGE_SIZE = 20;

interface BrowseResult {
    action: "download" | "back";
    entry?: PkgEntry;
}

async function browseCatalog(
    entries: PkgEntry[],
    mode: Mode,
): Promise<BrowseResult> {
    let search = "";
    let page = 0;

    while (true) {
        const filtered = search
            ? entries.filter(
                  (e) =>
                      e.name.toLowerCase().includes(search.toLowerCase()) ||
                      e.titleId.toLowerCase().includes(search.toLowerCase()),
              )
            : entries;

        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        page = Math.min(page, totalPages - 1);
        const slice = filtered.slice(
            page * PAGE_SIZE,
            page * PAGE_SIZE + PAGE_SIZE,
        );

        type Option = {
            value: string;
            label: string;
            hint?: string;
        };

        const options: Option[] = slice.map((e, i) => ({
            value: String(page * PAGE_SIZE + i),
            label: `${regionColor(e.region.padEnd(4))} ${kleur.bold(e.titleId)}  ${e.name}`,
            hint: fmtSize(e.size),
        }));

        const navOptions: Option[] = [];

        if (page > 0) {
            navOptions.push({
                value: "__prev",
                label: kleur.dim("← Previous page"),
            });
        }

        if (page < totalPages - 1) {
            navOptions.push({
                value: "__next",
                label: kleur.dim("Next page →"),
            });
        }

        navOptions.push({
            value: "__search",
            label: kleur.dim("Search…"),
        });
        navOptions.push({
            value: "__back",
            label: kleur.dim("← Back to catalogs"),
        });

        const header =
            `${kleur.bold(MODE_LABELS[mode])}` +
            (search ? kleur.yellow(`  [search: "${search}"]`) : "") +
            kleur.dim(
                `  ${filtered.length} items  page ${page + 1}/${totalPages}`,
            );
        const chosen = await p.select<string>({
            message: header,
            options: [...options, ...navOptions],
        });

        if (p.isCancel(chosen)) return { action: "back" };

        if (chosen === "__prev") {
            page--;
            continue;
        }

        if (chosen === "__next") {
            page++;
            continue;
        }
        if (chosen === "__back") return { action: "back" };

        if (chosen === "__search") {
            const q = await p.text({
                message: "Search (title ID or name, empty to clear)",
                initialValue: search,
            });

            if (p.isCancel(q)) continue;

            search = q.trim();
            page = 0;

            continue;
        }

        const entry = filtered[Number(chosen)];
        if (!entry) continue;

        const action = await entryDetail(entry, mode);
        if (action === "download") return { action: "download", entry };
    }
}

async function entryDetail(
    entry: PkgEntry,
    _mode: Mode,
): Promise<"download" | "back"> {
    const lines = [
        `  ${kleur.dim("Title ID")}   ${kleur.bold(entry.titleId)}`,
        `  ${kleur.dim("Region")}     ${regionColor(entry.region)}`,
        `  ${kleur.dim("Name")}       ${entry.name}`,
        entry.nameOrg ? `  ${kleur.dim("Orig. name")} ${entry.nameOrg}` : null,
        entry.fwVersion
            ? `  ${kleur.dim("Min FW")}     ${entry.fwVersion}`
            : null,
        `  ${kleur.dim("Size")}       ${fmtSize(entry.size)}`,
        `  ${kleur.dim("Last mod")}   ${entry.lastModified}`,
        `  ${kleur.dim("URL")}        ${kleur.cyan(entry.url)}`,
        entry.sha256 ? `  ${kleur.dim("SHA-256")}    ${entry.sha256}` : null,
    ]
        .filter(Boolean)
        .join("\n");

    p.note(lines, entry.name);

    const choice = await p.select<string>({
        message: "What would you like to do?",
        options: [
            { value: "download", label: "Download" },
            { value: "back", label: "← Back" },
        ],
    });

    if (p.isCancel(choice) || choice === "back") return "back";
    return "download";
}

async function runDownload(entry: PkgEntry, outDir: string): Promise<void> {
    p.log.step(`Downloading  ${kleur.bold(entry.name)}`);
    p.log.info(`→ ${kleur.cyan(entry.url)}`);

    let lastLine = "";

    const destPath = await downloadPkg(entry, {
        outDir,
        onProgress(received, total) {
            const line = "\r  " + renderProgress(received, total) + "  ";
            if (line !== lastLine) {
                process.stdout.write(line);
                lastLine = line;
            }
        },
    });

    process.stdout.write("\n");
    p.log.success(`Saved to ${kleur.green(destPath)}`);
}

export async function interactiveBrowse(outDir: string): Promise<void> {
    p.intro(kleur.bold().bgMagenta(" dlj ") + "  PKGj downloader");

    while (true) {
        const mode = await selectMode();
        if (mode === null) break;

        const spinner = p.spinner();
        spinner.start(`Fetching ${MODE_LABELS[mode]} catalog…`);

        let entries: PkgEntry[];

        try {
            entries = await fetchCatalog(mode);
            spinner.stop(
                `${kleur.bold(MODE_LABELS[mode])}  ${entries.length} packages`,
            );
        } catch (err) {
            spinner.stop(kleur.red("Failed to fetch catalog"));
            p.log.error(String(err));

            continue;
        }

        const result = await browseCatalog(entries, mode);
        if (result.action === "download" && result.entry) {
            await runDownload(result.entry, outDir);

            const again = await p.confirm({ message: "Download another?" });
            if (p.isCancel(again) || !again) break;
        }
    }

    p.outro(kleur.dim("Bye!"));
}
