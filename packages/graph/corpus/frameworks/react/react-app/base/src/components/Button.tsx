import { useContext } from "react";
import { ThemeContext } from "../context/theme";

type Props = { label: string; onClick: () => void };

export function Button({ label, onClick }: Props) {
  const theme = useContext(ThemeContext);
  return (
    <button className={theme} onClick={onClick}>
      {label}
    </button>
  );
}
