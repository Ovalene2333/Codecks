import { useCallback, useEffect, useMemo, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type MotionPreference = "system" | "on" | "off";
export type EffectsPreference = "on" | "off";

export interface AppearancePreferences {
  theme: ThemePreference;
  motion: MotionPreference;
  effects: EffectsPreference;
}

export interface ResolvedAppearance {
  theme: "light" | "dark";
  motion: "on" | "off";
  effects: "on" | "off";
}

export const APPEARANCE_STORAGE_KEY = "codex-deck:appearance:v1";

const defaults: AppearancePreferences = {
  theme: "system",
  motion: "system",
  effects: "on",
};

const themeValues = new Set<ThemePreference>(["system", "light", "dark"]);
const motionValues = new Set<MotionPreference>(["system", "on", "off"]);
const effectsValues = new Set<EffectsPreference>(["on", "off"]);

export function normalizeAppearancePreferences(
  value: unknown,
): AppearancePreferences {
  if (!value || typeof value !== "object") return defaults;
  const candidate = value as Partial<AppearancePreferences>;
  return {
    theme: themeValues.has(candidate.theme as ThemePreference)
      ? (candidate.theme as ThemePreference)
      : defaults.theme,
    motion: motionValues.has(candidate.motion as MotionPreference)
      ? (candidate.motion as MotionPreference)
      : defaults.motion,
    effects: effectsValues.has(candidate.effects as EffectsPreference)
      ? (candidate.effects as EffectsPreference)
      : defaults.effects,
  };
}

export function resolveAppearance(
  preferences: AppearancePreferences,
  systemDark: boolean,
  systemReducedMotion: boolean,
): ResolvedAppearance {
  return {
    theme:
      preferences.theme === "system"
        ? systemDark
          ? "dark"
          : "light"
        : preferences.theme,
    motion:
      preferences.motion === "system"
        ? systemReducedMotion
          ? "off"
          : "on"
        : preferences.motion,
    effects: preferences.effects,
  };
}

function readStoredAppearance(): AppearancePreferences {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return raw ? normalizeAppearancePreferences(JSON.parse(raw)) : defaults;
  } catch {
    return defaults;
  }
}

function systemAppearance() {
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
  };
}

function applyResolvedAppearance(resolved: ResolvedAppearance) {
  const root = document.documentElement;
  root.dataset.theme = resolved.theme;
  root.dataset.motion = resolved.motion;
  root.dataset.effects = resolved.effects;
  root.style.colorScheme = resolved.theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      resolved.theme === "light" ? "#f4f6f9" : "#10131a",
    );
}

export function initializeAppearance() {
  if (typeof window === "undefined") return;
  const system = systemAppearance();
  applyResolvedAppearance(
    resolveAppearance(
      readStoredAppearance(),
      system.dark,
      system.reducedMotion,
    ),
  );
}

export function useAppearance() {
  const [preferences, setPreferences] = useState(readStoredAppearance);
  const [system, setSystem] = useState(systemAppearance);
  const resolved = useMemo(
    () => resolveAppearance(preferences, system.dark, system.reducedMotion),
    [preferences, system.dark, system.reducedMotion],
  );

  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setSystem({ dark: dark.matches, reducedMotion: reduced.matches });
    dark.addEventListener("change", update);
    reduced.addEventListener("change", update);
    return () => {
      dark.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    applyResolvedAppearance(resolved);
    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      // Private browsing and storage quotas should not block appearance changes.
    }
  }, [preferences, resolved]);

  const update = useCallback((patch: Partial<AppearancePreferences>) => {
    setPreferences((current) =>
      normalizeAppearancePreferences({ ...current, ...patch }),
    );
  }, []);

  return { preferences, resolved, update };
}
