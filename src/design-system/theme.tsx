import { useEffect, useMemo, useState, type ReactNode } from "react";
import GlobalStyles from "@mui/material/GlobalStyles";
import { ThemeProvider, createTheme } from "@mui/material/styles";

type DeckThemeMode = "light" | "dark";

const palettes = {
  dark: {
    bg: "#0b0d10",
    sidebar: "#101318",
    surface: "#15191f",
    surface2: "#1b2028",
    surfaceMuted: "#11151a",
    surfaceRaised: "#1c2129",
    control: "#171b21",
    controlHover: "#20262e",
    controlBorder: "#343b46",
    line: "#272d35",
    lineStrong: "#3b4552",
    text: "#f1f3f5",
    textSoft: "#d7dce2",
    textDim: "#99a2ad",
    textFaint: "#707b89",
    primary: "#a8c7fa",
    primaryHover: "#c2d7fc",
    primaryText: "#062e6f",
    focus: "#8ab4f8",
  },
  light: {
    bg: "#f7f8fa",
    sidebar: "#ffffff",
    surface: "#ffffff",
    surface2: "#edf1f5",
    surfaceMuted: "#f4f6f8",
    surfaceRaised: "#ffffff",
    control: "#f5f7f9",
    controlHover: "#e8edf3",
    controlBorder: "#c7ced8",
    line: "#dce1e7",
    lineStrong: "#b8c1cc",
    text: "#202124",
    textSoft: "#3c4043",
    textDim: "#5f6368",
    textFaint: "#7b8490",
    primary: "#0b57d0",
    primaryHover: "#0842a0",
    primaryText: "#ffffff",
    focus: "#0b57d0",
  },
} as const;

