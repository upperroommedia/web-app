import { AssertionError } from 'assert';
import { imageLimits } from '../config';

/** Check dimensions before native image processing allocates an output raster. */
export function assertImageDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      width > imageLimits.dimension || height > imageLimits.dimension || width * height > imageLimits.pixels) {
    throw new AssertionError({ message: 'Transformed image exceeds the size limit.' });
  }
}

export function assertAffineDimensions(width: number, height: number, matrix: number[], offsets: number[]): void {
  if (matrix.length !== 4 || !matrix.every(Number.isFinite) || !offsets.every(Number.isFinite) ||
      matrix[0] * matrix[3] - matrix[1] * matrix[2] === 0) {
    throw new AssertionError({ message: 'Affine matrix must be finite and invertible.' });
  }
  // An affine transform maps the input rectangle to a parallelogram. Its axis-aligned
  // bounds are the sum of the absolute transformed axis lengths. Translations do not
  // enlarge these bounds, but constrain them too to avoid native integer overflow.
  assertImageDimensions(Math.ceil(Math.abs(matrix[0]) * width + Math.abs(matrix[1]) * height),
    Math.ceil(Math.abs(matrix[2]) * width + Math.abs(matrix[3]) * height));
  if (offsets.some(offset => Math.abs(offset) > imageLimits.dimension)) {
    throw new AssertionError({ message: 'Affine offset exceeds the size limit.' });
  }
}

export function assertRotatedDimensions(width: number, height: number, angle: number): void {
  const radians = ((angle % 360) * Math.PI) / 180;
  // Avoid rounding a tiny floating-point residual up to an additional pixel at 90°.
  const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
  assertImageDimensions(Math.ceil(width * cosine + height * sine - 1e-8),
    Math.ceil(width * sine + height * cosine - 1e-8));
}
