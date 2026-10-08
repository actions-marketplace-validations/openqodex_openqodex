// The shipped framework plugins. Only plugins listed here ever run; a
// repository can never add one. A new plugin is one import and one entry
// in PLUGINS, in id order.
import type { FrameworkPlugin } from "./plugin.js";
import { PLUGIN_API_VERSION } from "./plugin.js";

export const PLUGINS: readonly FrameworkPlugin[] = [];

// Part of every cached facts key: a plugin added, removed or bumped
// re-reads every file's facts.
export function pluginsKey(plugins: readonly FrameworkPlugin[] = PLUGINS): string {
  return [`api${PLUGIN_API_VERSION}`, ...plugins.map((p) => `${p.id}@${p.version}`)].join(",");
}
