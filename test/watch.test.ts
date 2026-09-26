import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../src/utils/debounce.js";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should delay function execution", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should cancel previous calls if invoked again", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should pass arguments to the debounced function", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("arg1", 42);
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledWith("arg1", 42);
  });
});
