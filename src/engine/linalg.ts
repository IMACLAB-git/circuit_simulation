/**
 * Dense LU factorisation with partial pivoting.
 *
 * The MNA matrix is small (typically < 200 unknowns) but is re-solved tens of
 * times per animation frame, so the factorisation is kept in a reusable object
 * and the right-hand side solve is separated from the factorisation: a linear
 * circuit with a fixed time step only needs to be factorised once.
 */
export class LU {
  n: number;
  lu: Float64Array;
  piv: Int32Array;
  singular = false;

  constructor(n: number) {
    this.n = n;
    this.lu = new Float64Array(n * n);
    this.piv = new Int32Array(n);
  }

  /** Factorise a row-major n*n matrix. Returns false if numerically singular. */
  factor(a: Float64Array): boolean {
    const n = this.n;
    const lu = this.lu;
    lu.set(a);
    const piv = this.piv;
    for (let i = 0; i < n; i++) piv[i] = i;
    this.singular = false;

    for (let k = 0; k < n; k++) {
      // partial pivot
      let p = k;
      let max = Math.abs(lu[k * n + k]);
      for (let i = k + 1; i < n; i++) {
        const v = Math.abs(lu[i * n + k]);
        if (v > max) { max = v; p = i; }
      }
      if (max < 1e-30) { this.singular = true; return false; }
      if (p !== k) {
        for (let j = 0; j < n; j++) {
          const t = lu[p * n + j]; lu[p * n + j] = lu[k * n + j]; lu[k * n + j] = t;
        }
        const t = piv[p]; piv[p] = piv[k]; piv[k] = t;
      }
      const pivot = lu[k * n + k];
      for (let i = k + 1; i < n; i++) {
        const m = lu[i * n + k] / pivot;
        if (m === 0) continue;
        lu[i * n + k] = m;
        for (let j = k + 1; j < n; j++) lu[i * n + j] -= m * lu[k * n + j];
      }
    }
    return true;
  }

  /** Solve LU x = b using the stored factorisation. `x` may alias nothing. */
  solve(b: Float64Array, x: Float64Array): void {
    const n = this.n, lu = this.lu, piv = this.piv;
    for (let i = 0; i < n; i++) x[i] = b[piv[i]];
    for (let i = 1; i < n; i++) {
      let s = x[i];
      for (let j = 0; j < i; j++) s -= lu[i * n + j] * x[j];
      x[i] = s;
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let j = i + 1; j < n; j++) s -= lu[i * n + j] * x[j];
      x[i] = s / lu[i * n + i];
    }
  }
}
