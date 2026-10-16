// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { clampProgress, syntheticProgressTarget, easedProgress } from "../helpers/progress";

export function useSyntheticProgress(value: number, paused = false): number {
  const initialProgress = Math.min(clampProgress(value), syntheticProgressTarget(value).cap);
  const [renderedProgress, setRenderedProgress] = useState(initialProgress);
  const renderedProgressRef = useRef(renderedProgress);

  useEffect(() => {
    renderedProgressRef.current = renderedProgress;
  }, [renderedProgress]);

  const target = syntheticProgressTarget(value);
  useEffect(() => {
    const start = renderedProgressRef.current;
    if (paused || target.cap <= start) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const nextProgress = easedProgress(start, target, Date.now() - startedAt);
      setRenderedProgress(nextProgress);
      if (target.cap - nextProgress < 0.001) {
        window.clearInterval(timer);
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [target.cap, target.speedMs, paused]);

  return Math.min(renderedProgress, target.cap);
}
