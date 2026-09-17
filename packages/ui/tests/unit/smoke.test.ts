import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../../src/index";

describe("Button", () => {
  it("renders its label with token classes", () => {
    const html = renderToStaticMarkup(Button({ children: "Place RFQ" }));
    expect(html).toContain("Place RFQ");
    expect(html).toContain("bg-brand-600");
  });

  it("renders the secondary variant on request", () => {
    const html = renderToStaticMarkup(Button({ children: "Cancel", variant: "secondary" }));
    expect(html).toContain("border-brand-200");
  });
});
