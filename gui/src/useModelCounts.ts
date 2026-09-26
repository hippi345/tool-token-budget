import { useEffect, useState } from "react";
import type { ModelCountSummary } from "./types";
import { ModelCountsHttpError, postModelCounts } from "./api";
import {
  isUnknownPrimaryModelCountsError,
  modelCountsLoadErrorMessage,
} from "./modelCountsErrors";

export interface ModelColumnState {
  loading: boolean;
  tokenCountsByModel: Record<string, ModelCountSummary>;
  toolCounts: Record<string, Record<string, number>>;
  loadError: string | null;
}

const EMPTY: ModelColumnState = {
  loading: false,
  tokenCountsByModel: {},
  toolCounts: {},
  loadError: null,
};

export interface UseModelCountsOptions {
  onInvalidPrimaryModelId?: () => void;
}

export function useModelCounts(
  modelIds: string[],
  primaryModelId: string | undefined,
  countMode: "offline" | "api" | "auto",
  options?: UseModelCountsOptions
): ModelColumnState {
  const [state, setState] = useState<ModelColumnState>(EMPTY);

  useEffect(() => {
    if (modelIds.length === 0) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, loadError: null }));

    const run = () => {
      postModelCounts({
        modelIds,
        primaryModelId,
        countMode,
      })
        .then((resp) => {
          if (cancelled) return;
          const toolCounts: Record<string, Record<string, number>> = {};
          for (const row of resp.tools) {
            const key = `${row.server}::${row.name}`;
            toolCounts[key] = row.countsByModel;
          }
          setState({
            loading: false,
            tokenCountsByModel: resp.tokenCountsByModel,
            toolCounts,
            loadError: null,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (
            err instanceof ModelCountsHttpError &&
            isUnknownPrimaryModelCountsError(err.status, err.body)
          ) {
            options?.onInvalidPrimaryModelId?.();
            setState({
              loading: false,
              tokenCountsByModel: {},
              toolCounts: {},
              loadError: null,
            });
            return;
          }
          setState({
            loading: false,
            tokenCountsByModel: {},
            toolCounts: {},
            loadError: modelCountsLoadErrorMessage(err),
          });
        });
    };

    if (typeof requestIdleCallback !== "undefined") {
      const id = requestIdleCallback(run);
      return () => {
        cancelled = true;
        cancelIdleCallback(id);
      };
    }

    const t = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [modelIds.join(","), primaryModelId, countMode, options?.onInvalidPrimaryModelId]);

  return state;
}
