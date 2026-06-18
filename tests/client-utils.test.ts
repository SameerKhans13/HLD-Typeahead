import { expect, test, describe } from "bun:test";
import { debounce, throttle, calculateRequestsSaved } from "../src/client-utils";

describe("Client Utilities - Debounce", () => {
  test("Behavior 1: debounce delays execution and collapses multiple rapid calls", async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
    };

    const debouncedFn = debounce(fn, 50);

    // Call rapid succession
    debouncedFn();
    debouncedFn();
    debouncedFn();

    expect(callCount).toBe(0);

    // Wait for debounce timeout
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callCount).toBe(1);
  });
});

describe("Client Utilities - Throttle", () => {
  test("Behavior 2: throttle invokes immediately but blocks subsequent calls within limit", async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
    };

    const throttledFn = throttle(fn, 50);

    // First call executes immediately (leading edge)
    throttledFn();
    expect(callCount).toBe(1);

    // Subsequent calls within 50ms are ignored
    throttledFn();
    throttledFn();
    expect(callCount).toBe(1);

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Next call after cooldown executes immediately
    throttledFn();
    expect(callCount).toBe(2);
  });
});

describe("Client Utilities - Requests Saved", () => {
  test("Behavior 3: calculateRequestsSaved accurately computes counts and percentages", () => {
    // Basic calculation
    const res = calculateRequestsSaved(10, 2);
    expect(res.saved).toBe(8);
    expect(res.percentage).toBe("80%");

    // Edge case: no keystrokes typed
    const resZero = calculateRequestsSaved(0, 0);
    expect(resZero.saved).toBe(0);
    expect(resZero.percentage).toBe("0%");

    // Edge case: more requests than keystrokes (should never happen, but handled gracefully)
    const resNegative = calculateRequestsSaved(2, 5);
    expect(resNegative.saved).toBe(0);
    expect(resNegative.percentage).toBe("0%");
  });
});
