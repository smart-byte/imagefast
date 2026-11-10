import workerUrl from './xyz-module.ts?worker&url';
import type { ImageFastPlugin } from '../plugin';

export const xyz: ImageFastPlugin = { module: workerUrl };
