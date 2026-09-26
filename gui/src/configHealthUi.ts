/** Pure helper for Editor apply-section state when /api/health configLoadError changes. */
export function reconcileApplySectionOnConfigHealth(
  configLoadError: string | null | undefined
): {
  clearPreview: boolean;
  clearApplyError: boolean;
  clearExportResult: boolean;
} {
  if (configLoadError) {
    return { clearPreview: true, clearApplyError: true, clearExportResult: true };
  }
  return { clearPreview: false, clearApplyError: true, clearExportResult: false };
}

/** Hide duplicate preview/apply errors when the config banner already explains the failure. */
export function shouldShowApplyPreviewError(
  error: string | null | undefined,
  configLoadError: string | null | undefined
): boolean {
  return Boolean(error) && !configLoadError;
}

export function shouldShowExportError(
  exportError: string | null | undefined,
  configLoadError: string | null | undefined
): boolean {
  return Boolean(exportError) && !configLoadError;
}

export const EXPORT_CONFIG_ERROR_HINT_ID = "export-config-error-hint";

export const EXPORT_CONFIG_ERROR_HINT =
  "Fix the config error shown in Apply to export";

export function isExportBlockedByConfigLoadError(
  configLoadError: string | null | undefined
): boolean {
  return Boolean(configLoadError);
}

export function shouldShowExportConfigHint(
  configLoadError: string | null | undefined
): boolean {
  return isExportBlockedByConfigLoadError(configLoadError);
}

export function exportButtonTitleWhenConfigError(
  configLoadError: string | null | undefined
): string | undefined {
  return shouldShowExportConfigHint(configLoadError)
    ? EXPORT_CONFIG_ERROR_HINT
    : undefined;
}

/** How many error banners Editor should show (config + conditional export/apply). */
export function countEditorErrorBanners(options: {
  configLoadError: string | null | undefined;
  exportError: string | null | undefined;
  applyPreviewError: string | null | undefined;
}): number {
  let count = 0;
  if (options.configLoadError) {
    count += 1;
  }
  if (shouldShowExportError(options.exportError, options.configLoadError)) {
    count += 1;
  }
  if (shouldShowApplyPreviewError(options.applyPreviewError, options.configLoadError)) {
    count += 1;
  }
  return count;
}
