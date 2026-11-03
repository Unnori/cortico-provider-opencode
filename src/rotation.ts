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

export interface KeyCursor {
  /** The key to send right now, or null when this endpoint has no usable secret. */
  current(): { name: string; value: string } | null;
  /** Record that the account refused the current key, and move on when another one is configured. */
  refuse(): void;
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

  const usable = (name: string): boolean => Boolean(opts.read(name));

  return {
    current(): { name: string; value: string } | null {
      // One name is an ordinary endpoint: use it or report nothing, and never rotate.
      if (opts.names.length <= 1) {
        const name = opts.names[0];
        if (!name) return null;
        const value = opts.read(name);
        return value ? { name, value } : null;
      }
      for (let step = index; step < opts.names.length; step++) {
        const name = opts.names[step];
        if (name && usable(name)) {
          index = step;
          return { name, value: opts.read(name) };
        }
      }
      return null;
    },
    refuse(): void {
      if (opts.names.length <= 1) return;
      if (index < opts.names.length - 1) index += 1;
    },
    index(): number {
      return index;
    },
    names(): string[] {
      return [...opts.names];
    },
  };
}
