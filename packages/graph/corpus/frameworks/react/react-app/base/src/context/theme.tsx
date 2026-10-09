import { createContext } from "react";
import type { ReactNode } from "react";

export const ThemeContext = createContext("light");

export function ThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>;
}
