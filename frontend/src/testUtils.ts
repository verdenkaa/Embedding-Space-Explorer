/**
 * Test utility: a minimal fetch mock with URL-pattern routing.
 * jsdom has no fetch; the API client only uses response.ok/status/json().
 *
 * Route values are either plain JSON bodies (served with 200) or explicit
 * specs built via mockResponse()/mockReject(). Matching: the request URL must
 * equal the pattern or start with it followed by "/" or "?"; the LONGEST
 * matching pattern wins (so "/api/projects/p1" beats "/api/projects").
 */

import { vi } from "vitest";

export interface MockResponseSpec {
  readonly __mock: true;
  readonly status: number;
  readonly body: unknown;
  readonly reject?: Error;
}

export function mockResponse(status: number, body: unknown): MockResponseSpec {
  return { __mock: true, status, body };
}

export function mockReject(error: Error): MockResponseSpec {
  return { __mock: true, status: 0, body: null, reject: error };
}

export type FetchMock = ReturnType<typeof vi.fn>;

export interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function isSpec(value: unknown): value is MockResponseSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __mock?: unknown }).__mock === true
  );
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  // Substring match; routes are pre-sorted longest-pattern-first, so the most
  // specific route wins (e.g. "/api/projects/p1/files" before "/api/projects").
  return url.includes(pattern);
}

export function mockFetch(routes: Record<string, unknown>): {
  fetchMock: FetchMock;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  // Pre-parse "METHOD pattern" keys and sort by pattern length (longest first).
  const parsed = Object.entries(routes)
    .map(([key, value]) => {
      const [maybeMethod, ...rest] = key.split(" ");
      const hasMethod = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(maybeMethod);
      return {
        method: hasMethod ? maybeMethod : null,
        pattern: hasMethod ? rest.join(" ") : key,
        value,
      };
    })
    .sort((a, b) => b.pattern.length - a.pattern.length);

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    });

    for (const route of parsed) {
      const methodMatches = route.method === null || route.method === method;
      if (!methodMatches || !urlMatchesPattern(url, route.pattern)) continue;

      const value = route.value;
      if (isSpec(value)) {
        if (value.reject) throw value.reject;
        return {
          ok: value.status >= 200 && value.status < 300,
          status: value.status,
          json: async () => value.body,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => value,
      } as unknown as Response;
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "not_found", message: `no mock route for ${url}` } }),
    } as unknown as Response;
  });

  return { fetchMock: fetchMock as FetchMock, calls };
}
