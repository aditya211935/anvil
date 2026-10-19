import { describe, expect, it } from "vitest";
import {
  baseWithoutUserinfo,
  headWithoutUserinfo,
  normalizeSchemeSlashes,
  urlWithoutUserinfo,
} from "./url-userinfo.js";

// Spellings that carry userinfo for browsers and Node's URL, whatever a "//" pattern sees.
const SPELLINGS = [
  "https://alice:SECRET_X@api.example.com",
  "HTTPS://alice:SECRET_X@api.example.com",
  "https:/alice:SECRET_X@api.example.com",
  "https:alice:SECRET_X@api.example.com",
  "https:///alice:SECRET_X@api.example.com",
  "https:\\alice:SECRET_X@api.example.com",
  "  https://alice:SECRET_X@api.example.com",
  "https://alice@corp.example:p@SECRET_X@api.example.com",
];

describe("url-userinfo", () => {
  it("reads any run of slashes or backslashes after an http(s) scheme as //", () => {
    expect(normalizeSchemeSlashes("https:/h")).toBe("https://h");
    expect(normalizeSchemeSlashes("http:\\\\h")).toBe("http://h");
    expect(normalizeSchemeSlashes("https://h")).toBe("https://h");
    expect(normalizeSchemeSlashes("{{base}}/v1")).toBe("{{base}}/v1");
  });

  it("shows the text before the query only when it holds no @", () => {
    expect(headWithoutUserinfo("/v1/orders?api_key=SECRET_X")).toBe("/v1/orders");
    expect(headWithoutUserinfo("https://h/a#frag@x")).toBe("https://h/a");
    for (const s of SPELLINGS) expect(headWithoutUserinfo(`${s}/v1`)).toBeUndefined();
  });

  it("strips a server base's userinfo in every spelling, and never moves the host", () => {
    for (const s of SPELLINGS) {
      // The base keeps the caller's own scheme case and spacing; only userinfo goes.
      expect(baseWithoutUserinfo(s)?.trim().toLowerCase()).toBe("https://api.example.com");
    }
    expect(baseWithoutUserinfo("https://h.example.com?x=@good.example.com")).toBe(
      "https://h.example.com?x=@good.example.com",
    );
    expect(baseWithoutUserinfo("https://{{host}}:8443")).toBe("https://{{host}}:8443");
    // Left with an "@" before the query: refused, not guessed at.
    expect(baseWithoutUserinfo("https://https:/alice:SECRET_X@api.example.com")).toBeUndefined();
    expect(baseWithoutUserinfo("https://api.example.com/@me")).toBeUndefined();
  });

  it("rebuilds a URL from its parsed parts, keeping only the query names asked for", () => {
    for (const s of SPELLINGS) {
      expect(
        urlWithoutUserinfo(`${s}/token?p=b2c&client_x=SECRET_Q`, (n) => n !== "client_x"),
      ).toBe("https://api.example.com/token?p=b2c");
    }
    expect(urlWithoutUserinfo("https://api.example.com/token?p=b2c")).toBe(
      "https://api.example.com/token?p=b2c",
    );
    expect(urlWithoutUserinfo("{{auth}}/token?api_key=SECRET_X")).toBe("{{auth}}/token");
    expect(urlWithoutUserinfo(undefined)).toBeUndefined();
    for (const refused of [
      "{{scheme}}:/alice:SECRET_X@{{host}}/token",
      "https://https:/alice:SECRET_X@api.example.com/token",
      "mailto:alice:SECRET_X@api.example.com",
    ]) {
      expect(urlWithoutUserinfo(refused)).toBeUndefined();
    }
  });
});
