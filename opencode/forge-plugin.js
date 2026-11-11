// Forge for OpenCode. Installed as <config>/plugin/forge.js by scripts/opencode-install.mjs; the Forge runtime sits next to it in <config>/forge/.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(here, '..', 'forge');

export const ForgePlugin = async (ctx) => {
  const { createHooks } = await import(pathToFileURL(path.join(runtimeDir, 'scripts', 'lib', 'opencode-loop.mjs')).href);
  return createHooks({ client: ctx.client, directory: ctx.directory, runtimeDir });
};
