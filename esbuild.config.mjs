import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const prod = process.argv[2] === "production";
const vault = process.env.OBSIDIAN_VAULT;

const deploy = {
  name: "deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length || !vault) return;
      const dir = join(vault, ".obsidian", "plugins", "agent-sidebar");
      mkdirSync(dir, { recursive: true });
      for (const [from, to] of [["dist/main.js", "main.js"], ["manifest.json", "manifest.json"], ["styles.css", "styles.css"]]) {
        copyFileSync(from, join(dir, to));
      }
      console.log(`deployed to ${dir}`);
    });
  },
};

// Bare "events" from the SDK goes through a shim; see src/shims/events.cjs.
const eventsShim = {
  name: "events-shim",
  setup(build) {
    build.onResolve({ filter: /^events$/ }, () => ({ path: resolve("src/shims/events.cjs") }));
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins, ...builtins.map((m) => `node:${m}`)],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  outfile: "dist/main.js",
  // The Agent SDK is ESM and calls createRequire(import.meta.url) at load time.
  define: { "import.meta.url": "__cc_import_meta_url" },
  banner: {
    js: "var __cc_import_meta_url = typeof __filename !== 'undefined' ? require('url').pathToFileURL(__filename).href : 'file:///obsidian-agent-sidebar/main.js';",
  },
  plugins: [eventsShim, deploy],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
