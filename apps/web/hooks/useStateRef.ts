import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef, useState } from 'react';

/**
 * A custom hook that combines useState with a ref that stays in sync.
 * Useful when you need to access the current value in callbacks without
 * causing re-subscriptions due to dependency changes.
 *
 * @param initialValue - The initial value for the state
 * @returns A tuple of [value, setValue, valueRef]
 */
export function useStateRef<T>(initialValue: T): [T, Dispatch<SetStateAction<T>>, MutableRefObject<T>] {
  const [value, setValue] = useState(initialValue);
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return [value, setValue, ref];
}
