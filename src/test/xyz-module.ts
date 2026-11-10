// Test-only custom plugin: "XYZ!" magic followed by a PNG. Exercises the public PluginModule contract.
import { probeDimensions } from '../probe';
import type { PluginModule } from '../plugin';

export const container = 'xyz';
export const matches: PluginModule['matches'] = (bytes) => String.fromCharCode(...bytes.subarray(0, 4)) === 'XYZ!';
export const decoder: PluginModule['decoder'] = {
  decode: async (file) => {
    const blob = file.slice(4, file.size, 'image/png');
    const size = probeDimensions(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    if (!size) throw new Error('xyz: bad payload');
    return { blob, width: size.width, height: size.height };
  },
};
