import { Shell } from "./components/Shell";
import { ThemeProvider } from "./context/theme";

export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
