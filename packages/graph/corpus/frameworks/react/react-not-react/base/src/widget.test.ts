import { describe, expect, it } from "vitest";
import { render } from "./render";
import { Widget } from "./widget";

describe("Widget", () => {
  it("renders its text", () => {
    expect(render(new Widget().render())).toBe("widget");
  });
});
