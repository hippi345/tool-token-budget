const SPARK = "▁▂▃▄▅▆▇█";

/**
 * Render a compact unicode sparkline for non-empty numeric series.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return SPARK[0]!.repeat(values.length);
  }
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / (max - min)) * (SPARK.length - 1));
      return SPARK[Math.min(SPARK.length - 1, Math.max(0, idx))]!;
    })
    .join("");
}
