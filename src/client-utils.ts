export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: any;
  return function (...args: Parameters<T>) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return function (...args: Parameters<T>) {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

export function calculateRequestsSaved(
  keystrokes: number,
  actualRequests: number
): { saved: number; percentage: string } {
  if (keystrokes <= 0 || actualRequests < 0 || actualRequests > keystrokes) {
    return { saved: 0, percentage: "0%" };
  }
  const saved = keystrokes - actualRequests;
  const pct = Math.round((saved / keystrokes) * 100);
  return { saved, percentage: `${pct}%` };
}
