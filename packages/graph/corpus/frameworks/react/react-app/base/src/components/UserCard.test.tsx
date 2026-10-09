import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserCard } from "./UserCard";

describe("UserCard", () => {
  it("renders nothing before the user loads", () => {
    const { container } = render(<UserCard id="1" />);
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Save")).toBeNull();
  });
});
