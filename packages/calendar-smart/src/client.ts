// Note: GoogleOAuthClient lives in `smart-mcp-core` after Phase 5 task 2.
// Task 1 keeps the OAuth wiring deferred so the scaffold builds standalone
// without depending on the not-yet-lifted class. Task 4 fleshes out methods
// (listEvents, ensureTimeZone, etc.) and at that point the constructor
// switches to eagerly building the OAuth client.

const CALENDAR_TOKEN_FILE_SUFFIX = ".calendar.json";
const CALENDAR_REQUIRED_SCOPE = "https://www.googleapis.com/auth/calendar";

export type CalendarClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth client
   * (built in Phase 5 task 2/4) resolves `process.env.HOME` lazily on first
   * use. Tests pass a tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the client
   * builds one against the standard token-jar layout when methods land.
   */
  oauthClient?: unknown;
};

/**
 * REST client for Google Calendar API v3. Constructor is side-effect-free —
 * no token files are read until the first method call. Time zone is
 * auto-detected from the primary calendar on first use and cached in memory
 * for the lifetime of this process.
 *
 * Methods are added in subsequent Phase 5 tasks (4 onwards). Phase 5 task 1
 * ships only the constructor skeleton plus account / cached-tz getters so
 * downstream context wiring and tests can compile.
 */
export class CalendarClient {
  // tslint:disable-next-line: typedef — kept for future task 2/4 use.
  static readonly TOKEN_FILE_SUFFIX = CALENDAR_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = CALENDAR_REQUIRED_SCOPE;

  private readonly account: string;
  // OAuth client is built lazily; stored opts feed the constructor in task 4.
  private readonly opts: CalendarClientOpts;
  private cachedTimeZone: string | undefined;

  constructor(account: string, opts: CalendarClientOpts = {}) {
    this.account = account;
    this.opts = opts;
  }

  /**
   * Account identifier this client is bound to. Mirrors the basename of the
   * token file under `~/.santo-agent/oauth/`. Read-only — used by tools that
   * surface the account in error messages.
   */
  getAccount(): string {
    return this.account;
  }

  /**
   * Cached time zone IANA identifier (e.g. `"America/Chicago"`) sourced from
   * the primary calendar. `undefined` until the first tool call resolves it.
   */
  getCachedTimeZone(): string | undefined {
    return this.cachedTimeZone;
  }

  /**
   * Test seam: the constructor opts are stashed so later tasks can promote
   * them into a live `GoogleOAuthClient`. Exposed read-only here for unit
   * tests that want to assert the home/oauthClient overrides round-trip.
   */
  getOpts(): Readonly<CalendarClientOpts> {
    return this.opts;
  }
}
