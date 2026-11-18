// WP-2B (2B-1): TEST-ONLY Node module-resolution hooks that let the plain
// Node test runner load Next.js route handlers (app/api/**/route.ts) and
// their server-only libraries without the Next.js bundler.
//
// It does exactly three things, and nothing in the application changes:
//  1. "server-only"  -> an empty module. (In Next.js this marker only makes
//     the BUNDLER refuse client imports; it has no runtime behaviour.)
//  2. "@/<path>"     -> <repo>/<path> (+ ".ts" / ".tsx" / "/index.ts"), the
//     tsconfig "paths" alias that only the bundler understands.
//  3. "next/<x>"     -> next/<x>.js. The `next` package has no "exports" map,
//     so Node ESM needs the explicit file for subpaths like "next/server".
//
// Used only via tests/support/register-route-loader.mjs (npm run test:routes).
import { existsSync, statSync } from "node:fs";

const repoRoot = new URL("../../", import.meta.url);
const EMPTY_MODULE = "data:text/javascript,export%20%7B%7D%3B";

function firstExistingFile(baseHref, suffixes) {
  for (const suffix of suffixes) {
    const candidate = new URL(baseHref + suffix);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate.href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: EMPTY_MODULE, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const base = new URL(specifier.slice(2), repoRoot).href;
    const url = firstExistingFile(base, ["", ".ts", ".tsx", "/index.ts"]);
    if (url) return { url, shortCircuit: true };
  }
  if (/^next\/[A-Za-z0-9_./-]+$/.test(specifier) && !specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier + ".js", context);
    } catch {
      // fall through to the default resolution
    }
  }
  return nextResolve(specifier, context);
}
