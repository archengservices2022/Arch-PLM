// WP-2B (2B-1): registers the TEST-ONLY route loader (see route-loader.mjs).
// Usage: node --experimental-strip-types --import ./tests/support/register-route-loader.mjs --test tests/routes-*.test.ts
import { register } from "node:module";

register("./route-loader.mjs", import.meta.url);
