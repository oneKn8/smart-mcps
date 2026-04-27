# Smart-MCP Suite — Phase 0 (Bootstrap) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the `smart-mcps` monorepo with a complete `packages/core` library (auth, http, errors, confirm, fuzzy, server bootstrap), full unit tests for core, vitest tooling, and a multi-client install script — all green and committed.

**Architecture:** npm workspaces monorepo. Single `packages/core` shared library that every future MCP imports. TypeScript ESM, Node 22+, vitest for tests, msw for HTTP mocking, `@modelcontextprotocol/sdk` for MCP protocol, zod for schemas. No MCP server yet — that comes in Phase 1.

**Tech Stack:**
- Node 22.17 (already installed), npm 10.9 workspaces
- TypeScript 5.7 (ESM, NodeNext module resolution)
- `@modelcontextprotocol/sdk` ^1.12 (matches clickup-smart's version)
- `zod` ^3.24
- `vitest` ^2.1, `msw` ^2.6
- ESLint 9 + `@typescript-eslint`

**Reference design:** `docs/plans/2026-04-27-shifat-smart-mcps-design.md`

**Reference existing pattern:** `/home/oneknight/projects/tools/notion-smart-mcp/` (the working pattern we're extending into a monorepo)

**Target repo location:** `/home/oneknight/projects/tools/smart-mcps/` (the directory has been pre-created; everything else built from scratch)

---

## Pre-flight

Before starting Task 1, confirm:

```bash
cd /home/oneknight/projects/tools/smart-mcps && pwd
node --version  # expect v22.x
npm --version   # expect 10.x
ls -la          # expect empty or near-empty
git status      # if not a repo, init in Task 1
```

If anything fails, stop and report.

---

## Task 1: Initialize git repo + monorepo skeleton

**Files:**
- Create: `/home/oneknight/projects/tools/smart-mcps/.gitignore`
- Create: `/home/oneknight/projects/tools/smart-mcps/package.json`
- Create: `/home/oneknight/projects/tools/smart-mcps/tsconfig.base.json`
- Create: `/home/oneknight/projects/tools/smart-mcps/README.md`

**Step 1: Init git, create .gitignore**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git init -b main
```

Write `.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
coverage/
.vitest/
*.tsbuildinfo
```

**Step 2: Write root `package.json`**

```json
{
  "name": "smart-mcps",
  "version": "0.1.0",
  "private": true,
  "description": "Personal smart-MCP toolbelt monorepo (Vercel, GSC, GA, Hetzner, Coolify)",
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "clean": "rm -rf packages/*/dist packages/*/coverage packages/*/*.tsbuildinfo"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "msw": "^2.6.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0"
  }
}
```

**Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": false
  }
}
```

**Step 4: Write minimal `README.md`**

```markdown
# Smart-MCPs Monorepo

Personal smart-MCP toolbelt for Shifat. Five MCP servers in priority order:

1. `vercel-smart` — Vercel ops
2. `gsc-smart` — Google Search Console
3. `ga-smart` — Google Analytics 4
4. `hetzner-smart` — Hetzner Cloud
5. `coolify-smart` — self-hosted Coolify

See `docs/plans/2026-04-27-shifat-smart-mcps-design.md` for the full design.

## Build all
```
npm install
npm run build
npm test
```

## Install in MCP clients
```
./scripts/install-clients.sh
```
```

**Step 5: Verify and commit**

Run:
```bash
cd /home/oneknight/projects/tools/smart-mcps
ls -la
git add .gitignore package.json tsconfig.base.json README.md
git status -sb
git commit -m "chore: init smart-mcps monorepo skeleton"
```

Expected: 4 files committed, branch `main`, no errors.

---

## Task 2: Install root dev dependencies

**Files:**
- Modify (auto): `package-lock.json` (npm creates it)
- Modify (auto): `node_modules/`

**Step 1: Install**

```bash
cd /home/oneknight/projects/tools/smart-mcps
npm install
```

Expected: completes without error, creates `package-lock.json` and `node_modules/`. May warn about missing workspaces (we haven't created them yet) — that's OK.

**Step 2: Verify**

```bash
ls node_modules/typescript/package.json
ls node_modules/vitest/package.json
ls node_modules/msw/package.json
```

All three should exist.

**Step 3: Commit lockfile**

```bash
git add package-lock.json
git commit -m "chore: install root dev dependencies"
```

---

## Task 3: Scaffold packages/core

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`

**Step 1: Create directory tree**

```bash
mkdir -p packages/core/src/__tests__
```

**Step 2: Write `packages/core/package.json`**

```json
{
  "name": "smart-mcp-core",
  "version": "0.1.0",
  "description": "Shared core for smart-mcp servers (auth, http, errors, confirm, fuzzy, server bootstrap)",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "msw": "^2.6.0",
    "@types/node": "^22.0.0"
  }
}
```

**Step 3: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**", "node_modules", "dist"]
}
```

**Step 4: Write `packages/core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/index.ts"],
    },
  },
});
```

**Step 5: Write placeholder `packages/core/src/index.ts`**

```ts
// Public exports — populated as modules are added.
// Do not edit by hand; each module's task adds its own exports here.
export {};
```

**Step 6: Install workspace deps**

```bash
cd /home/oneknight/projects/tools/smart-mcps
npm install
```

Expected: npm sees the new workspace, links it, no errors.

**Step 7: Sanity check + commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
npm run typecheck --workspace=smart-mcp-core
git add packages/core/ package-lock.json
git status -sb
git commit -m "feat(core): scaffold packages/core workspace"
```

Expected: typecheck passes (empty index), commit succeeds.

---

## Task 4: Implement `errors.ts` (TDD)

The error taxonomy is the foundation of everything else; build it first.

**Files:**
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/__tests__/errors.test.ts`
- Modify: `packages/core/src/index.ts` (add exports)

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SmartMcpError,
  AuthError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  ConfirmRequiredError,
  UpstreamError,
  AmbiguousMatchError,
  toMcpResult,
} from "../errors.js";

