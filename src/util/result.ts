/**
 * Discriminated-union Result type — Rust-style.
 * Zero deps, zero `any`, shared prototype via class for full type safety.
 *
 * @module result
 */

/** Ok variant — carries `value: T`. */
class OkResult<T, E> {
  readonly ok = true as const;
  constructor(readonly value: T) {}

  /** Returns `true` — narrows to OkResult. */
  isOk(): this is OkResult<T, E> {
    return true;
  }
  /** Returns `false`. */
  isErr(): this is ErrResult<T, E> {
    return false;
  }
  /** Returns the success value. */
  unwrap(): T {
    return this.value;
  }
  /** Returns the success value. */
  unwrapOr(): T {
    return this.value;
  }
  /** Leaves Ok untouched. */
  mapErr<F>(): Result<T, F> {
    return this as unknown as Result<T, F>;
  }
  /** Calls the `ok` arm. */
  match<U>(cases: { ok: (value: T) => U; err: (error: E) => U }): U {
    return cases.ok(this.value);
  }
}

/** Err variant — carries `error: E`. */
class ErrResult<T, E> {
  readonly ok = false as const;
  constructor(readonly error: E) {}

  /** Returns `false`. */
  isOk(): this is OkResult<T, E> {
    return false;
  }
  /** Returns `true` — narrows to ErrResult. */
  isErr(): this is ErrResult<T, E> {
    return true;
  }
  /** Throws the error. */
  unwrap(): T {
    throw this.error instanceof Error ? this.error : new Error(String(this.error));
  }
  /** Returns the fallback value. */
  unwrapOr<U>(fallback: U): T | U {
    return fallback;
  }
  /** Transforms the error. */
  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return err(fn(this.error));
  }
  /** Calls the `err` arm. */
  match<U>(cases: { ok: (value: T) => U; err: (error: E) => U }): U {
    return cases.err(this.error);
  }
}

/** Union of Ok and Err. Discriminated on the `ok` boolean field. */
export type Result<T, E = Error> = OkResult<T, E> | ErrResult<T, E>;

/**
 * Create an Ok Result.
 * @param value - The success value.
 * @returns A Result in the Ok state.
 */
export const ok = <T>(value: T): Result<T, never> => new OkResult(value) as Result<T, never>;

/**
 * Create an Err Result.
 * @param error - The error value.
 * @returns A Result in the Err state.
 */
export const err = <E>(error: E): Result<never, E> => new ErrResult(error) as Result<never, E>;

/**
 * Wrap a synchronous function that may throw into a Result.
 * @param fn - A function that may throw.
 * @returns Ok with the return value, or Err with the caught error.
 */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Wrap an asynchronous function that may throw into a Result.
 * @param fn - An async function that may throw.
 * @returns A promise resolving to Ok or Err.
 */
export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
