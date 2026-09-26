import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "tool-token-budget-theme";
const LEGACY_STORAGE_KEY = "schema-budget-theme";

function readStoredTheme(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") {
    return saved;
  }
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy === "light" || legacy === "dark" || legacy === "system") {
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return legacy;
  }
  return "system";
}

type ThemeContextValue = {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      document.documentElement.setAttribute("data-theme", theme);
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyFromOs = () => {
      document.documentElement.setAttribute(
        "data-theme",
        mediaQuery.matches ? "dark" : "light"
      );
    };

    applyFromOs();
    mediaQuery.addEventListener("change", applyFromOs);
    return () => mediaQuery.removeEventListener("change", applyFromOs);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