describe("SmartMcpError", () => {
  it("base class carries name, message, recovery, detail", () => {
    const err = new SmartMcpError("base", "something broke", {
      recovery: "try again",
      detail: { foo: 1 },
    });
    expect(err.name).toBe("SmartMcpError");
    expect(err.code).toBe("base");
    expect(err.message).toBe("something broke");
    expect(err.recovery).toBe("try again");
    expect(err.detail).toEqual({ foo: 1 });
  });

  it("subclasses set their own code", () => {
    expect(new AuthError("x").code).toBe("AUTH");
    expect(new RateLimitError("x", { retryAfterSec: 30 }).code).toBe("RATE_LIMIT");
    expect(new NotFoundError("x").code).toBe("NOT_FOUND");
    expect(new ValidationError("x").code).toBe("VALIDATION");
    expect(new ConfirmRequiredError("x", { preview: "p" }).code).toBe("CONFIRM_REQUIRED");
    expect(new UpstreamError("x").code).toBe("UPSTREAM");
    expect(new AmbiguousMatchError("x", { candidates: [] }).code).toBe("AMBIGUOUS_MATCH");
  });

  it("RateLimitError exposes retryAfterSec", () => {
    const err = new RateLimitError("rate-limited", { retryAfterSec: 47 });
    expect(err.retryAfterSec).toBe(47);
  });

  it("ConfirmRequiredError exposes preview", () => {
    const err = new ConfirmRequiredError("confirm needed", { preview: "Will delete X" });
    expect(err.preview).toBe("Will delete X");
  });

  it("AmbiguousMatchError exposes candidates", () => {
    const err = new AmbiguousMatchError("multiple matches", {
      candidates: [{ score: 0.9, label: "alpha-site" }],
    });
    expect(err.candidates).toHaveLength(1);
  });
});

describe("toMcpResult", () => {
  it("formats SmartMcpError as MCP error result with rewritten leading line + raw detail", () => {
    const err = new AuthError("Vercel rejected the token", {
      recovery: "Check VERCEL_TOKEN is valid",
      detail: { upstream: "401: token_invalid" },
    });
    const result = toMcpResult(err);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Vercel rejected the token");
    expect(text).toContain("Check VERCEL_TOKEN is valid");
    expect(text).toContain("401: token_invalid");
    expect(text).toContain("AUTH");
  });

  it("wraps unknown errors as UPSTREAM", () => {
    const result = toMcpResult(new Error("totally unexpected"));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("UPSTREAM");
    expect(text).toContain("totally unexpected");
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd /home/oneknight/projects/tools/smart-mcps/packages/core
npm test
```

Expected: fails with module-not-found or similar (no `errors.ts` yet).

**Step 3: Implement `errors.ts`**

Create `packages/core/src/errors.ts`:

```ts
export type ErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFIRM_REQUIRED"
  | "UPSTREAM"
  | "AMBIGUOUS_MATCH"
  | string;

export type SmartMcpErrorOptions = {
  recovery?: string;
  detail?: unknown;
  cause?: unknown;
};

export class SmartMcpError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: string;
  readonly detail?: unknown;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts: SmartMcpErrorOptions = {}) {
    super(message);
    this.name = "SmartMcpError";
    this.code = code;
    this.recovery = opts.recovery;
    this.detail = opts.detail;
    this.cause = opts.cause;
  }
}

export class AuthError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("AUTH", message, opts);
    this.name = "AuthError";
  }
}

export class RateLimitError extends SmartMcpError {
  readonly retryAfterSec?: number;
  constructor(message: string, opts: SmartMcpErrorOptions & { retryAfterSec?: number } = {}) {
    super("RATE_LIMIT", message, opts);
    this.name = "RateLimitError";
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export class NotFoundError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("NOT_FOUND", message, opts);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("VALIDATION", message, opts);
    this.name = "ValidationError";
  }
}

export class ConfirmRequiredError extends SmartMcpError {
  readonly preview: string;
  constructor(message: string, opts: SmartMcpErrorOptions & { preview: string }) {
    super("CONFIRM_REQUIRED", message, opts);
    this.name = "ConfirmRequiredError";
    this.preview = opts.preview;
  }
}

export class UpstreamError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("UPSTREAM", message, opts);
    this.name = "UpstreamError";
  }
}

export type FuzzyCandidate = { score: number; label: string; id?: string };

export class AmbiguousMatchError extends SmartMcpError {
  readonly candidates: FuzzyCandidate[];
  constructor(message: string, opts: SmartMcpErrorOptions & { candidates: FuzzyCandidate[] }) {
    super("AMBIGUOUS_MATCH", message, opts);
    this.name = "AmbiguousMatchError";
    this.candidates = opts.candidates;
  }
}

