import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoDataBanner } from "../../src/index";

describe("DemoDataBanner", () => {
  it("renders the shared demo copy by default", () => {
    const html = renderToStaticMarkup(DemoDataBanner({}));
    expect(html).toContain("Demo data — fictional");
  });

  it("renders custom copy via props", () => {
    const html = renderToStaticMarkup(
      DemoDataBanner({ message: "Demo data — fictional (staging snapshot)" }),
    );
    expect(html).toContain("staging snapshot");
  });

  it("renders optional extra content as children", () => {
    const html = renderToStaticMarkup(DemoDataBanner({ children: "Learn more" }));
    expect(html).toContain("Learn more");
  });

  it("exposes the banner to assistive tech as a note", () => {
    const html = renderToStaticMarkup(DemoDataBanner({}));
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="Demo data notice"');
  });
});
