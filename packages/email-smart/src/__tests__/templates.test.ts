import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotFoundError, ValidationError } from "smart-mcp-core";
import {
  loadTemplate,
  renderTemplate,
  deriveTextFromHtml,
} from "../templates.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-tpl-test-"));
}

function writeTemplate(home: string, name: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "templates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), body);
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("loadTemplate", () => {
  it("reads a template file from <home>/.santo-agent/templates/<name>.html", () => {
    const body = "<p>hello {{NAME}}</p>";
    writeTemplate(tmpHome, "email-base", body);
    expect(loadTemplate("email-base", tmpHome)).toBe(body);
  });

  it("throws NotFoundError when the template file is missing", () => {
    expect(() => loadTemplate("missing-tpl", tmpHome)).toThrow(NotFoundError);
  });

  it("throws NotFoundError carrying the template name and resolved path", () => {
    const expectedPath = path.join(
      tmpHome,
      ".santo-agent",
      "templates",
      "missing-tpl.html",
    );
    try {
      loadTemplate("missing-tpl", tmpHome);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toContain("missing-tpl");
      expect((err as Error).message).toContain(expectedPath);
    }
  });

  it("falls back to process.env.HOME when no home arg is passed", () => {
    writeTemplate(tmpHome, "email-base", "<x/>");
    expect(loadTemplate("email-base")).toBe("<x/>");
  });
});

describe("renderTemplate", () => {
  it("replaces a single {{KEY}} occurrence with its value", () => {
    expect(renderTemplate("hello {{NAME}}", { NAME: "Alice" })).toBe(
      "hello Alice",
    );
  });

  it("replaces multiple distinct keys", () => {
    expect(
      renderTemplate("{{GREETING}} {{NAME}}!", {
        GREETING: "Hi",
        NAME: "Bob",
      }),
    ).toBe("Hi Bob!");
  });

  it("replaces multiple occurrences of the same key", () => {
    expect(
      renderTemplate("{{X}} and {{X}} again", { X: "yes" }),
    ).toBe("yes and yes again");
  });

  it("throws ValidationError naming the key when template has {{X}} but vars lacks X", () => {
    try {
      renderTemplate("hello {{NAME}}", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("NAME");
    }
  });

  it("ignores vars keys not referenced in template (no error)", () => {
    expect(
      renderTemplate("hello {{NAME}}", { NAME: "Alice", UNUSED: "ok" }),
    ).toBe("hello Alice");
  });

  it("does NOT recurse: substituted value containing {{Y}} is left as-is", () => {
    expect(
      renderTemplate("body: {{X}}", { X: "{{Y}}" }),
    ).toBe("body: {{Y}}");
  });

  it("supports underscores and digits in key names", () => {
    expect(
      renderTemplate("{{BODY_HTML_2}}", { BODY_HTML_2: "abc" }),
    ).toBe("abc");
  });
});

describe("deriveTextFromHtml", () => {
  it("strips simple tags", () => {
    expect(deriveTextFromHtml("<p>hello world</p>")).toBe("hello world");
  });

  it("decodes &amp; to &", () => {
    expect(deriveTextFromHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("decodes other common entities", () => {
    const input = "&lt;a&gt;&nbsp;&quot;x&quot;&#39;y";
    const out = deriveTextFromHtml(input);
    expect(out).toContain("<a>");
    expect(out).toContain('"x"');
    expect(out).toContain("'y");
  });

  it("treats <br> as a newline", () => {
    expect(deriveTextFromHtml("a<br>b")).toBe("a\nb");
  });

  it("treats <br/> and <br /> as newlines too", () => {
    expect(deriveTextFromHtml("a<br/>b<br />c")).toBe("a\nb\nc");
  });

  it("treats paragraph and div boundaries as paragraph breaks", () => {
    const out = deriveTextFromHtml("<p>one</p><p>two</p>");
    expect(out).toContain("one");
    expect(out).toContain("two");
    // paragraph break separator
    expect(out).toMatch(/one\s+two/);
  });

  it("returns an empty string for empty input", () => {
    expect(deriveTextFromHtml("")).toBe("");
  });

  it("trims leading and trailing whitespace", () => {
    expect(deriveTextFromHtml("   <p>x</p>   ")).toBe("x");
  });
});
