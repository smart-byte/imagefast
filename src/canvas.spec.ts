import { describe, expect, it } from 'vitest';
import { fitSize } from './canvas';

describe('fitSize', () => {
  it.each([
    ['contain, width only', [4000, 3000], { width: 1024 }, [1024, 768]],
    ['contain, portrait into a square box', [3000, 4000], { width: 1024, height: 1024 }, [768, 1024]],
    ['contain, landscape into a tall box', [4000, 2000], { width: 800, height: 1000 }, [800, 400]],
    ['contain never upscales', [500, 400], { width: 1024, height: 1024 }, [500, 400]],
    ['cover fills the box on the short side', [3000, 2000], { width: 256, height: 256, fit: 'cover' }, [384, 256]],
    ['cover with a width only scales to that width', [3000, 2000], { width: 300, fit: 'cover' }, [300, 200]],
    ['cover never upscales', [300, 100], { width: 200, height: 200, fit: 'cover' }, [300, 100]],
    ['keeps at least one pixel', [10000, 1], { width: 100 }, [100, 1]],
  ] as const)('%s', (_, [w, h], box, [ew, eh]) => {
    expect(fitSize(w, h, box)).toEqual({ width: ew, height: eh });
  });
});
