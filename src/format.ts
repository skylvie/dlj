import kleur from "kleur";

export function fmtSize(bytes: number): string {
    if (bytes === 0) {
        return "?";
    } else if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } else {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
}

export function fmtPercent(received: number, total: number): string {
    if (total === 0) return "??%";
    return `${Math.min(100, Math.floor((received / total) * 100))}%`;
}

export function progressBar(
    received: number,
    total: number,
    width = 30,
): string {
    if (total === 0) return "[" + " ".repeat(width) + "]";

    const filled = Math.min(width, Math.floor((received / total) * width));
    const empty = width - filled;

    return "[" + kleur.green("█".repeat(filled)) + " ".repeat(empty) + "]";
}

export function renderProgress(received: number, total: number): string {
    const bar = progressBar(received, total);
    const pct = fmtPercent(received, total).padStart(4);
    const recv = fmtSize(received).padStart(9);
    const tot = total > 0 ? fmtSize(total) : "?";

    return `${bar} ${pct}  ${recv} / ${tot}`;
}

export function regionColor(region: string): string {
    switch (region.toUpperCase()) {
        case "USA":
            return kleur.blue(region);
        case "EUR":
            return kleur.yellow(region);
        case "JP":
        case "JPN":
            return kleur.red(region);
        case "ASIA":
        case "ASA":
            return kleur.magenta(region);
        default:
            return kleur.white(region);
    }
}
