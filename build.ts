#!/usr/bin/env bun
import { $ } from "bun";
import { rmSync, mkdirSync } from "fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

const libResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    external: ["@clack/prompts", "kleur"],
});

if (!libResult.success) {
    console.error("Library build failed:");
    for (const log of libResult.logs) console.error(log);
    process.exit(1);
}

const cliResult = await Bun.build({
    entrypoints: ["src/cli.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    minify: true,
});

if (!cliResult.success) {
    console.error("CLI build failed:");
    for (const log of cliResult.logs) console.error(log);
    process.exit(1);
}

const cli = await Bun.file("dist/cli.js").text();

await Bun.write("dist/cli.js", "#!/usr/bin/env node\n" + cli);
await $`chmod +x dist/cli.js`;
await $`bun tsc -p tsconfig.build.json`;

const glob = new Bun.Glob("dist/**/*.d.ts");

for await (const file of glob.scan(".")) {
    const content = await Bun.file(file).text();
    const fixed = content.replace(/from "(\.\.?\/[^"]+)\.ts"/g, 'from "$1.js"');

    if (fixed !== content) await Bun.write(file, fixed);
}

console.log("Build complete.");
