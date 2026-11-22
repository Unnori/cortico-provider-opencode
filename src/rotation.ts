/**
 * Key rotation across the secret names one endpoint lists.
 *
 * Priority order: the endpoint spends the current key until the account refuses it, then moves to the
 * next, and it does not go back — a refusal means the allowance window is spent or the account is
 * throttled, and returning early costs the prompt cache a second time for a key that is likely still
 * blocked. Rotation therefore happens at most once per key per process lifetime.
 *
 * `headers()` runs on every transport attempt, including the retries the framework performs after 408,
 * 429 and 5xx, so the cursor lives here rather than inside a client: all four protocol clients of one
 * endpoint share a single position.
 */

export interface KeyCredential {
  name: string;
  value: string;
}

export interface KeyCursor {
  /** The key to send right now, or null when this endpoint has no usable secret. */
  current(): KeyCredential | null;
  /** Advance only for the rejected credential. Return true if a different key is available. */
  refuse(attempted: KeyCredential): boolean;
  /** Position in `names`, for the panel. */
  index(): number;
  /** Names in rotation order, for the panel. */
  names(): string[];
}

export interface KeyCursorOptions {
  names: readonly string[];
  read: (name: string) => string;
}

export function createKeyCursor(opts: KeyCursorOptions): KeyCursor {
  let index = 0;

  function select(start: number, rejectedValue?: string): KeyCredential | null {
    for (let step = start; step < opts.names.length; step++) {
      const name = opts.names[step];
      const value = opts.read(name);
      if (value && value !== rejectedValue) {
        index = step;
        return { name, value };
      }
    }
    return null;
  }

  return {
    current: () => select(index),
    refuse(attempted): boolean {
      const active = select(index);
      if (!active) return false;
      if (active.value !== attempted.value) return true;
      if (active.name !== attempted.name) return false;
      return select(index + 1, attempted.value) !== null;
    },
    index(): number {
      return index;
    },
    names(): string[] {
      return [...opts.names];
    },
  };
}