export type McpToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export function toMcpResult(err: unknown): McpToolResult {
  const wrapped = err instanceof SmartMcpError
    ? err
    : new UpstreamError(err instanceof Error ? err.message : String(err), { cause: err });

  const lines: string[] = [`[${wrapped.code}] ${wrapped.message}`];
  if (wrapped.recovery) lines.push(`Hint: ${wrapped.recovery}`);
  if (wrapped instanceof ConfirmRequiredError) {
    lines.push(`Preview:\n${wrapped.preview}`);
  }
  if (wrapped instanceof AmbiguousMatchError && wrapped.candidates.length > 0) {
    lines.push(
      `Candidates:\n${wrapped.candidates
        .map(c => `  - ${c.label}${c.id ? ` (${c.id})` : ""} score=${c.score.toFixed(2)}`)
        .join("\n")}`,
    );
  }
  if (wrapped.detail !== undefined) {
    lines.push(`Detail: ${typeof wrapped.detail === "string" ? wrapped.detail : JSON.stringify(wrapped.detail)}`);
  }

  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
```

**Step 4: Update `packages/core/src/index.ts`**

Replace the placeholder with:

```ts
export * from "./errors.js";
```

**Step 5: Run test to verify it passes**

```bash
cd /home/oneknight/projects/tools/smart-mcps/packages/core
npm test
```

Expected: all tests pass.

**Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 7: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/errors.ts packages/core/src/__tests__/errors.test.ts packages/core/src/index.ts
git commit -m "feat(core): add error taxonomy with toMcpResult formatter"
```

---

## Task 5: Implement `confirm.ts` (TDD)

**Files:**
- Create: `packages/core/src/confirm.ts`
- Create: `packages/core/src/__tests__/confirm.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/confirm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { guardDestructive } from "../confirm.js";
import { ConfirmRequiredError } from "../errors.js";

describe("guardDestructive", () => {
  it("throws ConfirmRequiredError when confirm is false", () => {
    expect(() =>
      guardDestructive({ confirm: false, preview: "Will delete X" }),
    ).toThrowError(ConfirmRequiredError);
  });

  it("throws ConfirmRequiredError when confirm is undefined", () => {
    expect(() =>
      guardDestructive({ confirm: undefined as unknown as boolean, preview: "preview" }),
    ).toThrowError(ConfirmRequiredError);
  });

  it("includes preview in the thrown error", () => {
    try {
      guardDestructive({ confirm: false, preview: "Will delete env var FOO from project bar" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe("Will delete env var FOO from project bar");
    }
  });

  it("returns silently when confirm is true", () => {
    expect(() =>
      guardDestructive({ confirm: true, preview: "preview" }),
    ).not.toThrow();
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/oneknight/projects/tools/smart-mcps/packages/core
npm test -- confirm.test.ts
```

Expected: fail (no `confirm.ts` yet).

**Step 3: Implement `confirm.ts`**

```ts
import { ConfirmRequiredError } from "./errors.js";

export type GuardDestructiveOpts = {
  confirm: boolean;
  preview: string;
};

export function guardDestructive({ confirm, preview }: GuardDestructiveOpts): void {
  if (confirm !== true) {
    throw new ConfirmRequiredError(
      "Destructive operation requires confirm: true. Re-invoke with confirm: true to apply.",
      { preview },
    );
  }
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./confirm.js";
```

**Step 5: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all pass.

**Step 6: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/confirm.ts packages/core/src/__tests__/confirm.test.ts packages/core/src/index.ts
git commit -m "feat(core): add guardDestructive helper for confirm-gated ops"
```

---

## Task 6: Implement `fuzzy.ts` (TDD)

**Files:**
- Create: `packages/core/src/fuzzy.ts`
- Create: `packages/core/src/__tests__/fuzzy.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/fuzzy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fuzzyRank, resolveOne, type FuzzyMatch } from "../fuzzy.js";
import { AmbiguousMatchError, NotFoundError } from "../errors.js";

const items = [
  { id: "1", name: "alpha-site" },
  { id: "2", name: "alpha-marketing" },
  { id: "3", name: "alpha-staging" },
  { id: "4", name: "another-project" },
];