function createDeckTheme(mode: DeckThemeMode) {
  const color = palettes[mode];
  return createTheme({
    palette: {
      mode,
      primary: {
        main: color.primary,
        contrastText: color.primaryText,
      },
      background: { default: color.bg, paper: color.surface },
      text: { primary: color.text, secondary: color.textDim },
      divider: color.line,
      success: { main: mode === "dark" ? "#5bb98c" : "#137a4b" },
      warning: { main: mode === "dark" ? "#e5b454" : "#9a620d" },
      error: { main: mode === "dark" ? "#f18494" : "#c43c55" },
      action: {
        hover: color.controlHover,
        selected: color.surface2,
        disabled: color.textFaint,
        disabledBackground: color.surfaceMuted,
      },
    },
    shape: { borderRadius: 6 },
    spacing: 4,
    typography: {
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      button: {
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: 0,
        textTransform: "none",
      },
      body1: { fontSize: 14, lineHeight: 1.5, letterSpacing: 0 },
      body2: { fontSize: 13, lineHeight: 1.5, letterSpacing: 0 },
      caption: { fontSize: 11, lineHeight: 1.45, letterSpacing: 0 },
      h6: { fontSize: 16, fontWeight: 600, lineHeight: 1.4, letterSpacing: 0 },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: {
          root: {
            minHeight: 36,
            borderRadius: 6,
            paddingInline: 14,
            boxShadow: "none",
            "&.MuiButton-contained.MuiButton-colorPrimary": {
              backgroundColor: color.primary,
              color: color.primaryText,
              "&:hover": {
                backgroundColor: color.primaryHover,
                boxShadow: "none",
              },
            },
          },
          contained: {
            boxShadow: "none",
            "&:hover": { boxShadow: "none" },
          },
          outlined: {
            borderColor: color.controlBorder,
            color: color.text,
            "&:hover": {
              borderColor: color.lineStrong,
              backgroundColor: color.controlHover,
            },
          },
        },
      },
      MuiIconButton: {
        defaultProps: { size: "small" },
        styleOverrides: {
          root: {
            width: 36,
            height: 36,
            borderRadius: 6,
            color: color.textDim,
            "&:hover": {
              backgroundColor: color.controlHover,
              color: color.text,
            },
            "& svg": { width: 17, height: 17, strokeWidth: 2 },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            maxHeight: "min(88dvh, 760px)",
            border: `1px solid ${color.line}`,
            borderRadius: 8,
            backgroundImage: "none",
            boxShadow:
              mode === "dark"
                ? "0 24px 72px rgb(0 0 0 / 52%)"
                : "0 24px 72px rgb(26 35 46 / 20%)",
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            display: "flex",
            minHeight: 52,
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "8px 12px 8px 20px",
            borderBottom: `1px solid ${color.line}`,
            fontSize: 16,
            fontWeight: 600,
          },
        },
      },
      MuiDialogContent: {
        styleOverrides: { root: { padding: "18px 20px 20px" } },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: {
            gap: 8,
            padding: "12px 20px 16px",
            borderTop: `1px solid ${color.line}`,
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            minHeight: 40,
            borderRadius: 6,
            backgroundColor: color.control,
            fontSize: 13,
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: color.controlBorder,
            },
            "&:hover .MuiOutlinedInput-notchedOutline": {
              borderColor: color.lineStrong,
            },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderWidth: 1,
              borderColor: color.focus,
              boxShadow: `0 0 0 3px ${mode === "dark" ? "rgb(138 180 248 / 18%)" : "rgb(11 87 208 / 14%)"}`,
            },
          },
          input: { padding: "10px 12px" },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: { color: color.textDim, fontSize: 13, letterSpacing: 0 },
        },
      },
      MuiFormHelperText: {
        styleOverrides: { root: { marginInline: 0, fontSize: 11 } },
      },
      MuiToggleButtonGroup: {
        styleOverrides: { root: { gap: 8 } },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            minWidth: 0,
            minHeight: 66,
            flex: 1,
            justifyContent: "flex-start",
            gap: 10,
            padding: "10px 12px",
            border: `1px solid ${color.line} !important`,
            borderRadius: "6px !important",
            backgroundColor: color.surfaceMuted,
            color: color.text,
            textAlign: "left",
            textTransform: "none",
            "&:hover": { backgroundColor: color.controlHover },
            "&.Mui-selected": {
              borderColor: `${color.focus} !important`,
              backgroundColor:
                mode === "dark"
                  ? "rgb(138 180 248 / 10%)"
                  : "rgb(11 87 208 / 8%)",
              color: color.text,
            },
            "&.Mui-selected:hover": {
              backgroundColor:
                mode === "dark"
                  ? "rgb(138 180 248 / 15%)"
                  : "rgb(11 87 208 / 12%)",
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: 4,
            backgroundColor: mode === "dark" ? "#e7e9ec" : "#30343a",
            color: mode === "dark" ? "#202124" : "#ffffff",
            fontSize: 11,
          },
        },
      },
    },
  });
}

function legacyVariables(mode: DeckThemeMode) {
  const color = palettes[mode];
  return {
    [`html[data-theme="${mode}"]`]: {
      "--bg": color.bg,
      "--sidebar": color.sidebar,
      "--surface": color.surface,
      "--surface-2": color.surface2,
      "--surface-muted": color.surfaceMuted,
      "--surface-raised": color.surfaceRaised,
      "--panel": color.surface,
      "--panel2": color.surface2,
      "--card": color.surface,
      "--control": color.control,
      "--control-hover": color.controlHover,
      "--control-border": color.controlBorder,
      "--line": color.line,
      "--line-strong": color.lineStrong,
      "--text": color.text,
      "--text-soft": color.textSoft,
      "--text-dim": color.textDim,
      "--text-faint": color.textFaint,
      "--muted": color.textDim,
      "--accent": color.primary,
      "--accent-text": color.primaryText,
      "--accent-hover": color.primaryHover,
      "--accent-active": color.primaryHover,
      "--focus-ring": color.focus,
      "--composer-fade": color.bg,
    },
  };
}

function currentMode(): DeckThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function DeckThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DeckThemeMode>(currentMode);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(currentMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const theme = useMemo(() => createDeckTheme(mode), [mode]);
  return (
    <ThemeProvider theme={theme}>
      <GlobalStyles styles={legacyVariables(mode)} />
      {children}
    </ThemeProvider>
  );
}
