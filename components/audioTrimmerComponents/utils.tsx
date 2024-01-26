import { Dispatch, MutableRefObject, SetStateAction, useEffect, useMemo, useRef, useState } from 'react';

export function useStateRef<T>(initialValue: T): [T, Dispatch<SetStateAction<T>>, MutableRefObject<T>] {
  const [value, setValue] = useState(initialValue);
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return [value, setValue, ref];
}

// A custom hook to calculate and memoize time strings
export function useTrimTimes(start: number, stop: number) {
  const trimStartTime = useMemo(() => {
    return calculateTime(start);
  }, [start]);
  const trimEndTime = useMemo(() => calculateTime(stop), [stop]);
  return { trimStartTime, trimEndTime };
}

export const calculateTime = (sec: number) => {
  const hours: number = Math.floor(sec / 3600); // get hours
  const minutes: number = Math.floor((sec - hours * 3600) / 60); // get minutes
  const seconds: number = Math.floor(sec - hours * 3600 - minutes * 60); //  get seconds
  return (hours > 0 ? hours + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'); // Return is HH : MM : SS
};