describe("fuzzyRank", () => {
  it("returns sorted matches by score desc", () => {
    const matches = fuzzyRank("alpha-s", items, i => i.name);
    expect(matches[0]?.item.name).toBe("alpha-site");
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("scores exact match at 1.0", () => {
    const matches = fuzzyRank("alpha-site", items, i => i.name);
    expect(matches[0]?.score).toBe(1);
  });

  it("scores totally unrelated below 0.5", () => {
    const matches = fuzzyRank("xyzzz", items, i => i.name);
    const top = matches[0];
    expect(top?.score).toBeLessThan(0.5);
  });
});

describe("resolveOne", () => {
  it("returns single item when score >= threshold", () => {
    const result = resolveOne("alpha-s", items, i => i.name, { threshold: 0.5 });
    expect(result.id).toBe("1");
  });

  it("throws AmbiguousMatchError when top score below threshold", () => {
    expect(() =>
      resolveOne("rhem", items, i => i.name, { threshold: 0.99 }),
    ).toThrowError(AmbiguousMatchError);
  });

  it("throws NotFoundError when no items", () => {
    expect(() =>
      resolveOne("anything", [], (i: { name: string }) => i.name),
    ).toThrowError(NotFoundError);
  });

  it("AmbiguousMatchError carries top 3 candidates", () => {
    try {
      resolveOne("rhem", items, i => i.name, { threshold: 0.99 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousMatchError);
      expect((err as AmbiguousMatchError).candidates.length).toBeLessThanOrEqual(3);
      expect((err as AmbiguousMatchError).candidates[0]).toMatchObject({
        label: expect.any(String),
        score: expect.any(Number),
      });
    }
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- fuzzy.test.ts
```

**Step 3: Implement `fuzzy.ts`**

```ts
import { AmbiguousMatchError, NotFoundError, type FuzzyCandidate } from "./errors.js";

export type FuzzyMatch<T> = { score: number; item: T };

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  extract: (item: T) => string,
): FuzzyMatch<T>[] {
  const q = query.toLowerCase();
  return items
    .map(item => ({
      item,
      score: similarity(q, extract(item).toLowerCase()),
    }))
    .sort((a, b) => b.score - a.score);
}

export type ResolveOneOpts = {
  threshold?: number; // default 0.9
  topN?: number;      // default 3, used in AmbiguousMatchError
  identify?: (item: unknown) => string | undefined;
};

export function resolveOne<T>(
  query: string,
  items: readonly T[],
  extract: (item: T) => string,
  opts: ResolveOneOpts = {},
): T {
  if (items.length === 0) {
    throw new NotFoundError(`No items to match against query: ${query}`);
  }

  const threshold = opts.threshold ?? 0.9;
  const topN = opts.topN ?? 3;
  const identify = opts.identify ?? (() => undefined);

  const ranked = fuzzyRank(query, items, extract);
  const top = ranked[0];

  if (!top) {
    throw new NotFoundError(`No items to match against query: ${query}`);
  }

  if (top.score >= threshold) {
    return top.item;
  }

  const candidates: FuzzyCandidate[] = ranked.slice(0, topN).map(m => ({
    score: m.score,
    label: extract(m.item),
    id: identify(m.item),
  }));

  throw new AmbiguousMatchError(
    `No confident match for "${query}" (top score ${top.score.toFixed(2)} below threshold ${threshold})`,
    { candidates },
  );
}

// Normalized Levenshtein-derived similarity in [0, 1].
// Exact match -> 1; totally different -> tends to 0.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  // Substring bonus: if query is a contiguous substring of candidate, boost.
  const substringBonus = b.includes(a) ? 0.15 : 0;
  return Math.min(1, 1 - dist / maxLen + substringBonus);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./confirm.js";
export * from "./fuzzy.js";
```

**Step 5: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all pass.

**Step 6: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/fuzzy.ts packages/core/src/__tests__/fuzzy.test.ts packages/core/src/index.ts
git commit -m "feat(core): add fuzzyRank + resolveOne for smart-name resolution"
```

---

## Task 7: Implement `auth.ts` (TDD)

**Files:**
- Create: `packages/core/src/auth.ts`
- Create: `packages/core/src/__tests__/auth.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCreds } from "../auth.js";
import { AuthError } from "../errors.js";

let tmpRoot: string;
let cfgPath: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `smart-mcp-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpRoot, { recursive: true });
  cfgPath = join(tmpRoot, "test-mcp.json");
  delete process.env.TEST_KEY;
  delete process.env.TEST_OPTIONAL;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadCreds", () => {
  it("loads from env when env present", () => {
    process.env.TEST_KEY = "env-value";
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("env-value");
  });

  it("falls back to config file when env missing", () => {
    writeFileSync(cfgPath, JSON.stringify({ TEST_KEY: "file-value" }));
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("file-value");
  });

  it("env wins over config file", () => {
    process.env.TEST_KEY = "from-env";
    writeFileSync(cfgPath, JSON.stringify({ TEST_KEY: "from-file" }));
    const creds = loadCreds<{ TEST_KEY: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_KEY).toBe("from-env");
  });

  it("throws AuthError listing missing required keys", () => {
    try {
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: [cfgPath],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("TEST_KEY");
      expect((err as AuthError).message).toContain("test-mcp");
    }
  });

  it("returns optional keys when present, omits when missing", () => {
    process.env.TEST_KEY = "x";
    process.env.TEST_OPTIONAL = "opt";
    const creds = loadCreds<{ TEST_KEY: string; TEST_OPTIONAL?: string }>({
      serviceName: "test-mcp",
      required: ["TEST_KEY"],
      optional: ["TEST_OPTIONAL"],
      configPaths: [cfgPath],
    });
    expect(creds.TEST_OPTIONAL).toBe("opt");
  });

  it("missing optional keys do not throw", () => {
    process.env.TEST_KEY = "x";
    expect(() =>
      loadCreds<{ TEST_KEY: string; TEST_OPTIONAL?: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        optional: ["TEST_OPTIONAL"],
        configPaths: [cfgPath],
      }),
    ).not.toThrow();
  });

  it("ignores nonexistent config paths gracefully", () => {
    process.env.TEST_KEY = "x";
    expect(() =>
      loadCreds<{ TEST_KEY: string }>({
        serviceName: "test-mcp",
        required: ["TEST_KEY"],
        configPaths: ["/nonexistent/path.json", cfgPath],
      }),
    ).not.toThrow();
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- auth.test.ts
```

**Step 3: Implement `auth.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { AuthError } from "./errors.js";

export type LoadCredsOpts<T extends Record<string, string>> = {
  serviceName: string;
  required: ReadonlyArray<keyof T>;
  optional?: ReadonlyArray<keyof T>;
  configPaths?: string[];
};

export function loadCreds<T extends Record<string, string>>(
  opts: LoadCredsOpts<T>,
): T {
  const { serviceName, required, optional = [] } = opts;
  const configPaths = (opts.configPaths ?? defaultConfigPaths(serviceName)).map(expandHome);
  const fromFile = readFirstConfig(configPaths);

  const result: Partial<Record<keyof T, string>> = {};
  const missing: string[] = [];

  for (const key of required) {
    const value = process.env[key as string] ?? fromFile[key as string];
    if (value === undefined || value === "") {
      missing.push(key as string);
    } else {
      result[key] = value;
    }
  }

  for (const key of optional) {
    const value = process.env[key as string] ?? fromFile[key as string];
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new AuthError(
      `Missing required credentials for ${serviceName}: ${missing.join(", ")}`,
      {
        recovery: `Set as env vars or add to a config file at one of: ${configPaths.join(", ")}`,
        detail: { missing, serviceName, configPaths },
      },
    );
  }

  return result as T;
}

function defaultConfigPaths(serviceName: string): string[] {
  return [
    `~/.config/${serviceName}.json`,
    `~/.config/codex/${serviceName}.json`,
    `~/.${serviceName}.json`,
  ];
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homedir());
  return path;
}

function readFirstConfig(paths: string[]): Record<string, string> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, string>;
      }
    } catch {
      // Malformed file → skip silently; missing-required will throw later if needed.
    }
  }
  return {};
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./confirm.js";
export * from "./fuzzy.js";
export * from "./auth.js";
```

**Step 5: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all pass (8+ tests for auth).

**Step 6: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts packages/core/src/index.ts
git commit -m "feat(core): add loadCreds multi-source credential loader"
```

---

## Task 8: Implement `http.ts` (TDD with msw)

**Files:**
- Create: `packages/core/src/http.ts`
- Create: `packages/core/src/__tests__/http.test.ts`
- Create: `packages/core/src/__tests__/test-helpers.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/test-helpers.ts`:

```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export function makeServer() {
  return setupServer();
}

export { http, HttpResponse };
```

Create `packages/core/src/__tests__/http.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { makeServer, http, HttpResponse } from "./test-helpers.js";
import { fetchJson } from "../http.js";
import { AuthError, NotFoundError, RateLimitError, UpstreamError, ValidationError } from "../errors.js";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("fetchJson — happy path", () => {
  it("returns parsed JSON on 200", async () => {
    server.use(
      http.get("https://api.test/items", () =>
        HttpResponse.json({ items: [{ id: 1 }] }),
      ),
    );
    const result = await fetchJson<{ items: { id: number }[] }>("https://api.test/items");
    expect(result.items[0]?.id).toBe(1);
  });

  it("injects bearer auth header from token option", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://api.test/x", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      }),
    );
    await fetchJson("https://api.test/x", { token: "tkn_123" });
    expect(seenAuth).toBe("Bearer tkn_123");
  });
});

describe("fetchJson — error mapping", () => {
  it("throws AuthError on 401", async () => {
    server.use(
      http.get("https://api.test/auth", () =>
        HttpResponse.json({ error: "bad token" }, { status: 401 }),
      ),
    );
    await expect(fetchJson("https://api.test/auth")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError on 403", async () => {
    server.use(
      http.get("https://api.test/forbidden", () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );
    await expect(fetchJson("https://api.test/forbidden")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws NotFoundError on 404", async () => {
    server.use(
      http.get("https://api.test/missing", () =>
        HttpResponse.json({ error: "missing" }, { status: 404 }),
      ),
    );
    await expect(fetchJson("https://api.test/missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError on 400", async () => {
    server.use(
      http.get("https://api.test/bad", () =>
        HttpResponse.json({ error: "bad input" }, { status: 400 }),
      ),
    );
    await expect(fetchJson("https://api.test/bad")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws RateLimitError on 429 with retryAfter parsed", async () => {
    server.use(
      http.get("https://api.test/rate", () =>
        new HttpResponse(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "47", "content-type": "application/json" },
        }),
      ),
    );
    try {
      await fetchJson("https://api.test/rate", { retries: 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSec).toBe(47);
    }
  });
});

describe("fetchJson — retries", () => {
  it("retries 5xx up to retries count, then throws UpstreamError", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.test/flaky", () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 503 });
      }),
    );
    await expect(
      fetchJson("https://api.test/flaky", { retries: 2, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("succeeds on retry after transient 503", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.test/transient", () => {
        calls++;
        if (calls < 2) return HttpResponse.json({ error: "boom" }, { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await fetchJson<{ ok: boolean }>("https://api.test/transient", {
      retries: 2,
      baseDelayMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/oneknight/projects/tools/smart-mcps/packages/core
npm test -- http.test.ts
```

**Step 3: Implement `http.ts`**

```ts
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

export type FetchJsonOpts = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;             // bearer token; if set, adds Authorization header
  timeoutMs?: number;         // default 30_000
  retries?: number;           // default 3 — applies to 429/5xx only
  baseDelayMs?: number;       // default 250 — exponential: base * 2^attempt
  searchParams?: Record<string, string | number | boolean | undefined>;
};

const DEBUG = process.env.DEBUG === "1";

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    token,
    timeoutMs = 30_000,
    retries = 3,
    baseDelayMs = 250,
    searchParams,
  } = opts;

  const finalUrl = appendSearch(url, searchParams);
  const finalHeaders: Record<string, string> = {
    accept: "application/json",
    ...headers,
  };
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders["content-type"] = "application/json";

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await doFetch({
        url: finalUrl,
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs,
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const errOut = await mapErrorResponse(response, finalUrl, method);

      // Retry only on 429 and 5xx
      const retriable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retriable && attempt < retries) {
        lastErr = errOut;
        const delay = computeDelay(errOut, baseDelayMs, attempt);
        if (DEBUG) console.error(`[smart-mcp-core] retry ${attempt + 1}/${retries} after ${delay}ms (${response.status})`);
        await sleep(delay);
        continue;
      }
      throw errOut;
    } catch (err) {
      if (err instanceof AuthError ||
          err instanceof NotFoundError ||
          err instanceof ValidationError ||
          err instanceof RateLimitError ||
          err instanceof UpstreamError) {
        if (attempt === retries) throw err;
        if (err instanceof AuthError || err instanceof NotFoundError || err instanceof ValidationError) {
          throw err; // non-retriable
        }
        lastErr = err;
        await sleep(computeDelay(err, baseDelayMs, attempt));
        continue;
      }
      // Network / abort / unknown — wrap and retry
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === retries) {
        throw new UpstreamError(`Network failure: ${lastErr.message}`, { cause: err });
      }
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastErr ?? new UpstreamError("Exhausted retries with no error");
}

async function doFetch(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    if (DEBUG) console.error(`[smart-mcp-core] ${opts.method} ${opts.url}`);
    return await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mapErrorResponse(response: Response, url: string, method: string): Promise<Error> {
  const detail = await safeReadDetail(response);
  const message = `${method} ${url} → ${response.status}`;
  switch (response.status) {
    case 400:
      return new ValidationError(message, { detail });
    case 401:
    case 403:
      return new AuthError(message, { detail });
    case 404:
      return new NotFoundError(message, { detail });
    case 429: {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSec = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
      return new RateLimitError(message, {
        detail,
        retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      });
    }
    default:
      return new UpstreamError(message, { detail });
  }
}

async function safeReadDetail(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function appendSearch(
  url: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function computeDelay(err: Error, baseDelayMs: number, attempt: number): number {
  if (err instanceof RateLimitError && err.retryAfterSec) {
    return err.retryAfterSec * 1000;
  }
  return baseDelayMs * Math.pow(2, attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./confirm.js";
export * from "./fuzzy.js";
export * from "./auth.js";
export * from "./http.js";
```

**Step 5: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all tests pass.

**Step 6: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/http.ts packages/core/src/__tests__/http.test.ts packages/core/src/__tests__/test-helpers.ts packages/core/src/index.ts
git commit -m "feat(core): add fetchJson with retries, auth injection, error mapping"
```

---

## Task 9: Implement `server.ts` — `createMcpServer` bootstrap (TDD)

**Files:**
- Create: `packages/core/src/server.ts`
- Create: `packages/core/src/__tests__/server.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/server.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool, runToolSafely, type ToolDefinition } from "../server.js";
import { AuthError, NotFoundError } from "../errors.js";

describe("defineTool", () => {
  it("returns a tool definition with name, description, schema, handler", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echo input",
      inputSchema: z.object({ msg: z.string() }),
      handler: async ({ msg }) => ({ echoed: msg }),
    });
    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echo input");
    expect(typeof tool.handler).toBe("function");
  });
});

describe("runToolSafely", () => {
  const echoTool = defineTool({
    name: "echo",
    description: "Echo input",
    inputSchema: z.object({ msg: z.string() }),
    handler: async ({ msg }) => ({ echoed: msg }),
  });

  it("returns success result with stringified JSON content", async () => {
    const result = await runToolSafely(echoTool, { msg: "hi" }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("echoed");
    expect(text).toContain("hi");
  });

  it("returns error result when input fails zod validation", async () => {
    const result = await runToolSafely(echoTool, { wrong: "x" }, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("VALIDATION");
  });

  it("propagates SmartMcpError from handler", async () => {
    const tool = defineTool({
      name: "fail",
      description: "Always fails",
      inputSchema: z.object({}),
      handler: async () => {
        throw new AuthError("Bad token", { recovery: "Set token" });
      },
    });
    const result = await runToolSafely(tool, {}, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("AUTH");
    expect(text).toContain("Bad token");
    expect(text).toContain("Set token");
  });

  it("wraps unknown errors as UPSTREAM", async () => {
    const tool = defineTool({
      name: "boom",
      description: "Throws unknown",
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    const result = await runToolSafely(tool, {}, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("UPSTREAM");
    expect(text).toContain("kaboom");
  });

  it("passes context to handler", async () => {
    const handler = vi.fn(async (input: { x: number }, ctx: { multiplier: number }) => ({
      result: input.x * ctx.multiplier,
    }));
    const tool = defineTool({
      name: "mul",
      description: "Multiply",
      inputSchema: z.object({ x: z.number() }),
      handler,
    });
    const result = await runToolSafely(tool, { x: 3 }, { multiplier: 5 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("15");
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- server.test.ts
```

**Step 3: Implement `server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { ValidationError, toMcpResult, type McpToolResult } from "./errors.js";

export type ToolDefinition<Input = unknown, Output = unknown, Context = unknown> = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  handler: (input: Input, context: Context) => Promise<Output>;
};

export function defineTool<Input, Output, Context = unknown>(
  def: Omit<ToolDefinition<Input, Output, Context>, "inputSchema"> & {
    inputSchema: z.ZodType<Input>;
  },
): ToolDefinition<Input, Output, Context> {
  return def as ToolDefinition<Input, Output, Context>;
}

export async function runToolSafely<Input, Output, Context>(
  tool: ToolDefinition<Input, Output, Context>,
  rawInput: unknown,
  context: Context,
): Promise<McpToolResult> {
  let parsed: Input;
  try {
    parsed = tool.inputSchema.parse(rawInput) as Input;
  } catch (err) {
    return toMcpResult(
      new ValidationError(
        `Invalid input for tool ${tool.name}`,
        { detail: err instanceof z.ZodError ? err.flatten() : String(err) },
      ),
    );
  }
  try {
    const result = await tool.handler(parsed, context);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return toMcpResult(err);
  }
}

export type CreateMcpServerOpts<Context> = {
  name: string;
  version: string;
  tools: ToolDefinition<unknown, unknown, Context>[];
  context: Context;
};

export async function createMcpServer<Context>(
  opts: CreateMcpServerOpts<Context>,
): Promise<void> {
  const { name, version, tools, context } = opts;
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  const toolsByName = new Map(tools.map(t => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return toMcpResult(
        new ValidationError(`Unknown tool: ${request.params.name}`, {
          detail: { available: [...toolsByName.keys()] },
        }),
      );
    }
    return runToolSafely(tool, request.params.arguments ?? {}, context);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Minimal zod -> JSON Schema converter (handles the common shapes we use:
// objects, strings, numbers, booleans, arrays, optionals, defaults, enums).
// For exotic schemas, write the JSON Schema by hand and pass via a wrapper.
function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const typeName = def.typeName;

  if (typeName === "ZodObject") {
    const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      const innerDef = (value as unknown as { _def: { typeName: string } })._def;
      if (innerDef.typeName !== "ZodOptional" && innerDef.typeName !== "ZodDefault") {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodArray") {
    const inner = (schema as unknown as { _def: { type: ZodTypeAny } })._def.type;
    return { type: "array", items: zodToJsonSchema(inner) };
  }
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    const inner = (schema as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
    return zodToJsonSchema(inner);
  }
  if (typeName === "ZodEnum") {
    const values = (schema as unknown as { _def: { values: string[] } })._def.values;
    return { type: "string", enum: values };
  }
  if (typeName === "ZodLiteral") {
    const value = (schema as unknown as { _def: { value: unknown } })._def.value;
    return { const: value };
  }
  // Fallback — expose nothing useful but don't blow up
  return {};
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./confirm.js";
export * from "./fuzzy.js";
export * from "./auth.js";
export * from "./http.js";
export * from "./server.js";
```

**Step 5: Run tests + typecheck + build**

```bash
cd /home/oneknight/projects/tools/smart-mcps/packages/core
npm test
npm run typecheck
npm run build
```

Expected: tests pass, typecheck clean, `dist/` populated with `.js` + `.d.ts` files for every src module.

**Step 6: Verify build output**

```bash
ls dist/
# Expected files: errors.js, confirm.js, fuzzy.js, auth.js, http.js, server.js, index.js, plus .d.ts companions
```

**Step 7: Commit**

```bash
cd /home/oneknight/projects/tools/smart-mcps
git add packages/core/src/server.ts packages/core/src/__tests__/server.test.ts packages/core/src/index.ts
git commit -m "feat(core): add createMcpServer bootstrap with defineTool + runToolSafely"
```

---

## Task 10: Write `scripts/install-clients.sh` (multi-client config writer)

**Files:**
- Create: `packages/core/scripts/install-clients.sh` (referenced from each MCP's `scripts/install.sh` later)

Wait — re-reading the design, this script lives at the monorepo root, not in core.

**Files:**
- Create: `scripts/install-clients.sh` (monorepo root)

**Step 1: Write the script**

```bash
mkdir -p /home/oneknight/projects/tools/smart-mcps/scripts
```

Create `scripts/install-clients.sh`:

```bash
#!/usr/bin/env bash
# install-clients.sh — register built smart-mcps into all known MCP clients
# on this machine (Claude Code, Codex, Cursor).
#
# Usage:
#   ./scripts/install-clients.sh                  # registers every built MCP
#   ./scripts/install-clients.sh vercel-smart     # registers a single MCP
#
# Idempotent. Safe to re-run. Writes a backup of each modified config file
# under ~/.config/smart-mcps-backups/ before mutating it.

set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/.config/smart-mcps-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Discover built MCPs (any packages/*/dist/server.js)
discover_mcps() {
  local filter="${1:-}"
  for pkg in "$MONOREPO_ROOT"/packages/*/; do
    local name
    name=$(basename "$pkg")
    [[ "$name" == "core" ]] && continue
    [[ -n "$filter" && "$name" != "$filter" ]] && continue
    if [[ -f "$pkg/dist/server.js" ]]; then
      echo "$name|$pkg/dist/server.js"
    fi
  done
}

# Update Claude Code config (~/.claude.json)
update_claude_code() {
  local cfg="${HOME}/.claude.json"
  [[ ! -f "$cfg" ]] && { echo "  Claude Code config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/claude.json"

  local tmp
  tmp=$(mktemp)

  python3 - "$cfg" "$tmp" "$@" <<'PY'
import json, sys
cfg_path, tmp_path, *entries = sys.argv[1:]
with open(cfg_path) as f:
    data = json.load(f)
servers = data.setdefault("mcpServers", {})
for entry in entries:
    name, path = entry.split("|", 1)
    servers[name] = {"command": "node", "args": [path]}
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
PY

  mv "$tmp" "$cfg"
  echo "  Claude Code: updated $cfg"
}

# Update Codex config
update_codex() {
  local cfg="${HOME}/.codex/config.toml"
  [[ ! -f "$cfg" ]] && { echo "  Codex config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/codex-config.toml"
  echo "  Codex: manual step required — add to $cfg under [mcp_servers] (printed below)"
  for entry in "$@"; do
    local name path
    name="${entry%%|*}"
    path="${entry#*|}"
    cat <<EOF

[mcp_servers.$name]
command = "node"
args = ["$path"]
EOF
  done
}

# Update Cursor config
update_cursor() {
  local cfg="${HOME}/.cursor/mcp.json"
  [[ ! -f "$cfg" ]] && { echo "  Cursor config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/cursor-mcp.json"

  local tmp
  tmp=$(mktemp)

  python3 - "$cfg" "$tmp" "$@" <<'PY'
import json, sys
cfg_path, tmp_path, *entries = sys.argv[1:]
with open(cfg_path) as f:
    data = json.load(f)
servers = data.setdefault("mcpServers", {})
for entry in entries:
    name, path = entry.split("|", 1)
    servers[name] = {"command": "node", "args": [path]}
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
PY

  mv "$tmp" "$cfg"
  echo "  Cursor: updated $cfg"
}

main() {
  local filter="${1:-}"
  local entries=()
  while IFS= read -r line; do
    entries+=("$line")
  done < <(discover_mcps "$filter")

  if [[ ${#entries[@]} -eq 0 ]]; then
    echo "No built MCPs found (looked for packages/*/dist/server.js)."
    echo "Run 'npm run build' first."
    exit 1
  fi

  echo "Installing ${#entries[@]} MCP(s):"
  for entry in "${entries[@]}"; do
    echo "  - ${entry%%|*}"
  done
  echo "Backups saved to: $BACKUP_DIR"
  echo ""

  echo "Claude Code:"
  update_claude_code "${entries[@]}"
  echo ""
  echo "Codex:"
  update_codex "${entries[@]}"
  echo ""
  echo "Cursor:"
  update_cursor "${entries[@]}"
  echo ""
  echo "Done."
}

main "$@"
```

**Step 2: Make executable**

```bash
chmod +x /home/oneknight/projects/tools/smart-mcps/scripts/install-clients.sh
```

**Step 3: Sanity check (no MCPs built yet, expect graceful exit)**

```bash
cd /home/oneknight/projects/tools/smart-mcps
./scripts/install-clients.sh 2>&1 || true
```

Expected: prints "No built MCPs found" and exits 1.

**Step 4: Commit**

```bash
git add scripts/install-clients.sh
git commit -m "chore: add install-clients.sh for multi-MCP-client config registration"
```

---

## Task 11: Verify full Phase 0 build + test green

**Step 1: Full clean build**

```bash
cd /home/oneknight/projects/tools/smart-mcps
npm run clean
npm install
npm run build
```

Expected: builds without error.

**Step 2: Full test run**

```bash
npm test
```

Expected: all tests across all workspaces pass (currently just `core` — expect ~30+ tests across 5 test files).

**Step 3: Full typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 4: Sanity check the dist output**

```bash
ls packages/core/dist/
# Expected: errors.js, errors.d.ts, confirm.js, confirm.d.ts, fuzzy.js, fuzzy.d.ts,
#           auth.js, auth.d.ts, http.js, http.d.ts, server.js, server.d.ts,
#           index.js, index.d.ts (plus .map files)
```

**Step 5: Commit any final cleanups (likely none)**

```bash
git status -sb
# If anything changed, add + commit. Otherwise skip.
```

**Step 6: Tag the milestone**

```bash
git tag -a phase-0-bootstrap -m "Phase 0 bootstrap complete: monorepo + packages/core with full test coverage"
```

---

## Phase 0 Done When

All of the following are true:

- [ ] Monorepo at `/home/oneknight/projects/tools/smart-mcps/` is a git repo on `main`
- [ ] `packages/core` builds cleanly (`dist/` populated)
- [ ] `npm test` passes across the monorepo (target ~30+ tests in core)
- [ ] `npm run typecheck` passes
- [ ] `scripts/install-clients.sh` exists, is executable, and exits cleanly when no MCPs are built
- [ ] Git history shows ~10 small, conventional-commits commits, one per task
- [ ] Tag `phase-0-bootstrap` exists at the latest commit

---

## Out of Scope (Phase 1+)

- Any actual MCP server (`vercel-smart` etc.) — Phase 1
- Vercel API client — Phase 1
- Tool implementations — Phase 1
- Smoke tests against real APIs — Phase 1
- README per MCP — Phase 1
- Schema-lint script — deferred until at least one MCP exists

---

## Skills to Reference During Execution

- @superpowers:test-driven-development — every implementation task in Phase 0 uses TDD; do not skip the failing-test step
- @superpowers:verification-before-completion — run the Phase 0 Done checklist before marking the plan complete
- @superpowers:systematic-debugging — if a test fails unexpectedly during execution, use this before patching

---

## Notes for the Executor

1. **Do not skip TDD steps.** Even the small modules (confirm, fuzzy) start with a failing test. That's the contract.
2. **Commit after every task.** Don't batch. Smaller blast radius if something needs reverting.
3. **If any test reveals an ambiguity in this plan**, stop and surface it rather than guessing. The design doc at `docs/2026-04-27-design.md` is the source of truth.
4. **Node 22+ required.** Don't fall back to older Node features like CommonJS — this is ESM throughout.
5. **The `zodToJsonSchema` function in `server.ts` is intentionally minimal.** It handles the common shapes we use. If a future tool needs an exotic shape (unions, intersections, transforms), extend the function rather than working around it.
